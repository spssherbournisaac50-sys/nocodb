import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { DIRECT_CHUNK_SIZE } from '../public/js/shared/chunks.js';
import { codeLookup, generateCode, openKeyWithCode, sealKeyWithCode } from '../public/js/shared/code.js';
import { decryptChunk, decryptJson, encryptChunk, importFileKey } from '../public/js/shared/crypto.js';
import { client, createTransfer, randomData, startServer, uploadAll } from './helpers.js';

let srv;
let api;

before(async () => {
  srv = await startServer({
    limits: { anonymous: { maxBytes: 8 * 1024 * 1024, maxHours: 24, maxDownloads: 10 } },
    rateLimits: { codeFailuresPer10Min: 5 },
  });
  api = client(srv.base);
});

after(() => srv.stop());

// Chunk files are deleted in the background once a transfer ends.
async function assertGone(dir) {
  for (let i = 0; i < 50; i++) {
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`${dir} still exists`);
}

// Simulates the receiver's browser: code -> key -> manifest -> decrypted files.
async function receiveWithCode(code, ip = '10.0.0.1') {
  const claim = await api('POST', '/api/claim', {
    body: { lookup: await codeLookup(code) },
    headers: { 'X-Forwarded-For': ip },
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const rawKey = await openKeyWithCode(code, claim.body);
  return download(claim.body.id, rawKey);
}

async function download(id, rawKey) {
  const key = await importFileKey(rawKey);
  const info = await api('GET', `/api/transfers/${id}`);
  assert.equal(info.status, 200);
  const manifest = await decryptJson(key, info.body.manifest);
  const begin = await api('POST', `/api/transfers/${id}/downloads`);
  assert.equal(begin.status, 201, JSON.stringify(begin.body));
  const token = begin.body.token;
  const files = [];
  for (const entry of manifest.files) {
    const parts = [];
    for (let i = 0; i < entry.chunkCount; i++) {
      const res = await api('GET', `/api/transfers/${id}/chunks/${entry.firstChunk + i}`, {
        headers: { 'X-Download-Token': token },
        raw: true,
      });
      assert.equal(res.status, 200);
      const sealed = new Uint8Array(await res.arrayBuffer());
      parts.push(await decryptChunk(key, entry.firstChunk + i, sealed));
    }
    files.push({ name: entry.name, data: Buffer.concat(parts) });
  }
  const done = await api('POST', `/api/transfers/${id}/downloads/done`, { headers: { 'X-Download-Token': token } });
  assert.equal(done.status, 200);
  return { manifest, files, token };
}

describe('upload transfers', () => {
  test('send and receive files with a six-digit code (one-time)', async () => {
    const files = [
      { name: 'video.mp4', data: randomData(2.5 * 1024 * 1024) },
      { name: 'note.txt', data: new TextEncoder().encode('hello world') },
    ];
    const transfer = await createTransfer(api, { files, text: 'Here you go' });
    assert.equal(transfer.res.status, 201, JSON.stringify(transfer.res.body));
    assert.match(transfer.code, /^\d{6}$/);
    await uploadAll(api, transfer, files);

    const { manifest, files: received } = await receiveWithCode(transfer.code);
    assert.equal(manifest.text, 'Here you go');
    assert.equal(received.length, 2);
    assert.equal(received[0].name, 'video.mp4');
    assert.ok(Buffer.from(files[0].data).equals(received[0].data));
    assert.equal(received[1].data.toString(), 'hello world');

    const id = transfer.res.body.id;
    // One-time: no second download, chunks deleted, transfer reported as completed.
    const again = await api('POST', `/api/transfers/${id}/downloads`);
    assert.equal(again.status, 410);
    const info = await api('GET', `/api/transfers/${id}`);
    assert.equal(info.status, 410);
    assert.equal(info.body.status, 'completed');
    await assertGone(path.join(srv.dataDir, 'chunks', id));

    const status = await api('GET', `/api/transfers/${id}/status`, {
      headers: { Authorization: `Bearer ${transfer.res.body.manageToken}` },
    });
    assert.equal(status.body.status, 'completed');
    assert.equal(status.body.downloads, 1);
  });

  test('the server never sees file names or contents', async () => {
    const secretName = 'tax-return-2026.pdf';
    const files = [{ name: secretName, data: new TextEncoder().encode('very secret contents') }];
    const transfer = await createTransfer(api, { files });
    await uploadAll(api, transfer, files);
    const id = transfer.res.body.id;
    const db = await fs.readFile(path.join(srv.dataDir, 'quickdrop.db'));
    const wal = await fs.readFile(path.join(srv.dataDir, 'quickdrop.db-wal')).catch(() => Buffer.alloc(0));
    const chunk = await fs.readFile(path.join(srv.dataDir, 'chunks', id, '0'));
    for (const blob of [db, wal, chunk]) {
      assert.equal(blob.includes(secretName), false);
      assert.equal(blob.includes('very secret contents'), false);
      assert.equal(blob.includes(transfer.code), false);
    }
  });

  test('receiver can stream chunks while the sender is still uploading', async () => {
    const files = [{ name: 'live.bin', data: randomData(1.5 * 1024 * 1024) }];
    const transfer = await createTransfer(api, { files });
    const { id, manageToken } = transfer.res.body;
    const begin = await api('POST', `/api/transfers/${id}/downloads`);
    const pending = api('GET', `/api/transfers/${id}/chunks/0`, {
      headers: { 'X-Download-Token': begin.body.token },
      raw: true,
    });
    await new Promise((r) => setTimeout(r, 150));
    const sealed = await encryptChunk(transfer.key, 0, files[0].data.subarray(0, transfer.plan.chunkSize));
    const put = await api('PUT', `/api/transfers/${id}/chunks/0`, {
      body: sealed,
      headers: { Authorization: `Bearer ${manageToken}` },
    });
    assert.equal(put.status, 200);
    const res = await pending;
    assert.equal(res.status, 200);
    const plain = await decryptChunk(transfer.key, 0, new Uint8Array(await res.arrayBuffer()));
    assert.ok(Buffer.from(plain).equals(Buffer.from(files[0].data.subarray(0, transfer.plan.chunkSize))));
  });

  test('link (QR) access works without the code and allows several downloads', async () => {
    const files = [{ name: 'a.txt', data: new TextEncoder().encode('abc') }];
    const transfer = await createTransfer(api, { files, maxDownloads: 2 });
    await uploadAll(api, transfer, files);
    const id = transfer.res.body.id;
    const first = await download(id, transfer.rawKey);
    assert.equal(first.files[0].data.toString(), 'abc');
    const info = await api('GET', `/api/transfers/${id}`);
    assert.equal(info.body.downloadsLeft, 1);
    const second = await download(id, transfer.rawKey);
    assert.equal(second.files[0].data.toString(), 'abc');
    assert.equal((await api('GET', `/api/transfers/${id}`)).status, 410);
  });

  test('text-only transfers work', async () => {
    const transfer = await createTransfer(api, { files: [], text: 'https://example.com/meeting' });
    assert.equal(transfer.res.status, 201);
    const { manifest, files } = await receiveWithCode(transfer.code, '10.0.0.9');
    assert.equal(manifest.text, 'https://example.com/meeting');
    assert.equal(files.length, 0);
  });

  test('rejects uploads over the size limit', async () => {
    const res = await api('POST', '/api/transfers', {
      body: { mode: 'upload', manifest: 'AAAA', chunkSize: 1048576, chunkCount: 9, totalSize: 9 * 1048576 },
    });
    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'too_large');
  });

  test('rejects tampered or oversized chunks', async () => {
    const files = [{ name: 'x', data: randomData(100) }];
    const transfer = await createTransfer(api, { files });
    const { id, manageToken } = transfer.res.body;
    const tooBig = await api('PUT', `/api/transfers/${id}/chunks/0`, {
      body: randomData(1048576 + 17),
      headers: { Authorization: `Bearer ${manageToken}` },
    });
    assert.equal(tooBig.status, 400);
    const wrongToken = await api('PUT', `/api/transfers/${id}/chunks/0`, {
      body: randomData(116),
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(wrongToken.status, 403);
  });

  test('state-changing requests need the CSRF header', async () => {
    const res = await fetch(`${srv.base}/api/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  });

  test('the sender can revoke a transfer', async () => {
    const files = [{ name: 'x', data: randomData(10) }];
    const transfer = await createTransfer(api, { files });
    await uploadAll(api, transfer, files);
    const { id, manageToken } = transfer.res.body;
    const del = await api('DELETE', `/api/transfers/${id}`, { headers: { Authorization: `Bearer ${manageToken}` } });
    assert.equal(del.status, 200);
    const info = await api('GET', `/api/transfers/${id}`);
    assert.equal(info.status, 410);
    assert.equal(info.body.status, 'revoked');
    const claim = await api('POST', '/api/claim', {
      body: { lookup: await codeLookup(transfer.code) },
      headers: { 'X-Forwarded-For': '10.0.0.2' },
    });
    assert.equal(claim.status, 404);
  });

  test('expired transfers are swept and their chunks deleted', async () => {
    const files = [{ name: 'x', data: randomData(10) }];
    const transfer = await createTransfer(api, { files, ttlHours: 1 });
    await uploadAll(api, transfer, files);
    const { id } = transfer.res.body;
    srv.app.db.prepare('UPDATE transfers SET expires_at = ?, code_expires_at = ? WHERE id = ?').run(1, 1, id);
    srv.app.service.sweep();
    const info = await api('GET', `/api/transfers/${id}`);
    assert.equal(info.body.status, 'expired');
    await assertGone(path.join(srv.dataDir, 'chunks', id));
  });
});

describe('six-digit codes', () => {
  test('codes are single-use for one-time transfers', async () => {
    const transfer = await createTransfer(api, { files: [{ name: 'x', data: randomData(10) }] });
    const lookup = await codeLookup(transfer.code);
    const first = await api('POST', '/api/claim', { body: { lookup }, headers: { 'X-Forwarded-For': '10.0.1.1' } });
    assert.equal(first.status, 200);
    const second = await api('POST', '/api/claim', { body: { lookup }, headers: { 'X-Forwarded-For': '10.0.1.1' } });
    assert.equal(second.status, 404);
  });

  test('guessing is rate limited per IP', async () => {
    const transfer = await createTransfer(api, { files: [{ name: 'x', data: randomData(10) }] });
    const attacker = { 'X-Forwarded-For': '10.6.6.6' };
    let wrong = 0;
    for (let n = 0; wrong < 5; n++) {
      const guess = String(n).padStart(6, '0');
      if (guess === transfer.code) continue;
      const res = await api('POST', '/api/claim', { body: { lookup: await codeLookup(guess) }, headers: attacker });
      if (res.status === 404) wrong++;
    }
    const blocked = await api('POST', '/api/claim', {
      body: { lookup: await codeLookup(transfer.code) },
      headers: attacker,
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // Other people are unaffected.
    const legit = await api('POST', '/api/claim', {
      body: { lookup: await codeLookup(transfer.code) },
      headers: { 'X-Forwarded-For': '10.0.2.2' },
    });
    assert.equal(legit.status, 200);
  });

  test('the sender can issue a new code, which replaces the old one', async () => {
    const transfer = await createTransfer(api, { files: [{ name: 'x', data: randomData(10) }] });
    const { id, manageToken } = transfer.res.body;
    let newCode;
    do newCode = generateCode();
    while (newCode === transfer.code);
    const sealed = await sealKeyWithCode(newCode, transfer.rawKey, 10_000);
    const res = await api('POST', `/api/transfers/${id}/code`, {
      body: { code: sealed },
      headers: { Authorization: `Bearer ${manageToken}` },
    });
    assert.equal(res.status, 200);
    const old = await api('POST', '/api/claim', {
      body: { lookup: await codeLookup(transfer.code) },
      headers: { 'X-Forwarded-For': '10.0.3.3' },
    });
    assert.equal(old.status, 404);
    const fresh = await api('POST', '/api/claim', {
      body: { lookup: await codeLookup(newCode) },
      headers: { 'X-Forwarded-For': '10.0.3.3' },
    });
    assert.equal(fresh.status, 200);
    assert.deepEqual(await openKeyWithCode(newCode, fresh.body), transfer.rawKey);
  });

  test('two active transfers cannot share a code', async () => {
    const transfer = await createTransfer(api, { files: [{ name: 'x', data: randomData(10) }] });
    const clash = await api('POST', '/api/transfers', {
      body: {
        mode: 'upload',
        manifest: 'AAAA',
        chunkSize: 1048576,
        chunkCount: 0,
        totalSize: 0,
        code: await sealKeyWithCode(transfer.code, transfer.rawKey, 10_000),
      },
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, 'code_taken');
  });
});

describe('accounts (optional)', () => {
  test('sign up, see your transfers, revoke, sign out', async () => {
    const signup = await api('POST', '/api/auth/signup', {
      body: { email: 'Someone@Example.com', password: 'correct horse battery' },
    });
    assert.equal(signup.status, 201);
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^qd_session=/);
    const authed = client(srv.base, { Cookie: cookie });

    const me = await authed('GET', '/api/auth/me');
    assert.equal(me.body.user.email, 'someone@example.com');

    const config = await authed('GET', '/api/config');
    assert.equal(config.body.limits.maxHours, 168);

    const transfer = await createTransfer(authed, { files: [{ name: 'x', data: randomData(10) }], ttlHours: 100 });
    assert.equal(transfer.res.status, 201);
    assert.ok(transfer.res.body.expiresAt - Date.now() > 99 * 3600_000);

    const list = await authed('GET', '/api/me/transfers');
    assert.equal(list.body.transfers.length, 1);
    assert.equal(list.body.transfers[0].id, transfer.res.body.id);

    // Owners can revoke with just their session.
    const del = await authed('DELETE', `/api/transfers/${transfer.res.body.id}`);
    assert.equal(del.status, 200);

    const dup = await api('POST', '/api/auth/signup', { body: { email: 'someone@example.com', password: 'whatever123' } });
    assert.equal(dup.status, 409);

    const badLogin = await api('POST', '/api/auth/login', { body: { email: 'someone@example.com', password: 'nope-nope' } });
    assert.equal(badLogin.status, 401);
    const login = await api('POST', '/api/auth/login', {
      body: { email: 'someone@example.com', password: 'correct horse battery' },
    });
    assert.equal(login.status, 200);

    await authed('POST', '/api/auth/logout');
    const after = await authed('GET', '/api/auth/me');
    assert.equal(after.body.user, null);
  });

  test('anonymous users get anonymous limits', async () => {
    const res = await api('GET', '/api/config');
    assert.equal(res.body.user, null);
    assert.equal(res.body.limits.maxHours, 24);
    const transfer = await createTransfer(api, { files: [{ name: 'x', data: randomData(10) }], ttlHours: 100 });
    assert.ok(transfer.res.body.expiresAt - Date.now() <= 24 * 3600_000 + 1000);
  });
});

describe('live transfers', () => {
  function socket() {
    const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/ws`);
    const queue = [];
    const waiters = [];
    ws.on('message', (data, isBinary) => {
      const msg = isBinary ? { binary: Buffer.from(data) } : JSON.parse(data.toString());
      const idx = waiters.findIndex((w) => w.match(msg));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    ws.next = (match) => {
      const idx = queue.findIndex(match);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    };
    ws.sendJson = (obj) => ws.send(JSON.stringify(obj));
    return new Promise((resolve) => ws.on('open', () => resolve(ws)));
  }

  test('pairs sender and receiver, forwards signals and relays encrypted frames', async () => {
    const files = [{ name: 'clip.mov', data: randomData(DIRECT_CHUNK_SIZE + 10) }];
    const transfer = await createTransfer(api, { files, mode: 'direct' });
    const { id, manageToken } = transfer.res.body;

    const host = await socket();
    host.sendJson({ t: 'host', id, token: manageToken });
    assert.equal((await host.next((m) => m.t === 'hosted')).mode, 'direct');
    assert.equal((await api('GET', `/api/transfers/${id}`)).body.hostOnline, true);

    const peer = await socket();
    peer.sendJson({ t: 'join', id });
    const joined = await peer.next((m) => m.t === 'joined');
    assert.ok(Array.isArray(joined.iceServers));
    await host.next((m) => m.t === 'peer-joined');

    // A second receiver is turned away while the first is connected.
    const intruder = await socket();
    intruder.sendJson({ t: 'join', id });
    assert.equal((await intruder.next((m) => m.t === 'error')).code, 'busy');
    intruder.close();

    host.sendJson({ t: 'signal', data: { sdp: { type: 'offer', sdp: 'x' } } });
    assert.equal((await peer.next((m) => m.t === 'signal')).data.sdp.type, 'offer');

    peer.sendJson({ t: 'relay', data: '{"t":"start","from":0}' });
    assert.equal((await host.next((m) => m.t === 'relay')).data, '{"t":"start","from":0}');

    const frame = await encryptChunk(transfer.key, 0, files[0].data.subarray(0, DIRECT_CHUNK_SIZE));
    host.send(frame);
    const relayed = await peer.next((m) => m.binary);
    const plain = await decryptChunk(transfer.key, 0, new Uint8Array(relayed.binary));
    assert.equal(plain.length, DIRECT_CHUNK_SIZE);

    peer.sendJson({ t: 'complete' });
    const done = await host.next((m) => m.t === 'peer-complete');
    assert.equal(done.downloads, 1);
    const ended = await host.next((m) => m.t === 'event' && m.kind === 'ended');
    assert.equal(ended.status, 'completed');
    host.close();
    peer.close();
  });

  test('receivers are told when the sender is offline', async () => {
    const transfer = await createTransfer(api, { files: [{ name: 'x', data: randomData(10) }], mode: 'direct' });
    const peer = await socket();
    peer.sendJson({ t: 'join', id: transfer.res.body.id });
    assert.equal((await peer.next((m) => m.t === 'error')).code, 'host_offline');
    peer.close();
  });

  test('upload senders get live events', async () => {
    const files = [{ name: 'x', data: randomData(10) }];
    const transfer = await createTransfer(api, { files });
    const { id, manageToken } = transfer.res.body;
    const watcher = await socket();
    watcher.sendJson({ t: 'host', id, token: manageToken });
    await watcher.next((m) => m.t === 'hosted');
    await uploadAll(api, transfer, files);
    await watcher.next((m) => m.kind === 'upload-complete');
    await receiveWithCode(transfer.code, '10.0.4.4');
    const used = await watcher.next((m) => m.kind === 'code-used');
    assert.equal(used.device, 'Unknown device');
    await watcher.next((m) => m.kind === 'download-started');
    await watcher.next((m) => m.kind === 'download-complete');
    assert.equal((await watcher.next((m) => m.kind === 'ended')).status, 'completed');
    watcher.close();
  });
});

describe('web app', () => {
  test('serves the app shell with strict security headers', async () => {
    const res = await fetch(`${srv.base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /QuickDrop/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    for (const route of ['/receive', '/account', '/r/AAAAAAAAAAAAAAAAAAAAAA']) {
      assert.equal((await fetch(srv.base + route)).status, 200, route);
    }
  });

  test('serves vendor libraries and blocks path traversal', async () => {
    assert.equal((await fetch(`${srv.base}/vendor/qrcode.mjs`)).status, 200);
    assert.equal((await fetch(`${srv.base}/vendor/jsQR.js`)).status, 200);
    assert.equal((await fetch(`${srv.base}/js/shared/crypto.js`)).status, 200);
    assert.equal((await fetch(`${srv.base}/..%2fserver%2fapp.js`)).status, 404);
    assert.equal((await fetch(`${srv.base}/%2e%2e/package.json`)).status, 404);
  });
});

describe('free-hosting profile (no stored uploads, no accounts)', () => {
  let free;
  let freeApi;

  before(async () => {
    free = await startServer({
      accountsEnabled: false,
      limits: {
        anonymous: { maxBytes: 0, maxHours: 24, maxDownloads: 10 },
        account: { maxBytes: 0, maxHours: 24, maxDownloads: 10 },
      },
    });
    freeApi = client(free.base);
  });

  after(() => free.stop());

  test('advertises what the server offers', async () => {
    const res = await freeApi('GET', '/api/config');
    assert.equal(res.body.accountsEnabled, false);
    assert.equal(res.body.signupEnabled, false);
    assert.equal(res.body.limits.maxBytes, 0);
  });

  test('accounts are unavailable', async () => {
    const signup = await freeApi('POST', '/api/auth/signup', { body: { email: 'a@b.co', password: 'password123' } });
    assert.equal(signup.status, 404);
    const login = await freeApi('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'password123' } });
    assert.equal(login.status, 404);
  });

  test('files must go Live, text messages still work', async () => {
    const files = [{ name: 'x', data: randomData(10) }];
    const upload = await createTransfer(freeApi, { files });
    assert.equal(upload.res.status, 413);
    const live = await createTransfer(freeApi, { files, mode: 'direct' });
    assert.equal(live.res.status, 201);
    const text = await createTransfer(freeApi, { files: [], text: 'hello' });
    assert.equal(text.res.status, 201);
  });
});

describe('sender reconnects', () => {
  test('a sender whose transfer no longer exists is told so', async () => {
    const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    const reply = new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
    ws.send(JSON.stringify({ t: 'host', id: 'AAAAAAAAAAAAAAAAAAAAAA', token: 'whatever' }));
    assert.deepEqual(await reply, { t: 'error', code: 'forbidden' });
    ws.close();
  });
});
