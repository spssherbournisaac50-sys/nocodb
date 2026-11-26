import { api, explain, withRetry } from './api.js';
import { scanQr } from './qr.js';
import { locateChunk } from './shared/chunks.js';
import { codeLookup, normalizeCode, openKeyWithCode } from './shared/code.js';
import { decryptChunk, decryptJson, fromB64url, importFileKey, toB64url } from './shared/crypto.js';
import { buildZip, canZip, crc32Blob, safeName } from './shared/zip.js';
import { SignalClient } from './signal.js';
import { connectAsPeer, hasWebRtc } from './transport.js';
import {
  SpeedMeter,
  copyText,
  fileIcon,
  formatBytes,
  formatWhen,
  h,
  icon,
  orderedMap,
  plural,
  progressBar,
  sleep,
  toast,
} from './ui.js';

const DOWNLOAD_CONCURRENCY = 4;
const BLOB_FLUSH_BYTES = 32 * 1024 * 1024;
const PREVIEW_MAX_BYTES = 200 * 1024 * 1024;

// Collects decrypted chunks into Blobs. Flushing into Blob parts regularly lets
// the browser page large files out to disk instead of holding them in memory.
class BlobSink {
  constructor(files) {
    this.files = files.map((meta) => ({ meta, blobs: [], parts: [], pending: 0 }));
  }

  write(fileIndex, bytes) {
    const f = this.files[fileIndex];
    f.parts.push(bytes);
    f.pending += bytes.length;
    if (f.pending >= BLOB_FLUSH_BYTES) {
      f.blobs.push(new Blob(f.parts));
      f.parts = [];
      f.pending = 0;
    }
  }

  finish() {
    return this.files.map(({ meta, blobs, parts }) => ({
      ...meta,
      blob: new Blob([...blobs, ...parts], { type: meta.type || 'application/octet-stream' }),
    }));
  }
}

const LIVE_ERRORS = {
  host_offline: 'The sender’s device is offline. Ask them to open the transfer page again, then retry.',
  busy: 'Another device is receiving this right now. Try again in a moment.',
  no_downloads_left: 'This transfer has already been received.',
  ended: 'This transfer has ended.',
  not_found: 'This transfer does not exist.',
};

function goToCode(app) {
  return (code) => {
    app.pendingCode = code;
    app.navigate('/receive');
  };
}

export function handleScanned(text, app, onCode) {
  const code = normalizeCode(text);
  if (code && /^[\d\s-]+$/.test(text.trim())) {
    onCode(code);
    return;
  }
  try {
    const url = new URL(text);
    if (/^\/r\/[A-Za-z0-9_-]{22}\/?$/.test(url.pathname) && url.hash.length > 1) {
      if (url.origin === location.origin) app.navigate(url.pathname + url.hash);
      else location.href = url.href;
      return;
    }
  } catch {
    // not a URL
  }
  toast(`That QR code isn’t a ${app.config.appName} transfer`, 'error');
}

export function receiveCard(app, { compact = false, onCode, error, prefill } = {}) {
  const submitCode = onCode || goToCode(app);
  const input = h('input', {
    class: 'code-input',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    enterkeyhint: 'go',
    maxLength: 7,
    placeholder: '000 000',
    'aria-label': '6-digit code',
    'data-testid': 'code-input',
  });
  if (prefill) input.value = prefill.length > 3 ? `${prefill.slice(0, 3)} ${prefill.slice(3)}` : prefill;
  const errorEl = h('p', { class: 'field-error', role: 'alert', hidden: !error }, error || '');
  let submitted = false;

  const go = () => {
    const code = normalizeCode(input.value);
    if (!code) {
      errorEl.hidden = false;
      errorEl.textContent = 'Enter all 6 digits of the code.';
      input.focus();
      return;
    }
    submitted = true;
    submitCode(code);
  };

  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
    errorEl.hidden = true;
    if (digits.length === 6 && !submitted) go();
    if (digits.length < 6) submitted = false;
  });

  const form = h(
    'form',
    {
      class: 'code-form',
      onsubmit: (e) => {
        e.preventDefault();
        go();
      },
    },
    input,
    h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Receive'),
  );

  const scanBtn = h(
    'button',
    {
      class: 'btn btn-secondary btn-block',
      type: 'button',
      onclick: async () => {
        const text = await scanQr();
        if (text) handleScanned(text, app, submitCode);
      },
    },
    icon('camera'),
    'Scan QR code',
  );

  return h(
    'section',
    { class: `card receive-card${compact ? ' compact' : ''}`, 'aria-labelledby': compact ? 'receive-title-c' : 'receive-title' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', { id: compact ? 'receive-title-c' : 'receive-title' }, 'Receive'),
      h('span', { class: 'chip' }, 'Code or QR'),
    ),
    h('p', { class: 'muted' }, 'Enter the 6-digit code shown on the sending device.'),
    form,
    errorEl,
    h('div', { class: 'divider' }, h('span', null, 'or')),
    scanBtn,
    h('p', { class: 'hint' }, icon('phone'), 'Tip: your phone’s camera app can scan the QR code directly.'),
  );
}

export function renderReceive(root, app, params) {
  const container = h('div', { class: 'receive-page' });
  root.append(container);
  const objectUrls = [];
  let active = null; // { abort } while receiving
  let disposed = false;

  const show = (...nodes) => {
    if (!disposed) container.replaceChildren(...nodes);
  };

  function showEnter(prefill, error) {
    show(
      h(
        'section',
        { class: 'hero hero-small' },
        h('h1', null, 'Receive'),
        h('p', { class: 'lede' }, 'Type the code or scan the QR code shown on the other device.'),
      ),
      h('div', { class: 'narrow' }, receiveCard(app, { onCode: openCode, error, prefill })),
    );
    container.querySelector('.code-input')?.focus();
  }

  function showLoading(text) {
    show(
      h(
        'section',
        { class: 'card narrow center-card', 'aria-busy': 'true' },
        h('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }),
        h('p', { class: 'loading-text' }, text),
      ),
    );
  }

  function showMessage(kind, title, text, actions = []) {
    show(
      h(
        'section',
        { class: 'card narrow center-card' },
        h('div', { class: `status-icon status-${kind} status-icon-lg` }, icon(kind === 'ok' ? 'check' : 'x')),
        h('h2', null, title),
        h('p', { class: 'muted' }, text),
        h('div', { class: 'actions-row' }, ...actions),
      ),
    );
  }

  const enterButton = () =>
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => app.navigate('/receive', { force: true }) }, 'Enter a code');

  function showEnded(status) {
    const reasons = {
      completed: 'It has already been received. One-time transfers can only be opened once.',
      expired: 'It has expired and the files were deleted.',
      revoked: 'The sender cancelled it.',
    };
    showMessage('error', 'This transfer is no longer available', reasons[status] || reasons.expired, [enterButton()]);
  }

  async function openCode(code) {
    showLoading('Finding the transfer…');
    try {
      const claim = await api.claim(await codeLookup(code));
      const rawKey = await openKeyWithCode(code, claim);
      // The page now behaves like the QR link: refresh and bookmarks keep working.
      app.replaceUrl(`/r/${claim.id}${location.search}#${toB64url(rawKey)}`);
      await loadOffer(claim.id, rawKey);
    } catch (err) {
      if (err.status === 404 || err.status === 429) showEnter(code, explain(err));
      else if (err.status === 410) showEnded(err.body?.status || 'completed');
      else showEnter(code, explain(err));
    }
  }

  async function openLink(id, keyText) {
    let rawKey;
    try {
      rawKey = fromB64url(keyText);
      if (rawKey.length !== 32) throw new Error('bad key');
    } catch {
      showMessage(
        'error',
        'This link is incomplete',
        'The part after the “#” is missing or damaged. Ask the sender to share the link again, or use the 6-digit code.',
        [enterButton()],
      );
      return;
    }
    await loadOffer(id, rawKey);
  }

  async function loadOffer(id, rawKey) {
    showLoading('Opening the transfer…');
    try {
      const info = await api.transfer(id);
      const key = await importFileKey(rawKey);
      let manifest;
      try {
        manifest = await decryptJson(key, info.manifest);
      } catch {
        showMessage('error', 'Can’t open this transfer', 'The link’s key doesn’t match. It may have been cut off when it was copied.', [enterButton()]);
        return;
      }
      showOffer({ id, info, key, manifest, received: 0, bytes: 0, token: null });
    } catch (err) {
      if (err.status === 410) showEnded(err.body?.status);
      else if (err.status === 404) showMessage('error', 'Transfer not found', 'Check that you have the full link, or enter the 6-digit code.', [enterButton()]);
      else showMessage('error', 'Something went wrong', explain(err), [enterButton()]);
    }
  }

  function fileRows(files, limit = 50) {
    const rows = files.slice(0, limit).map((f) =>
      h(
        'li',
        { class: 'file-row' },
        icon(fileIcon(f.type, f.name), 'file-icon'),
        h('span', { class: 'file-name', title: f.name }, f.name),
        h('span', { class: 'file-size' }, formatBytes(f.size)),
      ),
    );
    if (files.length > limit) rows.push(h('li', { class: 'file-row more' }, `+ ${files.length - limit} more`));
    return h('ul', { class: 'file-list' }, ...rows);
  }

  function summaryText(manifest) {
    const parts = [];
    if (manifest.files.length) parts.push(plural(manifest.files.length, 'file'), formatBytes(manifest.totalSize));
    if (manifest.text) parts.push(manifest.files.length ? 'message' : 'Message');
    return parts.join(' · ');
  }

  function showOffer(ctx) {
    const { info, manifest } = ctx;
    const textOnly = manifest.files.length === 0;
    const notes = [];
    if (info.mode === 'upload' && !info.uploadComplete) {
      notes.push(h('p', { class: 'note' }, icon('cloud'), 'The sender is still uploading. You can start now and it will stream in as it arrives.'));
    }
    if (info.mode === 'direct' && !info.hostOnline) {
      notes.push(h('p', { class: 'note note-warn' }, icon('phone'), 'The sender’s device seems to be offline. Ask them to keep the transfer page open.'));
    }
    if (info.downloadsLeft === 1) {
      notes.push(h('p', { class: 'note' }, icon('lock'), 'One-time transfer: after you accept, the link and code stop working.'));
    }
    const acceptBtn = h(
      'button',
      { class: 'btn btn-primary btn-lg', type: 'button', 'data-testid': 'accept', onclick: () => accept(ctx) },
      icon(textOnly ? 'eye' : 'download'),
      textOnly ? 'Accept & show message' : 'Accept & download',
    );
    show(
      h(
        'section',
        { class: 'card narrow offer-card', 'aria-labelledby': 'offer-title' },
        h(
          'div',
          { class: 'card-head' },
          h('h2', { id: 'offer-title' }, textOnly ? 'Incoming message' : 'Incoming transfer'),
          h('span', { class: `chip chip-${info.mode}` }, icon(info.mode === 'direct' ? 'bolt' : 'cloud'), info.mode === 'direct' ? 'Live' : 'Upload'),
        ),
        h('p', { class: 'muted' }, `${summaryText(manifest)} · expires ${formatWhen(info.expiresAt)}`),
        textOnly ? null : fileRows(manifest.files),
        manifest.text && !textOnly ? h('p', { class: 'note' }, icon('text'), 'Includes a message from the sender.') : null,
        ...notes,
        h(
          'div',
          { class: 'actions-row' },
          acceptBtn,
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.navigate('/receive', { force: true }) }, 'Decline'),
        ),
        h('p', { class: 'hint' }, icon('lock'), 'Decrypted on this device. Only you and the sender can see what’s inside.'),
      ),
    );
    acceptBtn.focus();
  }

  async function accept(ctx) {
    const { manifest, info } = ctx;
    const sink = ctx.sink || new BlobSink(manifest.files);
    ctx.sink = sink;
    const abort = new AbortController();
    active = { abort };
    const bar = progressBar('Download progress');
    const route = h('p', { class: 'muted route' });
    const meter = new SpeedMeter();
    let lastProgress = Date.now();
    const total = manifest.totalSize;
    const onProgress = () => {
      lastProgress = Date.now();
      meter.update(ctx.bytes);
      bar.set(total ? ctx.bytes / total : 1, `${formatBytes(ctx.bytes)} of ${formatBytes(total)}`, meter.describe(ctx.bytes, total));
    };
    const stall = setInterval(() => {
      if (Date.now() - lastProgress > 4000 && ctx.bytes < total) {
        bar.set(total ? ctx.bytes / total : 0, `${formatBytes(ctx.bytes)} of ${formatBytes(total)}`, 'Waiting for the sender…');
      }
    }, 1000);
    const setRoute = (kind) => {
      route.textContent =
        kind === 'connecting'
          ? 'Connecting to the sender…'
          : kind === 'direct'
            ? 'Direct device-to-device connection'
            : kind === 'relay'
              ? 'Relayed through the server · still end-to-end encrypted'
              : '';
    };

    show(
      h(
        'section',
        { class: 'card narrow receiving-card', 'aria-live': 'polite' },
        h('div', { class: 'card-head' }, h('h2', null, 'Receiving…'), h('span', { class: `chip chip-${info.mode}` }, icon(info.mode === 'direct' ? 'bolt' : 'cloud'), info.mode === 'direct' ? 'Live' : 'Upload')),
        h('p', { class: 'muted' }, summaryText(manifest)),
        bar.el,
        route,
        fileRows(manifest.files, 8),
        h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => abort.abort() }, 'Cancel')),
      ),
    );
    if (info.mode === 'direct') {
      bar.busy('Connecting…');
      setRoute('connecting');
    } else {
      onProgress();
    }

    try {
      if (info.mode === 'upload') await receiveUpload(ctx, sink, onProgress, abort.signal);
      else await receiveLive(ctx, sink, onProgress, abort.signal, setRoute);
      clearInterval(stall);
      showDone(ctx, sink.finish());
    } catch (err) {
      clearInterval(stall);
      if (disposed) return;
      if (abort.signal.aborted) {
        showMessage('error', 'Cancelled', 'Nothing more will be downloaded.', [enterButton()]);
        return;
      }
      const retry = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => accept(ctx) }, icon('refresh'), ctx.received ? 'Resume' : 'Try again');
      showMessage('error', 'Transfer interrupted', explain(err), [retry, enterButton()]);
    } finally {
      active = null;
    }
  }

  async function receiveUpload(ctx, sink, onProgress, signal) {
    if (!ctx.token) ctx.token = (await api.beginDownload(ctx.id)).token;
    const total = ctx.manifest.chunkCount;
    const fetchChunk = async (index) => {
      for (;;) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const data = await withRetry(() => api.getChunk(ctx.id, index, ctx.token, signal), { tries: 8, signal });
        if (data) {
          try {
            return await decryptChunk(ctx.key, index, data);
          } catch {
            throw new Error('Part of the file failed its integrity check, so it was not saved.');
          }
        }
        // 202: the sender hasn't uploaded this part yet; ask again (long-poll).
      }
    };
    for await (const plain of orderedMap(total, fetchChunk, DOWNLOAD_CONCURRENCY, ctx.received)) {
      sink.write(locateChunk(ctx.manifest, ctx.received).fileIndex, plain);
      ctx.received++;
      ctx.bytes += plain.length;
      onProgress();
    }
    await api.finishDownload(ctx.id, ctx.token).catch(() => {});
  }

  async function receiveLive(ctx, sink, onProgress, signal, setRoute) {
    const sig = new SignalClient();
    await sig.connect();
    let channel = null;
    try {
      const forceRelay = new URLSearchParams(location.search).has('relay') || !hasWebRtc;
      sig.send({ t: 'join', id: ctx.id, forceRelay });
      const reply = await sig.once('joined', 'error');
      if (reply.t === 'error') throw new Error(LIVE_ERRORS[reply.code] || 'Could not connect to the sender.');
      channel = await connectAsPeer(sig, { iceServers: reply.iceServers });
      setRoute(channel.kind);
      onProgress();
      const total = ctx.manifest.chunkCount;
      await new Promise((resolve, reject) => {
        let chain = Promise.resolve();
        let finished = false;
        const fail = (err) => {
          if (finished) return;
          finished = true;
          reject(err);
        };
        const complete = () => {
          if (finished) return;
          finished = true;
          channel.send(JSON.stringify({ t: 'done' }));
          sig.send({ t: 'complete' });
          resolve();
        };
        signal.addEventListener('abort', () => {
          try {
            channel.send(JSON.stringify({ t: 'cancel' }));
          } catch {
            // ignore
          }
          fail(new DOMException('Cancelled', 'AbortError'));
        });
        channel.onclose = () => fail(new Error('The connection to the sender was lost.'));
        sig.on('host-left', () => fail(new Error('The sender closed the page or lost their connection.')));
        sig.on('close', () => fail(new Error('Lost the connection to the server.')));
        sig.on('event', (m) => {
          if (m.kind === 'ended') fail(new Error('The sender cancelled the transfer.'));
        });
        channel.onmessage = (data) => {
          if (typeof data === 'string') return;
          chain = chain
            .then(async () => {
              if (finished) return;
              const index = new DataView(data, 0, 4).getUint32(0);
              if (index !== ctx.received) throw new Error('Received data out of order.');
              let plain;
              try {
                plain = await decryptChunk(ctx.key, index, new Uint8Array(data, 4));
              } catch {
                throw new Error('Part of the file failed its integrity check, so it was not saved.');
              }
              sink.write(locateChunk(ctx.manifest, index).fileIndex, plain);
              ctx.received++;
              ctx.bytes += plain.length;
              onProgress();
              if (ctx.received % 32 === 0 || ctx.received === total) {
                channel.send(JSON.stringify({ t: 'ack', next: ctx.received }));
              }
              if (ctx.received === total) complete();
            })
            .catch(fail);
        };
        channel.send(JSON.stringify({ t: 'start', from: ctx.received }));
        if (ctx.received >= total) complete();
      });
      await Promise.race([sig.once('complete-ack'), sleep(2500)]);
    } finally {
      channel?.close();
      sig.close();
    }
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const a = h('a', { href: url, download: safeName(name), class: 'sr-only' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function showDone(ctx, files) {
    const { manifest } = ctx;
    const cards = files.map((file) => {
      let preview = h('div', { class: 'preview preview-icon' }, icon(fileIcon(file.type, file.name)));
      if (file.size <= PREVIEW_MAX_BYTES && /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(file.type)) {
        const url = URL.createObjectURL(file.blob);
        objectUrls.push(url);
        preview = h('div', { class: 'preview' }, h('img', { src: url, alt: file.name, loading: 'lazy' }));
      } else if (file.size <= PREVIEW_MAX_BYTES && /^video\/(mp4|webm|quicktime)$/.test(file.type)) {
        const url = URL.createObjectURL(file.blob);
        objectUrls.push(url);
        preview = h('div', { class: 'preview' }, h('video', { src: url, controls: true, playsinline: true, preload: 'metadata' }));
      }
      return h(
        'li',
        { class: 'result' },
        preview,
        h(
          'div',
          { class: 'result-body' },
          h('span', { class: 'file-name', title: file.name }, file.name),
          h('span', { class: 'file-size' }, formatBytes(file.size)),
        ),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => saveBlob(file.blob, file.name) }, icon('download'), 'Save'),
      );
    });

    const zipBtn =
      files.length > 1 && canZip(files)
        ? h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              const label = btn.lastChild;
              const original = label.textContent;
              label.textContent = 'Preparing…';
              try {
                const entries = [];
                for (const f of files) entries.push({ ...f, crc: await crc32Blob(f.blob) });
                saveBlob(new Blob(buildZip(entries), { type: 'application/zip' }), `${app.config.appName.toLowerCase()}-files.zip`);
              } catch (err) {
                toast(explain(err), 'error');
              } finally {
                btn.disabled = false;
                label.textContent = original;
              }
            },
          },
          icon('archive'),
          h('span', null, 'Save all (.zip)'),
        )
        : null;

    const message = manifest.text
      ? h(
        'div',
        { class: 'message-box' },
        h('div', { class: 'message-head' }, h('span', { class: 'label' }, 'Message'), h('button', { class: 'link-btn', type: 'button', onclick: () => copyText(manifest.text, 'Message copied') }, icon('copy'), 'Copy')),
        h('p', { class: 'message-text', 'data-testid': 'message' }, manifest.text),
      )
      : null;

    show(
      h(
        'section',
        { class: 'card narrow done-card', 'aria-labelledby': 'done-title' },
        h('div', { class: 'done-head' }, h('div', { class: 'status-icon status-ok status-icon-lg' }, icon('check')), h('div', null, h('h2', { id: 'done-title', 'data-testid': 'done' }, 'Received'), h('p', { class: 'muted' }, summaryText(manifest)))),
        message,
        files.length ? h('ul', { class: 'results' }, ...cards) : null,
        h('div', { class: 'actions-row' }, zipBtn, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.navigate('/receive', { force: true }) }, 'Receive another')),
        files.length ? h('p', { class: 'hint' }, icon('lock'), 'Files stay on this page until you close it. Save them to keep them.') : null,
      ),
    );
    // A single file is saved straight away, like a normal download.
    if (files.length === 1) saveBlob(files[0].blob, files[0].name);
  }

  if (params.id) openLink(params.id, location.hash.slice(1));
  else if (app.pendingCode) {
    const code = app.pendingCode;
    app.pendingCode = null;
    openCode(code);
  } else showEnter();

  return {
    canLeave() {
      return !active || confirm('Stop receiving? The download will be cancelled.');
    },
    teardown() {
      disposed = true;
      active?.abort.abort();
      setTimeout(() => objectUrls.forEach((u) => URL.revokeObjectURL(u)), 1000);
    },
  };
}
