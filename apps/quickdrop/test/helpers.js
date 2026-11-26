import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { DIRECT_CHUNK_SIZE, UPLOAD_CHUNK_SIZE, planChunks } from '../public/js/shared/chunks.js';
import { generateCode, sealKeyWithCode } from '../public/js/shared/code.js';
import { encryptChunk, encryptJson, generateFileKey, importFileKey } from '../public/js/shared/crypto.js';

export async function startServer(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickdrop-test-'));
  const config = loadConfig(
    {
      dataDir,
      port: 0,
      host: '127.0.0.1',
      trustProxy: true,
      sweepIntervalMs: 3600_000,
      ...overrides,
    },
    {},
  );
  const app = await createApp(config);
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    app,
    base,
    config,
    dataDir,
    async stop() {
      await app.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function client(base, defaults = {}) {
  return async function api(method, route, { body, headers = {}, raw = false } = {}) {
    const h = { 'X-QuickDrop': '1', ...defaults, ...headers };
    let payload;
    if (body instanceof Uint8Array) payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    const res = await fetch(base + route, { method, headers: h, body: payload });
    if (raw) return res;
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
}

export function randomData(size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(size, i + 65536)));
  return out;
}

// Simulates the sender's browser: encrypts the manifest and creates a transfer.
export async function createTransfer(api, { files, mode = 'upload', maxDownloads = 1, text = '', ttlHours } = {}) {
  const chunkSize = mode === 'upload' ? UPLOAD_CHUNK_SIZE : DIRECT_CHUNK_SIZE;
  const plan = planChunks(
    files.map((f) => ({ name: f.name, size: f.data.length, type: 'application/octet-stream', lastModified: 0 })),
    chunkSize,
  );
  const rawKey = generateFileKey();
  const key = await importFileKey(rawKey);
  const manifest = await encryptJson(key, { v: 1, ...plan, text });
  const code = generateCode();
  const sealed = await sealKeyWithCode(code, rawKey, 10_000);
  const res = await api('POST', '/api/transfers', {
    body: {
      mode,
      manifest,
      chunkSize,
      chunkCount: plan.chunkCount,
      totalSize: plan.totalSize,
      maxDownloads,
      ttlHours,
      code: sealed,
    },
  });
  return { res, code, rawKey, key, plan };
}

export async function uploadAll(api, transfer, files) {
  const { res, key, plan } = transfer;
  for (const [fileIndex, entry] of plan.files.entries()) {
    for (let i = 0; i < entry.chunkCount; i++) {
      const start = i * plan.chunkSize;
      const slice = files[fileIndex].data.subarray(start, start + plan.chunkSize);
      const sealed = await encryptChunk(key, entry.firstChunk + i, slice);
      const put = await api('PUT', `/api/transfers/${res.body.id}/chunks/${entry.firstChunk + i}`, {
        body: sealed,
        headers: { Authorization: `Bearer ${res.body.manageToken}` },
      });
      if (put.status !== 200) throw new Error(`upload failed: ${put.status} ${JSON.stringify(put.body)}`);
    }
  }
}
