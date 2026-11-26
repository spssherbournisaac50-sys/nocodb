import path from 'node:path';

const GiB = 1024 ** 3;

function num(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function iceServers(env) {
  if (env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      console.warn('[quickdrop] ICE_SERVERS is not valid JSON, falling back to defaults');
    }
  }
  const stun = (env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const servers = stun.length ? [{ urls: stun }] : [];
  if (env.TURN_URLS) {
    servers.push({
      urls: env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
      username: env.TURN_USERNAME || undefined,
      credential: env.TURN_CREDENTIAL || undefined,
    });
  }
  return servers;
}

export function loadConfig(overrides = {}, env = process.env) {
  const base = {
    appName: env.APP_NAME || 'QuickDrop',
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    // Set when running behind a reverse proxy / load balancer so client IPs and
    // https detection come from X-Forwarded-* headers.
    trustProxy: bool(env.TRUST_PROXY, false),
    // Optional accounts. Turn off on hosts without a persistent disk.
    accountsEnabled: bool(env.ACCOUNTS_ENABLED, true),
    signupEnabled: bool(env.SIGNUP_ENABLED, true),
    // Live transfers fall back to relaying encrypted frames through the server
    // when a direct WebRTC connection cannot be established.
    relayEnabled: bool(env.RELAY_ENABLED, true),
    storageQuotaBytes: num(env.STORAGE_QUOTA_GB, 50) * GiB,
    codeTtlMinutes: num(env.CODE_TTL_MINUTES, 60),
    // Live transfers end if the sender's tab stays disconnected this long.
    hostGraceSeconds: num(env.HOST_GRACE_SECONDS, 120),
    sweepIntervalMs: num(env.SWEEP_INTERVAL_MS, 30_000),
    limits: {
      anonymous: {
        maxBytes: num(env.ANON_MAX_GB, 4) * GiB,
        maxHours: num(env.ANON_MAX_HOURS, 24),
        maxDownloads: num(env.ANON_MAX_DOWNLOADS, 10),
      },
      account: {
        maxBytes: num(env.USER_MAX_GB, 16) * GiB,
        maxHours: num(env.USER_MAX_HOURS, 168),
        maxDownloads: num(env.USER_MAX_DOWNLOADS, 100),
      },
    },
    rateLimits: {
      createPerHour: num(env.RATE_CREATE_PER_HOUR, 120),
      codeFailuresPer10Min: num(env.RATE_CODE_FAILURES_PER_10MIN, 10),
      authPer10Min: num(env.RATE_AUTH_PER_10MIN, 20),
      socketsPerMinute: num(env.RATE_SOCKETS_PER_MIN, 60),
    },
    iceServers: iceServers(env),
  };
  return {
    ...base,
    ...overrides,
    limits: { ...base.limits, ...(overrides.limits || {}) },
    rateLimits: { ...base.rateLimits, ...(overrides.rateLimits || {}) },
  };
}
