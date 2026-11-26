import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService, SESSION_COOKIE } from './auth.js';
import { openDb } from './db.js';
import {
  HttpError,
  bearerToken,
  clientIp,
  describeDevice,
  isSecureRequest,
  parseCookies,
  readBody,
  readJson,
  sendJson,
} from './http.js';
import { RateLimiter } from './rate-limit.js';
import { SignalingHub } from './signaling.js';
import { createStaticHandler } from './static.js';
import { ChunkStore } from './storage.js';
import { TransferService } from './transfers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const ID = '([A-Za-z0-9_-]{22})';

export async function createApp(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, 'quickdrop.db'));
  const store = new ChunkStore(path.join(config.dataDir, 'chunks'));
  await store.init();

  const service = new TransferService({ db, store, config });
  const auth = new AuthService(db);
  await service.removeOrphans();

  const limits = {
    create: new RateLimiter({ windowMs: 3600_000, max: config.rateLimits.createPerHour }),
    codeFailures: new RateLimiter({ windowMs: 600_000, max: config.rateLimits.codeFailuresPer10Min }),
    auth: new RateLimiter({ windowMs: 600_000, max: config.rateLimits.authPer10Min }),
    sockets: new RateLimiter({ windowMs: 60_000, max: config.rateLimits.socketsPerMinute }),
  };
  const ipOf = (req) => clientIp(req, config.trustProxy);

  const hub = new SignalingHub({ service, config, limiter: limits.sockets, trustProxyIp: ipOf });
  service.hub = hub;

  const handleStatic = createStaticHandler(PUBLIC_DIR, config.appName);

  function currentUser(req) {
    if (!config.accountsEnabled) return null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token ? auth.userForToken(token) : null;
  }

  function sessionCookie(req, token, maxAge) {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (isSecureRequest(req, config.trustProxy)) parts.push('Secure');
    return parts.join('; ');
  }

  function requireAccounts() {
    if (!config.accountsEnabled) throw new HttpError(404, 'accounts_disabled', 'Accounts are not available on this server');
  }

  function rateLimit(limiter, key) {
    if (!limiter.take(key)) {
      throw new HttpError(429, 'rate_limited', 'Too many requests, please slow down', {
        retryAfter: limiter.retryAfterSeconds(key),
      });
    }
  }

  function publicConfig(user) {
    return {
      appName: config.appName,
      accountsEnabled: config.accountsEnabled,
      signupEnabled: config.accountsEnabled && config.signupEnabled,
      relayEnabled: config.relayEnabled,
      iceServers: config.iceServers,
      codeTtlMinutes: config.codeTtlMinutes,
      limits: service.limitsFor(user),
      plans: config.limits,
      user,
    };
  }

  // [method, regex, handler(req, res, match, ctx)]
  const routes = [
    ['GET', /^\/api\/config$/, (req, res, m, ctx) => sendJson(res, 200, publicConfig(ctx.user()))],

    ['POST', /^\/api\/transfers$/, async (req, res, m, ctx) => {
      rateLimit(limits.create, ctx.ip);
      const body = await readJson(req, 640 * 1024);
      sendJson(res, 201, service.create(body, ctx.user()));
    }],

    ['GET', new RegExp(`^/api/transfers/${ID}$`), (req, res, m) => sendJson(res, 200, service.info(m[1]))],

    ['DELETE', new RegExp(`^/api/transfers/${ID}$`), (req, res, m, ctx) => {
      sendJson(res, 200, service.revoke(m[1], bearerToken(req), ctx.user()));
    }],

    ['GET', new RegExp(`^/api/transfers/${ID}/status$`), (req, res, m, ctx) => {
      sendJson(res, 200, service.status(m[1], bearerToken(req), ctx.user()));
    }],

    ['PUT', new RegExp(`^/api/transfers/${ID}/chunks/(\\d{1,9})$`), async (req, res, m, ctx) => {
      const data = await readBody(req, 1024 * 1024 + 1024);
      sendJson(res, 200, await service.putChunk(m[1], Number(m[2]), bearerToken(req), ctx.user(), data));
    }],

    ['POST', new RegExp(`^/api/transfers/${ID}/downloads$`), (req, res, m, ctx) => {
      sendJson(res, 201, service.beginDownload(m[1], ctx.device));
    }],

    ['GET', new RegExp(`^/api/transfers/${ID}/chunks/(\\d{1,9})$`), async (req, res, m) => {
      const aborter = new AbortController();
      res.on('close', () => aborter.abort());
      const token = String(req.headers['x-download-token'] || '');
      const data = await service.getChunk(m[1], Number(m[2]), token, aborter.signal);
      if (!data) return sendJson(res, 202, { pending: true });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(data);
      return undefined;
    }],

    ['POST', new RegExp(`^/api/transfers/${ID}/downloads/done$`), (req, res, m) => {
      sendJson(res, 200, service.finishDownload(m[1], String(req.headers['x-download-token'] || '')));
    }],

    ['POST', new RegExp(`^/api/transfers/${ID}/code$`), async (req, res, m, ctx) => {
      const body = await readJson(req);
      sendJson(res, 200, service.newCode(m[1], bearerToken(req), ctx.user(), body.code));
    }],

    ['POST', /^\/api\/claim$/, async (req, res, m, ctx) => {
      if (limits.codeFailures.blocked(ctx.ip)) {
        throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Wait a few minutes or scan the QR code.', {
          retryAfter: limits.codeFailures.retryAfterSeconds(ctx.ip),
        });
      }
      const body = await readJson(req);
      const result = service.claim(body.lookup, ctx.device);
      if (!result) {
        limits.codeFailures.take(ctx.ip);
        throw new HttpError(404, 'invalid_code', 'That code doesn’t match an active transfer. Check the digits and try again.');
      }
      sendJson(res, 200, result);
    }],

    ['POST', /^\/api\/auth\/signup$/, async (req, res, m, ctx) => {
      requireAccounts();
      if (!config.signupEnabled) throw new HttpError(403, 'signup_disabled', 'Sign-ups are disabled');
      rateLimit(limits.auth, ctx.ip);
      const body = await readJson(req);
      const user = await auth.signup(body.email, body.password);
      const session = auth.createSession(user.id);
      sendJson(res, 201, { user }, { 'Set-Cookie': sessionCookie(req, session.token, session.maxAge) });
    }],

    ['POST', /^\/api\/auth\/login$/, async (req, res, m, ctx) => {
      requireAccounts();
      rateLimit(limits.auth, ctx.ip);
      const body = await readJson(req);
      const user = await auth.login(body.email, body.password);
      const session = auth.createSession(user.id);
      sendJson(res, 200, { user }, { 'Set-Cookie': sessionCookie(req, session.token, session.maxAge) });
    }],

    ['POST', /^\/api\/auth\/logout$/, (req, res) => {
      auth.destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }],

    ['GET', /^\/api\/auth\/me$/, (req, res, m, ctx) => sendJson(res, 200, { user: ctx.user() })],

    ['GET', /^\/api\/me\/transfers$/, (req, res, m, ctx) => {
      const user = ctx.user();
      if (!user) throw new HttpError(401, 'unauthorized', 'Sign in to see your transfers');
      sendJson(res, 200, { transfers: service.listForOwner(user.id) });
    }],
  ];

  function securityHeaders(req, res) {
    const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:[\]-]/g, '');
    const sockets = host ? ` ws://${host} wss://${host}` : '';
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        `connect-src 'self'${sockets}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (isSecureRequest(req, config.trustProxy)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  }

  async function handle(req, res) {
    securityHeaders(req, res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    const { pathname } = url;

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/')) {
      let cachedUser;
      const ctx = {
        ip: ipOf(req),
        device: describeDevice(req.headers['user-agent']),
        user: () => {
          if (cachedUser === undefined) cachedUser = currentUser(req);
          return cachedUser;
        },
      };
      try {
        // CSRF defence: browsers cannot add custom headers cross-origin without a
        // CORS preflight, which this server never approves.
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-quickdrop'] !== '1') {
          throw new HttpError(403, 'csrf', 'Missing X-QuickDrop header');
        }
        for (const [method, re, handler] of routes) {
          if (method !== req.method) continue;
          const match = re.exec(pathname);
          if (match) {
            await handler(req, res, match, ctx);
            return;
          }
        }
        throw new HttpError(404, 'not_found', 'Unknown API route');
      } catch (err) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (err instanceof HttpError) {
          const headers = err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
          sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra }, headers);
        } else {
          console.error('[quickdrop]', req.method, pathname, err);
          sendJson(res, 500, { error: 'server_error', message: 'Something went wrong on our side' });
        }
      }
      return;
    }

    try {
      if (await handleStatic(req, res, pathname)) return;
    } catch (err) {
      console.error('[quickdrop] static', pathname, err);
    }
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[quickdrop] unhandled', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    });
  });
  server.requestTimeout = 0; // long uploads/downloads
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    hub.handleUpgrade(req, socket, head);
  });

  const sweeper = setInterval(() => {
    try {
      service.sweep();
      auth.sweep();
      for (const limiter of Object.values(limits)) limiter.sweep();
    } catch (err) {
      console.error('[quickdrop] sweep failed', err);
    }
  }, config.sweepIntervalMs);
  sweeper.unref();

  return {
    server,
    service,
    hub,
    db,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      clearInterval(sweeper);
      hub.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      db.close();
    },
  };
}
