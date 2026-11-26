import { api, explain } from './api.js';
import { clearHistory, findTransfer, forgetTransfer, loadHistory } from './history.js';
import { copyText, formatBytes, formatWhen, h, icon, toast } from './ui.js';

const STATUS_LABEL = {
  active: 'Active',
  completed: 'Delivered',
  expired: 'Expired',
  revoked: 'Cancelled',
};

function pill(status) {
  return h('span', { class: `pill pill-${status}` }, STATUS_LABEL[status] || status);
}

export function renderAccount(root, app) {
  const container = h('div', { class: 'account-page' });
  root.append(container);
  let disposed = false;

  function render() {
    if (disposed) return;
    container.replaceChildren(
      h(
        'section',
        { class: 'hero hero-small' },
        h('h1', null, app.user ? 'Your account' : 'Optional account'),
        h(
          'p',
          { class: 'lede' },
          app.user
            ? `Signed in as ${app.user.email}`
            : `${app.config.appName} works without an account. Create one only if you want bigger limits and your history on every device.`,
        ),
      ),
      app.user ? signedIn() : signedOut(),
      deviceHistory(),
    );
  }

  function planCard(title, plan, highlight) {
    const row = (label, value) => h('li', null, h('span', null, label), h('strong', null, value));
    return h(
      'div',
      { class: `plan${highlight ? ' plan-highlight' : ''}` },
      h('h3', null, title),
      h(
        'ul',
        null,
        row('Live transfers', 'Unlimited size'),
        row('Upload size', formatBytes(plan.maxBytes)),
        row('Keep uploads for', plan.maxHours >= 48 ? `${Math.round(plan.maxHours / 24)} days` : `${plan.maxHours} hours`),
        row('Downloads per transfer', String(plan.maxDownloads)),
      ),
    );
  }

  function signedOut() {
    let mode = 'signup';
    const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com', id: 'acc-email' });
    const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minLength: 8, placeholder: 'At least 8 characters', id: 'acc-password' });
    const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' });
    const switchBtn = h('button', { class: 'link-btn', type: 'button' });
    const title = h('h2');

    const sync = () => {
      const signup = mode === 'signup';
      title.textContent = signup ? 'Create a free account' : 'Sign in';
      submit.textContent = signup ? 'Create account' : 'Sign in';
      switchBtn.textContent = signup ? 'Already have an account? Sign in' : 'New here? Create an account';
      password.autocomplete = signup ? 'new-password' : 'current-password';
      error.hidden = true;
    };
    switchBtn.addEventListener('click', () => {
      mode = mode === 'signup' ? 'login' : 'signup';
      sync();
    });
    sync();

    const form = h(
      'form',
      {
        class: 'card auth-card',
        onsubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          try {
            const res = mode === 'signup' ? await api.signup(email.value, password.value) : await api.login(email.value, password.value);
            await app.refreshUser(res.user);
            toast(mode === 'signup' ? 'Account created' : 'Signed in', 'success');
            render();
          } catch (err) {
            error.hidden = false;
            error.textContent = explain(err);
          } finally {
            submit.disabled = false;
          }
        },
      },
      title,
      h('label', { class: 'field', for: 'acc-email' }, h('span', null, 'Email'), email),
      h('label', { class: 'field', for: 'acc-password' }, h('span', null, 'Password'), password),
      error,
      submit,
      switchBtn,
    );

    if (!app.config.signupEnabled) {
      mode = 'login';
      sync();
      switchBtn.hidden = true;
    }

    return h(
      'div',
      { class: 'account-grid' },
      h(
        'section',
        { class: 'card plans-card' },
        h('h2', null, 'What you get'),
        h('div', { class: 'plans' }, planCard('Without account', app.config.plans.anonymous), planCard('Free account', app.config.plans.account, true)),
        h('p', { class: 'hint' }, icon('lock'), 'Your files stay end-to-end encrypted either way. An account only stores your email and a password hash.'),
      ),
      form,
    );
  }

  function signedIn() {
    const list = h('div', { class: 'list-body' }, h('p', { class: 'muted' }, 'Loading…'));
    const section = h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', null, 'Your transfers'),
        h(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            onclick: async () => {
              await api.logout().catch(() => {});
              await app.refreshUser(null);
              toast('Signed out');
              render();
            },
          },
          'Sign out',
        ),
      ),
      h('p', { class: 'muted' }, 'File names are encrypted, so they only show on the device that sent them.'),
      list,
    );

    api
      .myTransfers()
      .then(({ transfers }) => {
        if (!transfers.length) {
          list.replaceChildren(h('p', { class: 'muted' }, 'Nothing yet. Transfers you send while signed in show up here.'));
          return;
        }
        list.replaceChildren(
          h(
            'ul',
            { class: 'transfer-list' },
            ...transfers.map((t) => {
              const local = findTransfer(t.id);
              return h(
                'li',
                { class: 'transfer-row' },
                icon(t.mode === 'direct' ? 'bolt' : 'cloud', 'row-icon'),
                h(
                  'div',
                  { class: 'row-main' },
                  h('span', { class: 'row-title' }, local?.title || (t.mode === 'direct' ? 'Live transfer' : 'Upload')),
                  h(
                    'span',
                    { class: 'row-sub' },
                    `${formatBytes(t.totalSize)} · received ${t.downloads}/${t.maxDownloads} · sent ${formatWhen(t.createdAt)}${
                      t.status === 'active' ? ` · expires ${formatWhen(t.expiresAt)}` : ''
                    }`,
                  ),
                ),
                pill(t.status),
                t.status === 'active'
                  ? h(
                    'button',
                    {
                      class: 'btn btn-ghost btn-sm btn-danger',
                      type: 'button',
                      onclick: async () => {
                        if (!confirm('Cancel this transfer? Its link and code will stop working.')) return;
                        try {
                          await api.revoke(t.id);
                          render();
                        } catch (err) {
                          toast(explain(err), 'error');
                        }
                      },
                    },
                    'Cancel',
                  )
                  : null,
              );
            }),
          ),
        );
      })
      .catch((err) => list.replaceChildren(h('p', { class: 'field-error' }, explain(err))));

    return section;
  }

  function deviceHistory() {
    const entries = loadHistory();
    const body = h('div', { class: 'list-body' });
    const section = h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', null, 'Sent from this device'),
        entries.length
          ? h(
            'button',
            {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              onclick: () => {
                if (!confirm('Forget all transfers on this device? They keep working until they expire.')) return;
                clearHistory();
                render();
              },
            },
            'Clear list',
          )
          : null,
      ),
      h('p', { class: 'muted' }, 'Saved only in this browser so you can re-share or cancel recent transfers.'),
      body,
    );
    if (!entries.length) {
      body.append(h('p', { class: 'muted' }, 'No transfers sent from this device yet.'));
      return section;
    }
    const rows = entries.map((entry) => {
      const status = h('span', { class: 'pill' }, '…');
      const actions = h('div', { class: 'row-actions' });
      const row = h(
        'li',
        { class: 'transfer-row' },
        icon(entry.mode === 'direct' ? 'bolt' : 'cloud', 'row-icon'),
        h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, entry.title), h('span', { class: 'row-sub' }, `${entry.summary} · sent ${formatWhen(entry.createdAt)}`)),
        status,
        actions,
      );
      api
        .status(entry.id, entry.manageToken)
        .then((s) => {
          status.replaceWith(pill(s.status));
          if (s.status === 'active') {
            if (entry.mode === 'upload') {
              actions.append(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => copyText(entry.link, 'Link copied') }, icon('link'), 'Copy link'));
            }
            actions.append(
              h(
                'button',
                {
                  class: 'btn btn-ghost btn-sm btn-danger',
                  type: 'button',
                  onclick: async () => {
                    if (!confirm('Cancel this transfer? Its link and code will stop working.')) return;
                    await api.revoke(entry.id, entry.manageToken).catch((err) => toast(explain(err), 'error'));
                    render();
                  },
                },
                'Cancel',
              ),
            );
          } else {
            actions.append(
              h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove from list', onclick: () => { forgetTransfer(entry.id); render(); } }, icon('trash')),
            );
          }
        })
        .catch(() => {
          status.replaceWith(pill('expired'));
          actions.append(
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove from list', onclick: () => { forgetTransfer(entry.id); render(); } }, icon('trash')),
          );
        });
      return row;
    });
    body.append(h('ul', { class: 'transfer-list' }, ...rows));
    return section;
  }

  render();
  return {
    teardown() {
      disposed = true;
    },
  };
}
