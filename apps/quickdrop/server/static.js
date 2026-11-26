import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Browser builds of third-party libraries, served straight from node_modules.
const VENDOR = {
  '/vendor/qrcode.mjs': path.join(path.dirname(require.resolve('qrcode-generator')), 'qrcode.mjs'),
  '/vendor/jsQR.js': require.resolve('jsqr'),
};

// Client-side routes that render the single-page app.
const APP_ROUTES = [/^\/$/, /^\/receive\/?$/, /^\/account\/?$/, /^\/r\/[A-Za-z0-9_-]{22}\/?$/];

export function createStaticHandler(publicDir, appName) {
  const root = path.resolve(publicDir);

  async function serveFile(res, file, req, transform) {
    let stat;
    try {
      stat = await fs.stat(file);
      if (!stat.isFile()) return false;
    } catch {
      return false;
    }
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (!transform && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    let body = await fs.readFile(file);
    if (transform) {
      body = Buffer.from(transform(body.toString('utf8')));
      delete headers.ETag;
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const renderIndex = (html) => html.replaceAll('%APP_NAME%', escape(appName));

  return async function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (APP_ROUTES.some((re) => re.test(pathname))) {
      return serveFile(res, path.join(root, 'index.html'), req, renderIndex);
    }
    if (VENDOR[pathname]) return serveFile(res, VENDOR[pathname], req);
    if (pathname === '/manifest.webmanifest') {
      return serveFile(res, path.join(root, 'manifest.webmanifest'), req, renderIndex);
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const file = path.join(root, path.normalize(decoded));
    if (!file.startsWith(root + path.sep) || path.basename(file).startsWith('.')) return false;
    if (path.basename(file) === 'index.html') return false;
    return serveFile(res, file, req);
  };
}
