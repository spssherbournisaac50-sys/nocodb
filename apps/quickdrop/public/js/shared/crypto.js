// End-to-end encryption primitives shared by the browser app and the Node tests.
// Only WebCrypto is used, so this file runs unchanged in browsers and Node 22+.
//
// Every transfer gets a fresh random 256-bit AES-GCM key. The key never reaches
// the server in plain form: links/QR codes carry it in the URL fragment (#...),
// which browsers never send over the network.

const subtle = globalThis.crypto.subtle;

export const KEY_BYTES = 32;
export const TAG_BYTES = 16;

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  // getRandomValues accepts at most 65536 bytes per call.
  for (let i = 0; i < length; i += 65536) {
    globalThis.crypto.getRandomValues(bytes.subarray(i, Math.min(length, i + 65536)));
  }
  return bytes;
}

export function toB64url(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) {
    throw new Error('Invalid base64url string');
  }
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

export function generateFileKey() {
  return randomBytes(KEY_BYTES);
}

export function importFileKey(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== KEY_BYTES) {
    throw new Error('Invalid transfer key');
  }
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Chunk IVs are derived from the chunk index. The key is unique per transfer
// and each index is encrypted exactly once, so IVs never repeat. Binding the
// index into the IV also stops the server from reordering or swapping chunks.
function chunkIv(index) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

// The manifest uses an IV outside the chunk IV space (first byte = 1).
const MANIFEST_IV = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

export async function encryptChunk(key, index, data) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(index) }, key, data));
}

export async function decryptChunk(key, index, data) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(index) }, key, data));
}

export async function encryptJson(key, value) {
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await subtle.encrypt({ name: 'AES-GCM', iv: MANIFEST_IV }, key, plain);
  return toB64url(new Uint8Array(sealed));
}

export async function decryptJson(key, b64) {
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: MANIFEST_IV }, key, fromB64url(b64));
  return JSON.parse(new TextDecoder().decode(plain));
}
