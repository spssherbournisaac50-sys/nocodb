import { EventEmitter } from 'node:events';
import { HttpError, hashToken, randomToken, safeEqualHex } from './http.js';

const B64URL = /^[A-Za-z0-9_-]+$/;
// Must match public/js/shared/chunks.js
const ALLOWED_CHUNK_SIZES = new Set([60 * 1024, 1024 * 1024]);
const TAG_BYTES = 16;
const MAX_MANIFEST_CHARS = 512 * 1024;
const MAX_FILES = 1000;
const DOWNLOAD_IDLE_MS = 30 * 60_000;
const ROW_RETENTION_MS = 7 * 86400_000;
const CHUNK_WAIT_MS = 20_000;
const PROGRESS_THROTTLE_MS = 300;

function int(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : NaN;
}

export class TransferService {
  constructor({ db, store, config }) {
    this.db = db;
    this.store = store;
    this.config = config;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.downloads = new Map(); // token -> { id, lastSeen, done, device, maxChunk, lastProgress }
    this.inflight = new Set();
    this.hub = null;
    this.startedAt = Date.now();

    const codeFields = 'code_lookup = NULL, code_salt = NULL, code_wrapped = NULL, code_iterations = NULL, code_expires_at = NULL';
    this.q = {
      insert: db.prepare(`INSERT INTO transfers
        (id, mode, owner_id, manage_hash, manifest, chunk_size, chunk_count, total_size, max_downloads,
         code_lookup, code_salt, code_wrapped, code_iterations, code_expires_at, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      get: db.prepare('SELECT * FROM transfers WHERE id = ?'),
      byCode: db.prepare(
        "SELECT * FROM transfers WHERE code_lookup = ? AND status = 'active' AND code_expires_at > ?",
      ),
      clearExpiredCodes: db.prepare(
        `UPDATE transfers SET ${codeFields} WHERE code_lookup IS NOT NULL AND code_expires_at <= ? RETURNING id`,
      ),
      setCode: db.prepare(`UPDATE transfers SET code_lookup = ?, code_salt = ?, code_wrapped = ?,
        code_iterations = ?, code_expires_at = ?, code_claims = 0 WHERE id = ?`),
      clearCode: db.prepare(`UPDATE transfers SET ${codeFields} WHERE id = ?`),
      addClaim: db.prepare('UPDATE transfers SET code_claims = code_claims + 1 WHERE id = ?'),
      chunkStored: db.prepare(
        'UPDATE transfers SET uploaded_chunks = uploaded_chunks + 1, stored_bytes = stored_bytes + ? WHERE id = ?',
      ),
      addDownload: db.prepare(
        "UPDATE transfers SET downloads = downloads + 1 WHERE id = ? AND status = 'active' AND downloads < max_downloads",
      ),
      end: db.prepare(`UPDATE transfers SET status = ?, ended_at = ?, manifest = '', ${codeFields}
        WHERE id = ? AND status = 'active'`),
      reserved: db.prepare(
        "SELECT COALESCE(SUM(total_size), 0) AS total FROM transfers WHERE status = 'active' AND mode = 'upload'",
      ),
      expired: db.prepare("SELECT id, expires_at FROM transfers WHERE status = 'active' AND expires_at <= ?"),
      exhausted: db.prepare(
        "SELECT id FROM transfers WHERE status = 'active' AND mode = 'upload' AND downloads >= max_downloads",
      ),
      activeDirect: db.prepare("SELECT id, created_at FROM transfers WHERE status = 'active' AND mode = 'direct'"),
      activeIds: db.prepare("SELECT id FROM transfers WHERE status = 'active'"),
      purge: db.prepare("DELETE FROM transfers WHERE status != 'active' AND ended_at <= ?"),
      byOwner: db.prepare(`SELECT id, mode, status, total_size, chunk_count, downloads, max_downloads,
        created_at, expires_at, ended_at, code_expires_at, code_lookup IS NOT NULL AS code_active
        FROM transfers WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100`),
    };
  }

  limitsFor(user) {
    return user ? this.config.limits.account : this.config.limits.anonymous;
  }

  notify(id, event) {
    this.hub?.notify(id, event);
  }

  #mustGet(id) {
    const row = this.q.get.get(id);
    if (!row) throw new HttpError(404, 'not_found', 'This transfer does not exist');
    return row;
  }

  #mustBeActive(row) {
    if (row.status !== 'active') {
      throw new HttpError(410, 'ended', 'This transfer is no longer available', { status: row.status });
    }
  }

  #authorize(row, token, user) {
    if (user && row.owner_id && row.owner_id === user.id) return;
    if (token && safeEqualHex(hashToken(token), row.manage_hash)) return;
    throw new HttpError(403, 'forbidden', 'You cannot manage this transfer');
  }

  #validateCode(code, required) {
    if (code == null) {
      if (required) throw new HttpError(400, 'invalid_code', 'A code is required');
      return null;
    }
    const { lookup, salt, wrapped, iterations } = code;
    const ok =
      typeof lookup === 'string' && lookup.length === 43 && B64URL.test(lookup) &&
      typeof salt === 'string' && salt.length === 22 && B64URL.test(salt) &&
      typeof wrapped === 'string' && wrapped.length === 80 && B64URL.test(wrapped) &&
      Number.isSafeInteger(iterations) && iterations >= 10_000 && iterations <= 2_000_000;
    if (!ok) throw new HttpError(400, 'invalid_code', 'Malformed code data');
    return { lookup, salt, wrapped, iterations };
  }

  #clearExpiredCodes(now) {
    for (const { id } of this.q.clearExpiredCodes.all(now)) {
      this.notify(id, { kind: 'code-expired' });
    }
  }

  #publicView(row) {
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      manifest: row.manifest,
      chunkSize: row.chunk_size,
      chunkCount: row.chunk_count,
      totalSize: row.total_size,
      uploadedChunks: row.uploaded_chunks,
      uploadComplete: row.uploaded_chunks >= row.chunk_count,
      expiresAt: row.expires_at,
      maxDownloads: row.max_downloads,
      downloadsLeft: Math.max(0, row.max_downloads - row.downloads),
      hostOnline: row.mode === 'direct' ? Boolean(this.hub?.hostOnline(row.id)) : undefined,
    };
  }

  create(body, user) {
    const mode = body.mode === 'direct' || body.mode === 'upload' ? body.mode : null;
    if (!mode) throw new HttpError(400, 'invalid_mode', 'mode must be "upload" or "direct"');

    const manifest = body.manifest;
    if (typeof manifest !== 'string' || !manifest || manifest.length > MAX_MANIFEST_CHARS || !B64URL.test(manifest)) {
      throw new HttpError(400, 'invalid_manifest', 'Malformed manifest');
    }
    const chunkSize = int(body.chunkSize);
    const totalSize = int(body.totalSize);
    const chunkCount = int(body.chunkCount);
    if (!ALLOWED_CHUNK_SIZES.has(chunkSize)) throw new HttpError(400, 'invalid_chunk_size', 'Unsupported chunk size');
    if (!(totalSize >= 0) || !(chunkCount >= 0)) throw new HttpError(400, 'invalid_size', 'Invalid size');
    const minChunks = Math.ceil(totalSize / chunkSize);
    if (chunkCount < minChunks || chunkCount > minChunks + MAX_FILES) {
      throw new HttpError(400, 'invalid_chunks', 'Chunk count does not match the size');
    }

    const limits = this.limitsFor(user);
    if (mode === 'upload' && totalSize > limits.maxBytes) {
      throw new HttpError(413, 'too_large', 'These files are larger than the upload limit', {
        maxBytes: limits.maxBytes,
      });
    }
    const requestedHours = Number(body.ttlHours);
    const hours = Number.isFinite(requestedHours) && requestedHours > 0
      ? Math.min(Math.max(requestedHours, 0.25), limits.maxHours)
      : Math.min(24, limits.maxHours);
    const requestedDownloads = int(body.maxDownloads);
    const maxDownloads = requestedDownloads >= 1 ? Math.min(requestedDownloads, limits.maxDownloads) : 1;

    if (mode === 'upload') {
      const reserved = Number(this.q.reserved.get().total);
      if (reserved + totalSize > this.config.storageQuotaBytes) {
        throw new HttpError(507, 'storage_full', 'The server is out of space right now. Try a Live transfer instead.');
      }
    }

    const code = this.#validateCode(body.code, false);
    const now = Date.now();
    const expiresAt = now + Math.round(hours * 3600_000);
    const codeExpiresAt = code ? Math.min(now + this.config.codeTtlMinutes * 60_000, expiresAt) : null;
    this.#clearExpiredCodes(now);

    const id = randomToken(16);
    const manageToken = randomToken(32);
    try {
      this.q.insert.run(
        id, mode, user?.id ?? null, hashToken(manageToken), manifest, chunkSize, chunkCount, totalSize,
        maxDownloads, code?.lookup ?? null, code?.salt ?? null, code?.wrapped ?? null, code?.iterations ?? null,
        codeExpiresAt, now, expiresAt,
      );
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw new HttpError(409, 'code_taken', 'That code is in use, pick another');
      }
      throw err;
    }
    return { id, manageToken, mode, expiresAt, codeExpiresAt, maxDownloads };
  }

  info(id) {
    const row = this.#mustGet(id);
    this.#mustBeActive(row);
    return this.#publicView(row);
  }

  status(id, token, user) {
    const row = this.#mustGet(id);
    this.#authorize(row, token, user);
    const now = Date.now();
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      downloads: row.downloads,
      maxDownloads: row.max_downloads,
      uploadedChunks: row.uploaded_chunks,
      chunkCount: row.chunk_count,
      totalSize: row.total_size,
      expiresAt: row.expires_at,
      codeActive: Boolean(row.code_lookup) && row.code_expires_at > now,
      codeExpiresAt: row.code_expires_at,
      hostOnline: row.mode === 'direct' ? Boolean(this.hub?.hostOnline(row.id)) : undefined,
    };
  }

  verifyManage(id, token) {
    const row = typeof id === 'string' ? this.q.get.get(id) : null;
    if (!row || !token || !safeEqualHex(hashToken(token), row.manage_hash)) return null;
    return row;
  }

  async putChunk(id, index, token, user, data) {
    const row = this.#mustGet(id);
    this.#authorize(row, token, user);
    this.#mustBeActive(row);
    if (row.mode !== 'upload') throw new HttpError(400, 'wrong_mode', 'Live transfers do not store chunks');
    if (index >= row.chunk_count) throw new HttpError(400, 'invalid_index', 'Chunk index out of range');
    if (data.length <= TAG_BYTES || data.length > row.chunk_size + TAG_BYTES) {
      throw new HttpError(400, 'invalid_chunk', 'Chunk has an invalid size');
    }
    const key = `${id}:${index}`;
    if (this.inflight.has(key)) throw new HttpError(409, 'chunk_busy', 'This chunk is already being uploaded');
    this.inflight.add(key);
    let isNew;
    try {
      const exists = await this.store.has(id, index);
      if (!exists && row.stored_bytes + data.length > row.total_size + row.chunk_count * TAG_BYTES) {
        throw new HttpError(400, 'over_budget', 'More data than declared');
      }
      isNew = await this.store.write(id, index, data);
      if (isNew) this.q.chunkStored.run(data.length, id);
    } finally {
      this.inflight.delete(key);
    }

    const updated = this.q.get.get(id);
    if (!updated || updated.status !== 'active') {
      // Revoked or expired while we were writing.
      await this.store.remove(id);
      throw new HttpError(410, 'ended', 'This transfer is no longer available');
    }
    this.events.emit(`chunk:${id}:${index}`);
    if (isNew && updated.uploaded_chunks === updated.chunk_count) {
      this.notify(id, { kind: 'upload-complete' });
    }
    return { uploadedChunks: updated.uploaded_chunks, chunkCount: updated.chunk_count };
  }

  beginDownload(id, device) {
    const row = this.#mustGet(id);
    this.#mustBeActive(row);
    if (row.mode !== 'upload') throw new HttpError(400, 'wrong_mode', 'Connect to the sender for live transfers');
    const result = this.q.addDownload.run(id);
    if (result.changes === 0) {
      throw new HttpError(410, 'no_downloads_left', 'This transfer has already been downloaded');
    }
    const token = randomToken(24);
    this.downloads.set(token, { id, lastSeen: Date.now(), done: false, device, maxChunk: -1, lastProgress: 0 });
    this.notify(id, {
      kind: 'download-started',
      device,
      downloads: row.downloads + 1,
      maxDownloads: row.max_downloads,
    });
    return { token };
  }

  #session(id, token) {
    const session = token ? this.downloads.get(token) : null;
    if (!session || session.id !== id) {
      throw new HttpError(403, 'invalid_download', 'Download session expired, open the link again');
    }
    return session;
  }

  #waitForChunk(id, index, signal) {
    return new Promise((resolve) => {
      const chunkEvent = `chunk:${id}:${index}`;
      const endEvent = `ended:${id}`;
      const finish = () => {
        clearTimeout(timer);
        this.events.off(chunkEvent, finish);
        this.events.off(endEvent, finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, CHUNK_WAIT_MS);
      this.events.on(chunkEvent, finish);
      this.events.on(endEvent, finish);
      signal?.addEventListener('abort', finish);
    });
  }

  // Returns the encrypted chunk, or null if it has not been uploaded yet
  // (the client then simply asks again; this is how streaming works).
  async getChunk(id, index, token, signal) {
    const session = this.#session(id, token);
    let row = this.#mustGet(id);
    this.#mustBeActive(row);
    if (index >= row.chunk_count) throw new HttpError(400, 'invalid_index', 'Chunk index out of range');
    session.lastSeen = Date.now();

    let data = await this.store.read(id, index);
    if (!data) {
      await this.#waitForChunk(id, index, signal);
      row = this.#mustGet(id);
      this.#mustBeActive(row);
      data = await this.store.read(id, index);
      if (!data) return null;
    }
    session.lastSeen = Date.now();
    if (index > session.maxChunk) {
      session.maxChunk = index;
      const now = Date.now();
      if (now - session.lastProgress > PROGRESS_THROTTLE_MS || index === row.chunk_count - 1) {
        session.lastProgress = now;
        this.notify(id, {
          kind: 'download-progress',
          device: session.device,
          chunks: index + 1,
          chunkCount: row.chunk_count,
        });
      }
    }
    return data;
  }

  finishDownload(id, token) {
    const session = this.#session(id, token);
    if (!session.done) {
      session.done = true;
      this.notify(id, { kind: 'download-complete', device: session.device });
    }
    this.#maybeComplete(id);
    return { ok: true };
  }

  #maybeComplete(id) {
    const row = this.q.get.get(id);
    if (!row || row.status !== 'active' || row.mode !== 'upload' || row.downloads < row.max_downloads) return;
    const now = Date.now();
    for (const session of this.downloads.values()) {
      if (session.id === id && !session.done && now - session.lastSeen < DOWNLOAD_IDLE_MS) return;
    }
    this.end(id, 'completed');
  }

  // Returns null when the code does not match an active transfer.
  claim(lookup, device) {
    if (typeof lookup !== 'string' || lookup.length !== 43 || !B64URL.test(lookup)) return null;
    const now = Date.now();
    const row = this.q.byCode.get(lookup, now);
    if (!row) return null;
    if (row.downloads >= row.max_downloads) {
      throw new HttpError(410, 'no_downloads_left', 'This transfer has already been downloaded');
    }
    this.q.addClaim.run(row.id);
    const usedUp = row.code_claims + 1 >= row.max_downloads;
    if (usedUp) this.q.clearCode.run(row.id);
    this.notify(row.id, { kind: 'code-used', device, codeActive: !usedUp });
    return {
      id: row.id,
      mode: row.mode,
      salt: row.code_salt,
      wrapped: row.code_wrapped,
      iterations: row.code_iterations,
    };
  }

  newCode(id, token, user, code) {
    const row = this.#mustGet(id);
    this.#authorize(row, token, user);
    this.#mustBeActive(row);
    const valid = this.#validateCode(code, true);
    const now = Date.now();
    this.#clearExpiredCodes(now);
    const codeExpiresAt = Math.min(now + this.config.codeTtlMinutes * 60_000, row.expires_at);
    try {
      this.q.setCode.run(valid.lookup, valid.salt, valid.wrapped, valid.iterations, codeExpiresAt, id);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw new HttpError(409, 'code_taken', 'That code is in use, pick another');
      }
      throw err;
    }
    return { codeExpiresAt };
  }

  revoke(id, token, user) {
    const row = this.#mustGet(id);
    this.#authorize(row, token, user);
    if (row.status === 'active') this.end(id, 'revoked');
    return { ok: true };
  }

  canJoinDirect(id) {
    const row = typeof id === 'string' ? this.q.get.get(id) : null;
    if (!row) return 'not_found';
    if (row.status !== 'active') return 'ended';
    if (row.mode !== 'direct') return 'wrong_mode';
    if (row.downloads >= row.max_downloads) return 'no_downloads_left';
    return null;
  }

  recordDirectDownload(id) {
    const changed = this.q.addDownload.run(id).changes > 0;
    const row = this.q.get.get(id);
    if (!row) return null;
    return {
      counted: changed,
      downloads: row.downloads,
      maxDownloads: row.max_downloads,
      exhausted: row.downloads >= row.max_downloads,
    };
  }

  end(id, status) {
    const result = this.q.end.run(status, Date.now(), id);
    if (result.changes === 0) return false;
    for (const [token, session] of this.downloads) {
      if (session.id === id) this.downloads.delete(token);
    }
    this.events.emit(`ended:${id}`);
    this.hub?.transferEnded(id, status);
    this.store.remove(id).catch((err) => console.error('[quickdrop] failed to remove chunks', id, err));
    return true;
  }

  listForOwner(userId) {
    return this.q.byOwner.all(userId).map((r) => ({
      id: r.id,
      mode: r.mode,
      status: r.status,
      totalSize: r.total_size,
      downloads: r.downloads,
      maxDownloads: r.max_downloads,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      endedAt: r.ended_at,
      codeActive: Boolean(r.code_active) && r.code_expires_at > Date.now(),
    }));
  }

  async removeOrphans() {
    const active = new Set(this.q.activeIds.all().map((r) => r.id));
    for (const id of await this.store.listIds()) {
      if (!active.has(id)) await this.store.remove(id);
    }
  }

  sweep() {
    const now = Date.now();
    this.#clearExpiredCodes(now);

    for (const { id, expires_at: expiresAt } of this.q.expired.all(now)) {
      let busy = false;
      for (const s of this.downloads.values()) {
        if (s.id === id && !s.done && now - s.lastSeen < 120_000) busy = true;
      }
      // Let an in-progress download finish (up to an hour past expiry).
      if (busy && now < expiresAt + 3600_000) continue;
      this.end(id, 'expired');
    }

    for (const { id } of this.q.exhausted.all()) this.#maybeComplete(id);

    const grace = this.config.hostGraceSeconds * 1000;
    for (const { id, created_at: createdAt } of this.q.activeDirect.all()) {
      if (this.hub?.hostOnline(id)) continue;
      // After a server restart, give senders the grace period to reconnect.
      const since = this.hub?.hostGoneSince(id) ?? Math.max(createdAt, this.startedAt);
      if (now - since > grace) this.end(id, 'expired');
    }

    for (const [token, session] of this.downloads) {
      if (now - session.lastSeen > DOWNLOAD_IDLE_MS) this.downloads.delete(token);
    }
    this.q.purge.run(now - ROW_RETENTION_MS);
  }
}
