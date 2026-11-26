// Six-digit one-time transfer codes.
//
// The sender's browser generates the code. The server only ever receives
// `lookup` (a hash of the code) plus the transfer key wrapped with a key derived
// from the code. A code is short-lived, rate-limited per IP and single-use for
// one-time transfers. Once it is used or expires, the server deletes the wrapped
// key, after which only the QR/link key can decrypt the files.

import { fromB64url, randomBytes, sha256, toB64url } from './crypto.js';

const subtle = globalThis.crypto.subtle;

export const CODE_DIGITS = 6;
export const CODE_KDF_ITERATIONS = 100_000;

export function generateCode() {
  // Rejection sampling keeps every code equally likely.
  const limit = 4294967296 - (4294967296 % 1_000_000);
  const buf = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(CODE_DIGITS, '0');
}

export function normalizeCode(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits.length === CODE_DIGITS ? digits : null;
}

export function formatCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export async function codeLookup(code) {
  const digest = await sha256(new TextEncoder().encode(`quickdrop/code/v1:${code}`));
  return toB64url(digest);
}

async function deriveWrapKey(code, salt, iterations) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Returns the payload the server stores for a code.
export async function sealKeyWithCode(code, rawFileKey, iterations = CODE_KDF_ITERATIONS) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wrapKey = await deriveWrapKey(code, salt, iterations);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, rawFileKey));
  const wrapped = new Uint8Array(iv.length + sealed.length);
  wrapped.set(iv, 0);
  wrapped.set(sealed, iv.length);
  return {
    lookup: await codeLookup(code),
    salt: toB64url(salt),
    wrapped: toB64url(wrapped),
    iterations,
  };
}

export async function openKeyWithCode(code, { salt, wrapped, iterations }) {
  const wrapKey = await deriveWrapKey(code, fromB64url(salt), iterations);
  const bytes = fromB64url(wrapped);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, wrapKey, bytes.subarray(12));
  return new Uint8Array(plain);
}
