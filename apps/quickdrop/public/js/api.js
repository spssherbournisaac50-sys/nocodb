import { sleep } from './ui.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error || 'error';
    this.body = body || {};
    this.retryAfter = Number(body?.retryAfter) || 0;
  }
}

async function request(method, path, { json, body, headers = {}, signal } = {}) {
  const allHeaders = { 'X-QuickDrop': '1', ...headers };
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    allHeaders['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { method, headers: allHeaders, body: payload, signal, credentials: 'same-origin' });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

export const api = {
  config: () => request('GET', '/api/config'),
  createTransfer: (payload) => request('POST', '/api/transfers', { json: payload }),
  transfer: (id) => request('GET', `/api/transfers/${id}`),
  status: (id, token) => request('GET', `/api/transfers/${id}/status`, { headers: bearer(token) }),
  revoke: (id, token) => request('DELETE', `/api/transfers/${id}`, { headers: bearer(token) }),
  newCode: (id, token, code) => request('POST', `/api/transfers/${id}/code`, { json: { code }, headers: bearer(token) }),
  putChunk: (id, index, token, data, signal) =>
    request('PUT', `/api/transfers/${id}/chunks/${index}`, {
      body: data,
      headers: { ...bearer(token), 'Content-Type': 'application/octet-stream' },
      signal,
    }),
  beginDownload: (id) => request('POST', `/api/transfers/${id}/downloads`),
  finishDownload: (id, token) =>
    request('POST', `/api/transfers/${id}/downloads/done`, { headers: { 'X-Download-Token': token } }),
  // Resolves to the encrypted chunk, or null if the sender hasn't uploaded it yet.
  async getChunk(id, index, token, signal) {
    const res = await fetch(`/api/transfers/${id}/chunks/${index}`, {
      headers: { 'X-Download-Token': token },
      signal,
      cache: 'no-store',
    });
    if (res.status === 200) return new Uint8Array(await res.arrayBuffer());
    if (res.status === 202) return null;
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new ApiError(res.status, body);
  },
  claim: (lookup) => request('POST', '/api/claim', { json: { lookup } }),
  me: () => request('GET', '/api/auth/me'),
  signup: (email, password) => request('POST', '/api/auth/signup', { json: { email, password } }),
  login: (email, password) => request('POST', '/api/auth/login', { json: { email, password } }),
  logout: () => request('POST', '/api/auth/logout'),
  myTransfers: () => request('GET', '/api/me/transfers'),
};

// Retries network failures, 5xx, 429 and busy responses with exponential backoff.
export async function withRetry(fn, { tries = 6, signal } = {}) {
  let delay = 400;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      const retryable = !(err instanceof ApiError) || err.status >= 500 || err.status === 429 || err.status === 409;
      if (!retryable || attempt >= tries) throw err;
      await sleep(err.retryAfter ? err.retryAfter * 1000 : delay);
      delay = Math.min(delay * 2, 8000);
    }
  }
}

export function explain(err) {
  if (err instanceof ApiError) return err.message;
  if (err?.name === 'AbortError') return 'Cancelled';
  if (err instanceof TypeError) return 'Network problem. Check your connection and try again.';
  return err?.message || 'Something went wrong';
}
