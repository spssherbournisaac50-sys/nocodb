import { api, explain, withRetry } from './api.js';
import { rememberTransfer } from './history.js';
import { qrSvg } from './qr.js';
import { receiveCard } from './receive.js';
import { DIRECT_CHUNK_SIZE, MAX_FILES, UPLOAD_CHUNK_SIZE, locateChunk, planChunks } from './shared/chunks.js';
import { formatCode, generateCode, sealKeyWithCode } from './shared/code.js';
import { encryptChunk, encryptJson, generateFileKey, importFileKey, toB64url } from './shared/crypto.js';
import { SignalClient } from './signal.js';
import { connectAsHost } from './transport.js';
import {
  SpeedMeter,
  copyText,
  fileIcon,
  formatBytes,
  formatCountdown,
  formatDuration,
  h,
  icon,
  isTouchDevice,
  orderedMap,
  plural,
  progressBar,
  sleep,
  toast,
} from './ui.js';

const MAX_TEXT = 20_000;
const LIVE_WINDOW = 256; // max unacknowledged frames in flight (~15 MB)
const LIVE_HIGH_WATER = 4 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

const EXPIRY_OPTIONS = [
  [1, '1 hour'],
  [6, '6 hours'],
  [24, '24 hours'],
  [72, '3 days'],
  [168, '7 days'],
];
const DOWNLOAD_OPTIONS = [1, 2, 3, 5, 10, 25, 50, 100];

// Reads plaintext chunks, batching small live-mode chunks into larger disk reads.
class ChunkReader {
  constructor(files, plan, blockChunks) {
    this.files = files;
    this.plan = plan;
    this.blockChunks = blockChunks;
    this.cache = null;
  }

  async read(index) {
    const { fileIndex } = locateChunk(this.plan, index);
    const entry = this.plan.files[fileIndex];
    const local = index - entry.firstChunk;
    const blockLocal = local - (local % this.blockChunks);
    const key = `${fileIndex}:${blockLocal}`;
    if (this.cache?.key !== key) {
      const start = blockLocal * this.plan.chunkSize;
      const end = Math.min(entry.size, start + this.blockChunks * this.plan.chunkSize);
      this.cache = {
        key,
        start,
        data: this.files[fileIndex].slice(start, end).arrayBuffer().then((b) => new Uint8Array(b)),
      };
    }
    const block = this.cache;
    const bytes = await block.data;
    const offset = local * this.plan.chunkSize - block.start;
    return bytes.subarray(offset, Math.min(offset + this.plan.chunkSize, bytes.length));
  }
}

async function buildFrame(key, index, plain) {
  const sealed = await encryptChunk(key, index, plain);
  const frame = new Uint8Array(4 + sealed.length);
  new DataView(frame.buffer).setUint32(0, index);
  frame.set(sealed, 4);
  return frame;
}

function bytesForChunks(plan, chunks) {
  if (chunks >= plan.chunkCount) return plan.totalSize;
  let bytes = 0;
  for (const f of plan.files) {
    if (chunks <= f.firstChunk) break;
    const inFile = Math.min(chunks - f.firstChunk, f.chunkCount);
    bytes += Math.min(f.size, inFile * plan.chunkSize);
  }
  return bytes;
}

function summarize(files, text) {
  const parts = [];
  if (files.length) parts.push(plural(files.length, 'file'), formatBytes(files.reduce((s, f) => s + f.size, 0)));
  if (text) parts.push(files.length ? '+ message' : 'Message');
  return parts.join(' · ');
}

function transferTitle(files, text) {
  if (!files.length) return text.slice(0, 60) || 'Message';
  return files.length === 1 ? files[0].name : `${files[0].name} + ${files.length - 1} more`;
}

export function renderSend(root, app) {
  const limits = app.config.limits;
  const state = {
    files: [],
    text: '',
    mode: 'direct',
    ttlHours: Math.min(24, limits.maxHours),
    maxDownloads: 1,
  };
  let session = null;
  const cleanups = [];

  // ---------- Compose ----------
  const fileInput = h('input', {
    type: 'file',
    multiple: true,
    class: 'sr-only',
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: () => {
      addFiles(fileInput.files);
      fileInput.value = '';
    },
  });

  const dropzone = h(
    'button',
    { class: 'dropzone', type: 'button', onclick: () => fileInput.click() },
    h('span', { class: 'dz-icon' }, icon('upload')),
    h('span', { class: 'dz-title' }, 'Choose files'),
    h(
      'span',
      { class: 'dz-sub' },
      isTouchDevice() ? 'Photos, videos, documents, anything' : 'or drop them here · paste with Ctrl+V',
    ),
  );

  const fileList = h('ul', { class: 'file-list', 'aria-label': 'Selected files' });
  const fileSummary = h('div', { class: 'file-summary' });
  const textArea = h('textarea', {
    class: 'text-input',
    rows: 3,
    maxLength: MAX_TEXT,
    placeholder: 'Add a message, link or any text (optional)',
    'aria-label': 'Message or text to send',
    oninput: () => {
      state.text = textArea.value;
      update();
    },
  });

  const modeInfo = {
    direct: {
      icon: 'bolt',
      title: 'Live',
      desc: 'Device to device. Fastest, no size limit, nothing stored. Keep this tab open until it’s received.',
    },
    upload: {
      icon: 'cloud',
      title: 'Upload',
      desc: `They can download it any time before it expires. Up to ${formatBytes(limits.maxBytes)}.`,
    },
  };
  const modeButtons = {};
  const modeDesc = h('p', { class: 'mode-desc' });
  const modeGroup = h(
    'div',
    { class: 'seg', role: 'radiogroup', 'aria-label': 'Delivery mode' },
    ...['direct', 'upload'].map((mode) => {
      const btn = h(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: 'seg-btn',
          dataset: { mode },
          onclick: () => {
            state.mode = mode;
            update();
          },
        },
        icon(modeInfo[mode].icon),
        modeInfo[mode].title,
      );
      modeButtons[mode] = btn;
      return btn;
    }),
  );

  const expirySelect = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Expires after',
      onchange: () => {
        state.ttlHours = Number(expirySelect.value);
      },
    },
    ...EXPIRY_OPTIONS.filter(([hrs]) => hrs <= limits.maxHours).map(([hrs, label]) =>
      h('option', { value: String(hrs), selected: hrs === state.ttlHours }, label),
    ),
  );
  const downloadsSelect = h(
    'select',
    {
      class: 'select',
      'aria-label': 'How many times it can be received',
      onchange: () => {
        state.maxDownloads = Number(downloadsSelect.value);
      },
    },
    ...DOWNLOAD_OPTIONS.filter((n) => n <= limits.maxDownloads).map((n) =>
      h('option', { value: String(n), selected: n === state.maxDownloads }, n === 1 ? 'Once (one-time)' : `${n} times`),
    ),
  );
  const expiryField = h('label', { class: 'field-inline' }, h('span', null, 'Expires'), expirySelect);
  const options = h(
    'div',
    { class: 'options' },
    expiryField,
    h('label', { class: 'field-inline' }, h('span', null, 'Can be received'), downloadsSelect),
  );
  const modeBlock = h('div', { class: 'mode-block' }, h('div', { class: 'label' }, 'Delivery'), modeGroup, modeDesc, options);

  const warning = h('p', { class: 'inline-warning', role: 'alert', hidden: true });
  const cta = h(
    'button',
    { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: () => start() },
    icon('qr'),
    h('span', null, 'Get QR code & 6-digit code'),
  );
  const ctaNote = h('p', { class: 'cta-note' }, icon('lock'), 'No sign-up · End-to-end encrypted · Free');

  const composeCard = h(
    'section',
    { class: 'card send-card', 'aria-labelledby': 'send-title' },
    h('div', { class: 'card-head' }, h('h2', { id: 'send-title' }, 'Send'), h('span', { class: 'chip' }, 'Files & text')),
    fileInput,
    dropzone,
    fileSummary,
    fileList,
    textArea,
    modeBlock,
    warning,
    cta,
    ctaNote,
  );

  function addFiles(list) {
    const incoming = [...(list || [])];
    if (!incoming.length) return;
    const room = MAX_FILES - state.files.length;
    if (incoming.length > room) toast(`You can send up to ${MAX_FILES} files at once`, 'error');
    state.files.push(...incoming.slice(0, Math.max(0, room)));
    update();
  }

  function renderFiles() {
    fileList.replaceChildren(
      ...state.files.map((file, index) =>
        h(
          'li',
          { class: 'file-row' },
          icon(fileIcon(file.type, file.name), 'file-icon'),
          h('span', { class: 'file-name', title: file.name }, file.name),
          h('span', { class: 'file-size' }, formatBytes(file.size)),
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              'aria-label': `Remove ${file.name}`,
              onclick: () => {
                state.files.splice(index, 1);
                update();
              },
            },
            icon('x'),
          ),
        ),
      ),
    );
    if (state.files.length) {
      fileSummary.replaceChildren(
        h('span', null, summarize(state.files, '')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'link-btn', type: 'button', onclick: () => fileInput.click() }, icon('plus'), 'Add more'),
        h(
          'button',
          {
            class: 'link-btn',
            type: 'button',
            onclick: () => {
              state.files = [];
              update();
            },
          },
          'Clear',
        ),
      );
    } else {
      fileSummary.replaceChildren();
    }
    dropzone.classList.toggle('compact', state.files.length > 0);
  }

  function update() {
    renderFiles();
    const hasFiles = state.files.length > 0;
    const hasText = state.text.trim().length > 0;
    const mode = hasFiles ? state.mode : 'upload';
    for (const [m, btn] of Object.entries(modeButtons)) {
      btn.setAttribute('aria-checked', String(m === state.mode));
      btn.classList.toggle('active', m === state.mode);
    }
    modeBlock.hidden = !hasFiles;
    modeDesc.textContent = modeInfo[state.mode].desc;
    expiryField.hidden = mode !== 'upload';

    const total = state.files.reduce((s, f) => s + f.size, 0);
    let problem = '';
    if (mode === 'upload' && total > limits.maxBytes) {
      problem = `Upload mode is limited to ${formatBytes(limits.maxBytes)}${
        app.user ? '' : ' (more with a free account)'
      }. Use Live mode to send any size.`;
    }
    warning.hidden = !problem;
    warning.textContent = problem;
    cta.disabled = Boolean(problem) || (!hasFiles && !hasText);
  }

  // Drag & drop and paste.
  const onDragOver = (e) => {
    if (session || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    composeCard.classList.add('dragging');
  };
  const onDragLeave = (e) => {
    if (e.target === document.documentElement || !e.relatedTarget) composeCard.classList.remove('dragging');
  };
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    composeCard.classList.remove('dragging');
    if (!session) addFiles(e.dataTransfer.files);
  };
  const onPaste = (e) => {
    if (session) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  window.addEventListener('paste', onPaste);
  cleanups.push(() => {
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
    window.removeEventListener('paste', onPaste);
  });

  // ---------- Page layout ----------
  const hero = h(
    'section',
    { class: 'hero' },
    h('h1', null, 'Send files anywhere. ', h('span', { class: 'grad-text' }, 'Instantly.')),
    h(
      'p',
      { class: 'lede' },
      'No sign-up, no app. Pick files or type a message, then scan the QR code or enter the 6-digit code on the other device.',
    ),
  );
  const workArea = h('div', { class: 'work-area' }, composeCard, receiveCard(app, { compact: true }));
  const info = infoSections(app);
  root.append(hero, workArea, info);
  update();

  // ---------- Transfer session ----------
  async function start() {
    const files = [...state.files];
    const text = state.text.trim();
    const mode = files.length ? state.mode : 'upload';
    cta.disabled = true;
    const ctaLabel = cta.querySelector('span:last-child');
    ctaLabel.textContent = 'Encrypting…';
    try {
      const chunkSize = mode === 'upload' ? UPLOAD_CHUNK_SIZE : DIRECT_CHUNK_SIZE;
      const plan = planChunks(files, chunkSize);
      const rawKey = generateFileKey();
      const key = await importFileKey(rawKey);
      const encrypted = await encryptJson(key, { v: 1, ...plan, text, sentAt: Date.now() });
      let created;
      let code;
      for (let attempt = 0; ; attempt++) {
        code = generateCode();
        const sealed = await sealKeyWithCode(code, rawKey);
        try {
          created = await api.createTransfer({
            mode,
            manifest: encrypted,
            chunkSize,
            chunkCount: plan.chunkCount,
            totalSize: plan.totalSize,
            ttlHours: mode === 'upload' ? state.ttlHours : limits.maxHours,
            maxDownloads: state.maxDownloads,
            code: sealed,
          });
          break;
        } catch (err) {
          if (err.code !== 'code_taken' || attempt >= 4) throw err;
        }
      }
      const link = `${location.origin}/r/${created.id}#${toB64url(rawKey)}`;
      rememberTransfer({
        id: created.id,
        title: transferTitle(files, text),
        summary: summarize(files, text),
        mode,
        link,
        manageToken: created.manageToken,
        createdAt: Date.now(),
        expiresAt: created.expiresAt,
      });
      session = { ...created, code, codeState: 'active', link, mode, files, text, plan, key, rawKey };
      showShare(session);
    } catch (err) {
      toast(explain(err), 'error');
      ctaLabel.textContent = 'Get QR code & 6-digit code';
      update();
    }
  }

  function showShare(s) {
    s.abort = new AbortController();
    s.ended = false;
    s.delivered = 0;
    s.uploading = false;
    s.uploaded = new Set();

    // --- share panel ---
    const codeValue = h('div', { class: 'code-value', 'data-testid': 'share-code', 'aria-label': formatCode(s.code) });
    const showCode = () => {
      codeValue.replaceChildren(h('span', null, s.code.slice(0, 3)), h('span', null, s.code.slice(3)));
      codeValue.setAttribute('aria-label', `Code ${formatCode(s.code)}`);
    };
    showCode();
    const codeState = h('span', { class: 'code-state' });
    const codeMeta = h('span', { class: 'code-meta' });
    const newCodeBtn = h('button', { class: 'link-btn', type: 'button', onclick: () => regenerate() }, icon('refresh'), 'New code');
    const linkInput = h('input', {
      class: 'link-input',
      readOnly: true,
      value: s.link,
      'aria-label': 'Transfer link',
      'data-testid': 'share-link',
      onfocus: (e) => e.target.select(),
    });
    const shareBtn = navigator.share
      ? h(
        'button',
        {
          class: 'btn btn-secondary',
          type: 'button',
          onclick: () => navigator.share({ title: `${app.config.appName} transfer`, url: s.link }).catch(() => {}),
        },
        icon('share'),
        'Share',
      )
      : null;

    const qrBox = h('div', { class: 'qr-box' }, qrSvg(s.link, 'QR code for this transfer'));
    const shareTitle = h('h2', { id: 'share-title' }, 'Ready to send');
    const statusIcon = h('div', { class: 'status-icon' });
    const statusTitle = h('h3', { class: 'status-title', 'data-testid': 'send-status' });
    const statusSub = h('p', { class: 'status-sub' });
    const uploadBar = progressBar('Upload progress');
    const deliveryBar = progressBar('Delivery progress');
    deliveryBar.el.hidden = true;
    uploadBar.el.hidden = s.mode !== 'upload' || s.plan.chunkCount === 0;
    const retryBtn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', hidden: true, onclick: () => upload() }, icon('refresh'), 'Resume upload');
    const timeline = h('ol', { class: 'timeline', 'aria-label': 'Activity' });
    const cancelBtn = h('button', { class: 'btn btn-ghost btn-danger', type: 'button', onclick: () => cancel() }, 'Cancel transfer');
    const againBtn = h('button', { class: 'btn btn-primary', type: 'button', hidden: true, onclick: () => app.navigate('/', { force: true }) }, icon('plus'), 'Send something else');

    const modeLabel = s.mode === 'direct' ? 'Live' : `Upload · expires ${formatDuration((s.expiresAt - Date.now()) / 1000)}`;
    const shareCard = h(
      'section',
      { class: 'card share-card', 'aria-labelledby': 'share-title' },
      h(
        'div',
        { class: 'share-head' },
        h('div', null,
          shareTitle,
          h('p', { class: 'muted' }, [summarize(s.files, s.text), modeLabel, s.maxDownloads === 1 ? 'One-time' : `${s.maxDownloads} receivers`].join(' · ')),
        ),
        h('span', { class: `chip chip-${s.mode}` }, icon(s.mode === 'direct' ? 'bolt' : 'cloud'), s.mode === 'direct' ? 'Live' : 'Upload'),
      ),
      h(
        'div',
        { class: 'share-grid' },
        h('div', { class: 'share-qr' }, qrBox, h('p', { class: 'qr-caption' }, icon('phone'), 'Scan with the other device’s camera')),
        h(
          'div',
          { class: 'share-details' },
          h('div', { class: 'label' }, 'Or enter this code on the other device'),
          h(
            'div',
            { class: 'code-row' },
            codeValue,
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copy code', onclick: () => copyText(s.code, 'Code copied') }, icon('copy')),
          ),
          h('div', { class: 'code-line' }, codeState, codeMeta, newCodeBtn),
          h('div', { class: 'label' }, 'Or share the link'),
          h(
            'div',
            { class: 'link-row' },
            linkInput,
            h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => copyText(s.link, 'Link copied') }, icon('copy'), 'Copy'),
            shareBtn,
          ),
          h('p', { class: 'hint' }, icon('globe'), 'Works on any device with a browser, anywhere in the world.'),
        ),
      ),
      h(
        'div',
        { class: 'share-status', 'aria-live': 'polite' },
        h('div', { class: 'status-line' }, statusIcon, h('div', null, statusTitle, statusSub)),
        uploadBar.el,
        retryBtn,
        deliveryBar.el,
        timeline,
      ),
      h('div', { class: 'share-actions' }, cancelBtn, againBtn),
    );

    workArea.replaceChildren(shareCard);
    hero.hidden = true;
    info.hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    function setStatus(kind, title, sub = '') {
      statusIcon.className = `status-icon status-${kind}`;
      statusIcon.replaceChildren(
        icon(kind === 'ok' ? 'check' : kind === 'error' ? 'x' : kind === 'live' ? 'bolt' : 'phone'),
      );
      statusTitle.textContent = title;
      statusSub.textContent = sub;
    }

    function log(text, kind = 'info') {
      timeline.prepend(
        h(
          'li',
          { class: `tl-${kind}` },
          h('time', null, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
          h('span', null, text),
        ),
      );
    }

    function waiting() {
      if (s.ended) return;
      const left = s.maxDownloads - s.delivered;
      if (s.mode === 'direct') {
        setStatus(
          'wait',
          s.delivered ? `Delivered. Waiting for the next device (${left} left)` : 'Waiting for the other device…',
          'Keep this tab open. The transfer starts as soon as they scan or enter the code.',
        );
      } else {
        setStatus(
          'wait',
          s.delivered ? `Delivered. Can be received ${plural(left, 'more time')}` : 'Waiting for the other device…',
          'Scan the QR code or enter the code on the receiving device.',
        );
      }
    }

    function renderCode() {
      const left = (s.codeExpiresAt || 0) - Date.now();
      if (s.codeState === 'active' && left <= 0) s.codeState = 'expired';
      codeValue.classList.toggle('is-off', s.codeState !== 'active');
      codeState.className = `code-state state-${s.codeState}`;
      codeState.textContent = s.codeState === 'active' ? '' : s.codeState === 'used' ? 'Code used' : 'Code expired';
      codeMeta.textContent = s.codeState === 'active' ? `Expires in ${formatCountdown(left)}` : '';
      newCodeBtn.hidden = s.ended;
    }
    renderCode();
    const ticker = setInterval(renderCode, 1000);

    async function regenerate() {
      newCodeBtn.disabled = true;
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = generateCode();
          const sealed = await sealKeyWithCode(code, s.rawKey);
          try {
            const res = await api.newCode(s.id, s.manageToken, sealed);
            s.code = code;
            s.codeExpiresAt = res.codeExpiresAt;
            s.codeState = 'active';
            showCode();
            renderCode();
            log('New code created');
            return;
          } catch (err) {
            if (err.code !== 'code_taken') throw err;
          }
        }
      } catch (err) {
        toast(explain(err), 'error');
      } finally {
        newCodeBtn.disabled = false;
      }
    }

    async function cancel() {
      if (!confirm('Cancel this transfer? The QR code, link and code will stop working.')) return;
      try {
        await api.revoke(s.id, s.manageToken);
      } catch (err) {
        if (err.status !== 410) toast(explain(err), 'error');
      }
      finish('revoked');
    }

    function finish(status) {
      if (s.ended) return;
      s.ended = true;
      s.abort.abort();
      s.peerAbort?.abort();
      s.channel?.close();
      s.signal?.close();
      clearInterval(ticker);
      shareCard.classList.add('is-ended');
      cancelBtn.hidden = true;
      againBtn.hidden = false;
      newCodeBtn.hidden = true;
      retryBtn.hidden = true;
      const messages = {
        completed: ['ok', 'Delivered', s.maxDownloads === 1 ? 'Your files were received. The link and code no longer work.' : 'All downloads used. The link and code no longer work.'],
        expired: ['error', 'This transfer has expired', s.mode === 'direct' ? 'The live session ended.' : 'The files were deleted from the server.'],
        revoked: ['error', 'Transfer cancelled', 'The QR code, link and code no longer work.'],
        replaced: ['error', 'Opened in another tab', 'This transfer is now being sent from another tab.'],
      };
      const [kind, title, sub] = messages[status] || messages.expired;
      setStatus(kind, title, sub);
      if (status === 'completed') {
        deliveryBar.el.hidden = false;
        deliveryBar.done('Received');
      }
      shareTitle.textContent = status === 'completed' ? 'Sent' : 'Transfer ended';
      if (status !== 'completed' || !s.delivered) log(title, kind === 'ok' ? 'ok' : 'warn');
      codeState.textContent = '';
      codeMeta.textContent = '';
    }

    function onEvent(m) {
      switch (m.kind) {
        case 'code-used':
          log(`Code entered on ${m.device}`);
          if (!m.codeActive) s.codeState = 'used';
          renderCode();
          break;
        case 'code-expired':
          if (s.codeState === 'active') s.codeState = 'expired';
          renderCode();
          break;
        case 'download-started':
          log(`Download started on ${m.device}`);
          setStatus('live', `Receiving on ${m.device}`, '');
          deliveryBar.el.hidden = false;
          deliveryBar.set(0, 'Delivered', '0%');
          break;
        case 'download-progress': {
          const pct = m.chunks / m.chunkCount;
          deliveryBar.el.hidden = false;
          deliveryBar.set(pct, `Delivered to ${m.device}`, `${Math.round(pct * 100)}%`);
          break;
        }
        case 'download-complete':
          s.delivered++;
          log(`Delivered to ${m.device}`, 'ok');
          deliveryBar.done(`Delivered to ${m.device}`);
          waiting();
          break;
        case 'ended':
          finish(m.status);
          break;
        default:
          break;
      }
    }

    // --- signaling with auto-reconnect ---
    async function connect() {
      let delay = 1000;
      let first = true;
      while (!s.ended) {
        try {
          const sig = new SignalClient();
          await sig.connect();
          if (s.ended) {
            sig.close();
            return;
          }
          s.signal = sig;
          sig.on('event', onEvent);
          sig.on('replaced', () => finish('replaced'));
          sig.on('peer-joined', (m) => servePeer(m));
          sig.on('peer-left', () => s.peerAbort?.abort());
          sig.on('peer-complete', (m) => {
            s.delivered = m.downloads;
            if (!m.exhausted) waiting();
          });
          const closed = sig.once('close');
          sig.send({ t: 'host', id: s.id, token: s.manageToken });
          const reply = await Promise.race([sig.once('hosted', 'error', 'event'), closed]);
          if (reply?.t === 'hosted') {
            if (!first) log('Reconnected');
            first = false;
            delay = 1000;
            if (!s.active) waiting();
          }
          await closed;
          if (s.ended) return;
          s.peerAbort?.abort();
          setStatus('wait', 'Reconnecting…', 'Lost the connection to the server. Retrying.');
        } catch {
          if (s.ended) return;
          setStatus('wait', 'Reconnecting…', 'Can’t reach the server. Check your connection.');
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
      }
    }

    // --- Live mode: stream to the receiver ---
    async function servePeer(m) {
      if (s.active || s.ended) return;
      s.active = true;
      const peerAbort = new AbortController();
      s.peerAbort = peerAbort;
      log(`${m.device} connected`);
      setStatus('live', `Connecting to ${m.device}…`, 'Setting up a direct connection');
      deliveryBar.el.hidden = false;
      deliveryBar.busy('Connecting…');
      try {
        const channel = await connectAsHost(s.signal, {
          iceServers: app.config.iceServers,
          relayEnabled: app.config.relayEnabled,
          forceRelay: m.forceRelay,
        });
        s.channel = channel;
        if (peerAbort.signal.aborted) throw new Error('The receiver disconnected');
        const route = channel.kind === 'direct' ? 'Direct device-to-device connection' : 'Relayed through the server, still end-to-end encrypted';
        setStatus('live', `Sending to ${m.device}`, route);
        log(channel.kind === 'direct' ? 'Connected directly' : 'Connected via relay');
        const meter = new SpeedMeter();
        await streamFrames(channel, peerAbort.signal, (acked) => {
          const bytes = bytesForChunks(s.plan, acked);
          meter.update(bytes);
          deliveryBar.set(
            s.plan.totalSize ? bytes / s.plan.totalSize : 1,
            `${formatBytes(bytes)} of ${formatBytes(s.plan.totalSize)}`,
            meter.describe(bytes, s.plan.totalSize),
          );
        });
        deliveryBar.done(`Delivered to ${m.device}`);
        log(`Delivered to ${m.device}`, 'ok');
      } catch (err) {
        if (!s.ended) {
          log(`Stopped: ${explain(err)}`, 'warn');
          deliveryBar.el.hidden = true;
        }
      } finally {
        s.channel?.close();
        s.channel = null;
        s.active = false;
        if (!s.ended) waiting();
      }
    }

    function streamFrames(channel, abortSignal, onProgress) {
      return new Promise((resolve, reject) => {
        const total = s.plan.chunkCount;
        let acked = 0;
        let started = false;
        let settled = false;
        let wake = null;
        const settle = (err) => {
          if (settled) return;
          settled = true;
          const w = wake;
          wake = null;
          w?.();
          if (err) reject(err);
          else resolve();
        };
        abortSignal.addEventListener('abort', () => settle(new Error('The receiver disconnected')));
        s.abort.signal.addEventListener('abort', () => settle(new Error('Cancelled')));
        channel.onclose = () => settle(new Error('Connection lost'));
        channel.onmessage = (data) => {
          if (typeof data !== 'string') return;
          let msg;
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }
          if (msg.t === 'start' && !started) {
            started = true;
            pump(Math.max(0, Math.min(total, msg.from | 0))).catch(settle);
          } else if (msg.t === 'ack') {
            acked = Math.max(acked, msg.next | 0);
            onProgress(acked);
            const w = wake;
            wake = null;
            w?.();
          } else if (msg.t === 'done') {
            onProgress(total);
            settle();
          } else if (msg.t === 'cancel') {
            settle(new Error('The receiver cancelled'));
          }
        };

        async function pump(from) {
          acked = from;
          const reader = new ChunkReader(s.files, s.plan, 16);
          const frames = orderedMap(total, async (i) => buildFrame(s.key, i, await reader.read(i)), 6, from);
          let i = from;
          for await (const frame of frames) {
            while (!settled && i - acked >= LIVE_WINDOW) await new Promise((r) => { wake = r; });
            while (!settled && channel.bufferedAmount > LIVE_HIGH_WATER) await sleep(4);
            if (settled) return;
            channel.send(frame);
            i++;
          }
        }
      });
    }

    // --- Upload mode: encrypt and upload chunks ---
    async function upload() {
      const total = s.plan.chunkCount;
      if (!total) {
        log('Message ready');
        return;
      }
      s.uploading = true;
      retryBtn.hidden = true;
      const meter = new SpeedMeter();
      let doneBytes = [...s.uploaded].reduce((sum, i) => {
        const { start, end } = locateChunk(s.plan, i);
        return sum + (end - start);
      }, 0);
      const pending = [];
      for (let i = 0; i < total; i++) if (!s.uploaded.has(i)) pending.push(i);
      let cursor = 0;
      const signal = s.abort.signal;
      const report = () => {
        meter.update(doneBytes);
        uploadBar.set(
          doneBytes / s.plan.totalSize,
          `Encrypting & uploading · ${formatBytes(doneBytes)} of ${formatBytes(s.plan.totalSize)}`,
          meter.describe(doneBytes, s.plan.totalSize),
        );
      };
      report();
      const worker = async () => {
        while (cursor < pending.length && !signal.aborted) {
          const index = pending[cursor++];
          const { fileIndex, start, end } = locateChunk(s.plan, index);
          const plain = new Uint8Array(await s.files[fileIndex].slice(start, end).arrayBuffer());
          const sealed = await encryptChunk(s.key, index, plain);
          await withRetry(() => api.putChunk(s.id, index, s.manageToken, sealed, signal), { tries: 10, signal });
          s.uploaded.add(index);
          doneBytes += plain.length;
          report();
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, worker));
        if (!signal.aborted) {
          uploadBar.done('Uploaded · the receiver can download any time');
          log('Upload finished', 'ok');
        }
      } catch (err) {
        if (signal.aborted || s.ended) return;
        if (err.status === 410) return;
        uploadBar.set(doneBytes / s.plan.totalSize, 'Upload paused', explain(err));
        retryBtn.hidden = false;
        toast(`Upload paused: ${explain(err)}`, 'error');
      } finally {
        s.uploading = false;
      }
    }

    setStatus('wait', 'Waiting for the other device…', '');
    log(s.mode === 'direct' ? 'Live transfer ready' : 'Transfer created');
    connect();
    if (s.mode === 'upload') upload();
    cleanups.push(() => {
      clearInterval(ticker);
      s.ended = true;
      s.abort.abort();
      s.peerAbort?.abort();
      s.channel?.close();
      s.signal?.close();
    });
  }

  const onBeforeUnload = (e) => {
    if (needsTab()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

  function needsTab() {
    return Boolean(session && !session.ended && (session.mode === 'direct' || session.uploading));
  }

  return {
    canLeave() {
      if (!needsTab()) return true;
      return confirm(
        session.mode === 'direct'
          ? 'Leave this page? The live transfer stops when you leave.'
          : 'Leave this page? The upload is not finished yet.',
      );
    },
    teardown() {
      cleanups.forEach((fn) => fn());
    },
  };
}

function infoSections(app) {
  const step = (n, iconName, title, text) =>
    h('li', { class: 'step' }, h('span', { class: 'step-num' }, String(n)), h('span', { class: 'step-icon' }, icon(iconName)), h('h3', null, title), h('p', null, text));
  const feature = (iconName, title, text) =>
    h('li', { class: 'feature' }, h('span', { class: 'feature-icon' }, icon(iconName)), h('div', null, h('h3', null, title), h('p', null, text)));
  const faq = (q, a) => h('details', { class: 'faq-item' }, h('summary', null, q), h('p', null, a));
  const plans = app.config.plans;

  return h(
    'div',
    { class: 'info' },
    h(
      'section',
      { class: 'how', 'aria-labelledby': 'how-title' },
      h('h2', { id: 'how-title', class: 'section-title' }, 'How it works'),
      h(
        'ol',
        { class: 'steps' },
        step(1, 'upload', 'Send', 'Choose files or type text. Photos, videos, documents, anything.'),
        step(2, 'qr', 'Connect', 'A QR code and a 6-digit code appear. Scan it, or type the code on the other device.'),
        step(3, 'download', 'Receive', 'Tap Accept and the transfer starts instantly, with live progress on both screens.'),
      ),
    ),
    h(
      'section',
      { class: 'features', 'aria-label': 'Why QuickDrop' },
      h(
        'ul',
        { class: 'feature-grid' },
        feature('lock', 'End-to-end encrypted', 'Files are encrypted on your device. The key travels inside the QR code and link, never to our server.'),
        feature('user', 'No sign-up', 'No account, email or phone number needed. An optional free account adds bigger limits.'),
        feature('zap', 'Live or upload', 'Live goes straight from device to device with no size limit. Upload lets them grab it later.'),
        feature('globe', 'Any device, anywhere', 'Phone, tablet or computer, on any network around the world. Just a browser.'),
      ),
    ),
    h(
      'section',
      { class: 'faq', 'aria-labelledby': 'faq-title' },
      h('h2', { id: 'faq-title', class: 'section-title' }, 'Questions'),
      faq('Is it really free?', 'Yes. Sending and receiving is free with no sign-up. An optional free account raises the limits.'),
      faq(
        'How big can files be?',
        `Live transfers have no size limit, because files go straight between the devices. Upload mode holds up to ${formatBytes(plans.anonymous.maxBytes)} for ${plans.anonymous.maxHours} hours, or ${formatBytes(plans.account.maxBytes)} for up to ${Math.round(plans.account.maxHours / 24)} days with an account.`,
      ),
      faq(
        'Who can see my files?',
        'Only whoever has the QR code, link or 6-digit code. Files are encrypted in your browser with a random key. Our server only stores scrambled data and deletes it after the download or when it expires.',
      ),
      faq(
        'How does the 6-digit code work?',
        `The code is valid for ${app.config.codeTtlMinutes} minutes and works only once for one-time transfers. Wrong guesses are rate-limited. Need more time? Tap “New code”.`,
      ),
      faq(
        'Do both devices need to be online?',
        'For Live transfers, yes: keep the page open until the other device has received everything. With Upload mode you can close the page after the upload finishes.',
      ),
    ),
  );
}
