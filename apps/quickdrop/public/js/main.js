import { renderAccount } from './account.js';
import { api, explain } from './api.js';
import { renderReceive } from './receive.js';
import { renderSend } from './send.js';
import { h } from './ui.js';

const ROUTES = [
  { re: /^\/$/, view: 'send', render: renderSend },
  { re: /^\/receive\/?$/, view: 'receive', render: renderReceive },
  { re: /^\/r\/([A-Za-z0-9_-]{22})\/?$/, view: 'receive', render: renderReceive, params: (m) => ({ id: m[1] }) },
  { re: /^\/account\/?$/, view: 'account', render: renderAccount },
];

const root = document.getElementById('app');
const app = {
  config: null,
  user: null,
  pendingCode: null,
  current: null,
  navigate,
  replaceUrl,
  refreshUser,
};

function updateNav(view) {
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const account = document.getElementById('nav-account');
  if (account) account.textContent = app.user ? 'Account' : 'Sign in';
}

async function refreshUser(user) {
  app.user = user;
  try {
    app.config = await api.config();
    app.user = app.config.user;
  } catch {
    // keep the previous config
  }
  updateNav(app.current?.view);
}

function render({ focus = false } = {}) {
  const path = location.pathname;
  let route = null;
  let match = null;
  for (const r of ROUTES) {
    match = r.re.exec(path);
    if (match) {
      route = r;
      break;
    }
  }
  if (!route) {
    history.replaceState(null, '', '/');
    route = ROUTES[0];
    match = ['/'];
  }
  app.current?.handle?.teardown?.();
  root.replaceChildren();
  const handle = route.render(root, app, route.params ? route.params(match) : {});
  app.current = { view: route.view, handle, path: currentUrl() };
  updateNav(route.view);
  const titles = { send: 'Send files instantly', receive: 'Receive files', account: 'Account' };
  document.title = `${app.config.appName} · ${titles[route.view]}`;
  if (focus) {
    window.scrollTo(0, 0);
    root.focus({ preventScroll: true });
  }
}

const currentUrl = () => location.pathname + location.search + location.hash;

// Changes the address bar without re-rendering (e.g. code → link after a claim).
function replaceUrl(url) {
  history.replaceState(null, '', url);
  if (app.current) app.current.path = currentUrl();
}

function navigate(url, { replace = false, force = false } = {}) {
  const target = new URL(url, location.origin);
  const next = target.pathname + target.search + target.hash;
  if (!force && next === currentUrl()) return;
  if (app.current?.handle?.canLeave && !app.current.handle.canLeave()) return;
  if (replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
  render({ focus: true });
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute('href'), { force: link.getAttribute('href') === location.pathname });
});

window.addEventListener('popstate', () => {
  if (currentUrl() === app.current?.path) return;
  if (app.current?.handle?.canLeave && !app.current.handle.canLeave()) {
    history.pushState(null, '', app.current.path);
    return;
  }
  render({ focus: true });
});

async function boot() {
  // WebCrypto (used for end-to-end encryption) only exists on HTTPS or localhost.
  if (!globalThis.crypto?.subtle) {
    root.replaceChildren(
      h(
        'section',
        { class: 'card narrow center-card' },
        h('h2', null, 'A secure connection is required'),
        h(
          'p',
          { class: 'muted' },
          'Files are encrypted in your browser, which only works over HTTPS. Open this site with https:// (or on localhost).',
        ),
      ),
    );
    return;
  }
  try {
    app.config = await api.config();
    app.user = app.config.user;
  } catch (err) {
    root.replaceChildren(
      h(
        'section',
        { class: 'card narrow center-card' },
        h('h2', null, 'Can’t reach the server'),
        h('p', { class: 'muted' }, explain(err)),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, 'Try again'),
      ),
    );
    return;
  }
  for (const el of document.querySelectorAll('[data-app-name]')) el.textContent = app.config.appName;
  render();
}

boot();
