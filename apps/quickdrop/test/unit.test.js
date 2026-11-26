import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { describeDevice } from '../server/http.js';
import { DIRECT_CHUNK_SIZE, locateChunk, planChunks } from '../public/js/shared/chunks.js';
import {
  codeLookup,
  formatCode,
  generateCode,
  normalizeCode,
  openKeyWithCode,
  sealKeyWithCode,
} from '../public/js/shared/code.js';
import {
  decryptChunk,
  decryptJson,
  encryptChunk,
  encryptJson,
  fromB64url,
  generateFileKey,
  importFileKey,
  randomBytes,
  toB64url,
} from '../public/js/shared/crypto.js';
import { buildZip, crc32, safeName } from '../public/js/shared/zip.js';

describe('crypto', () => {
  test('base64url round-trips arbitrary bytes', () => {
    for (const size of [0, 1, 2, 3, 31, 32, 33, 100000]) {
      const bytes = randomBytes(size);
      assert.deepEqual(fromB64url(toB64url(bytes)), bytes);
    }
    assert.throws(() => fromB64url('not valid!'));
  });

  test('chunks decrypt only with the right key and index', async () => {
    const raw = generateFileKey();
    const key = await importFileKey(raw);
    const data = randomBytes(1000);
    const sealed = await encryptChunk(key, 7, data);
    assert.equal(sealed.length, 1016);
    assert.deepEqual(await decryptChunk(key, 7, sealed), data);
    await assert.rejects(decryptChunk(key, 8, sealed), 'swapped chunk must fail');
    const otherKey = await importFileKey(generateFileKey());
    await assert.rejects(decryptChunk(otherKey, 7, sealed), 'wrong key must fail');
    sealed[3] ^= 1;
    await assert.rejects(decryptChunk(key, 7, sealed), 'tampered chunk must fail');
  });

  test('manifest encryption round-trips', async () => {
    const key = await importFileKey(generateFileKey());
    const manifest = { files: [{ name: 'ünïcødé 🎉.txt', size: 3 }], text: 'hi' };
    assert.deepEqual(await decryptJson(key, await encryptJson(key, manifest)), manifest);
  });
});

describe('six-digit codes', () => {
  test('are six digits, uniformly generated', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      assert.match(code, /^\d{6}$/);
      seen.add(code);
    }
    assert.ok(seen.size > 1990);
  });

  test('accept common typing formats', () => {
    assert.equal(normalizeCode('123 456'), '123456');
    assert.equal(normalizeCode(' 123-456 '), '123456');
    assert.equal(normalizeCode('12345'), null);
    assert.equal(normalizeCode('1234567'), null);
    assert.equal(formatCode('012345'), '012 345');
  });

  test('wrap the transfer key so only the code can open it', async () => {
    const raw = generateFileKey();
    const sealed = await sealKeyWithCode('482905', raw, 10_000);
    assert.equal(sealed.lookup, await codeLookup('482905'));
    assert.equal(sealed.wrapped.length, 80);
    assert.equal(sealed.salt.length, 22);
    assert.deepEqual(await openKeyWithCode('482905', sealed), raw);
    await assert.rejects(openKeyWithCode('482906', sealed));
  });
});

describe('chunk planning', () => {
  test('never splits a chunk across files', () => {
    const plan = planChunks(
      [
        { name: 'a', size: DIRECT_CHUNK_SIZE * 2 + 1 },
        { name: 'empty', size: 0 },
        { name: 'b', size: 5 },
      ],
      DIRECT_CHUNK_SIZE,
    );
    assert.equal(plan.chunkCount, 4);
    assert.equal(plan.totalSize, DIRECT_CHUNK_SIZE * 2 + 6);
    assert.deepEqual(locateChunk(plan, 0), { fileIndex: 0, start: 0, end: DIRECT_CHUNK_SIZE });
    assert.deepEqual(locateChunk(plan, 2), {
      fileIndex: 0,
      start: DIRECT_CHUNK_SIZE * 2,
      end: DIRECT_CHUNK_SIZE * 2 + 1,
    });
    assert.deepEqual(locateChunk(plan, 3), { fileIndex: 2, start: 0, end: 5 });
    assert.throws(() => locateChunk(plan, 4));
  });
});

describe('zip', () => {
  test('crc32 matches the reference value', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    const bytes = new TextEncoder().encode('hello world');
    assert.equal(crc32(bytes.subarray(5), crc32(bytes.subarray(0, 5))), crc32(bytes));
  });

  test('sanitises dangerous names', () => {
    assert.equal(safeName('../../etc/passwd'), '_.._etc_passwd');
    assert.equal(safeName('..'), 'file');
    assert.equal(safeName('a\u0000b.txt'), 'ab.txt');
  });

  test('produces an archive standard tools can extract', async (t) => {
    let hasUnzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      hasUnzip = false;
    }
    const a = new TextEncoder().encode('first file');
    const b = randomBytes(5000);
    const parts = buildZip([
      { name: 'one.txt', size: a.length, crc: crc32(a), lastModified: Date.now(), blob: new Blob([a]) },
      { name: 'one.txt', size: b.length, crc: crc32(b), lastModified: Date.now(), blob: new Blob([b]) },
      { name: 'фото.bin', size: b.length, crc: crc32(b), lastModified: Date.now(), blob: new Blob([b]) },
    ]);
    const zip = Buffer.from(await new Blob(parts).arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    if (!hasUnzip) {
      t.skip('unzip not installed');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-zip-'));
    const file = path.join(dir, 'out.zip');
    fs.writeFileSync(file, zip);
    execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
    execFileSync('unzip', ['-o', '-q', file, '-d', path.join(dir, 'x')]);
    assert.equal(fs.readFileSync(path.join(dir, 'x', 'one.txt'), 'utf8'), 'first file');
    assert.ok(fs.readFileSync(path.join(dir, 'x', 'one (1).txt')).equals(Buffer.from(b)));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('device descriptions', () => {
  test('describe common browsers briefly', () => {
    assert.equal(
      describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
      'iPhone · Safari',
    );
    assert.equal(
      describeDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'),
      'Android phone · Chrome',
    );
    assert.equal(
      describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'),
      'Windows PC · Edge',
    );
  });
});
