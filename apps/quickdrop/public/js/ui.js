// Tiny DOM + formatting helpers. All user-provided text goes through text nodes,
// never innerHTML, so file names and messages cannot inject markup.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'html') el.innerHTML = value; // trusted static markup only (icons)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (typeof value !== 'string' && key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  upload: '<path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 9"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  share: '<path d="M12 3v12M12 3 8 7m4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h3v3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.7-4.4L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14.7 4.4L20 16"/><path d="M20 20v-4h-4"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};

export function icon(name, cls = '') {
  return h('span', {
    class: `icon ${cls}`.trim(),
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.file}</svg>`,
  });
}

export function fileIcon(type = '', name = '') {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (/zip|rar|7z|tar|gzip|compressed/.test(type) || /\.(zip|rar|7z|tar|gz)$/i.test(name)) return 'archive';
  if (type.startsWith('text/')) return 'text';
  return 'file';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return 'less than a second';
  if (seconds < 60) return `${Math.round(seconds)}\u00a0s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}\u00a0min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours}\u00a0h ${rest}\u00a0min` : `${hours}\u00a0h`;
  return `${Math.round(hours / 24)}\u00a0days`;
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatWhen(timestamp) {
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff) / 1000;
  const text = formatDuration(abs);
  if (abs < 45) return diff > 0 ? 'in a moment' : 'just now';
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export class SpeedMeter {
  constructor() {
    this.samples = [];
  }

  update(bytes) {
    const now = performance.now();
    this.samples.push({ t: now, bytes });
    while (this.samples.length > 2 && now - this.samples[0].t > 4000) this.samples.shift();
  }

  get bytesPerSecond() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    return dt > 0.25 ? (last.bytes - first.bytes) / dt : 0;
  }

  describe(done, total) {
    const speed = this.bytesPerSecond;
    if (!speed) return '';
    const eta = (total - done) / speed;
    const parts = [`${formatBytes(speed)}/s`];
    if (total > done && Number.isFinite(eta)) parts.push(`${formatDuration(eta)} left`);
    return parts.join(' · ');
  }
}

export function progressBar(label = '') {
  const fill = h('div', { class: 'progress-fill' });
  const track = h('div', {
    class: 'progress-track',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-label': label,
  }, fill);
  const title = h('span', { class: 'progress-title' });
  const detail = h('span', { class: 'progress-detail' });
  const el = h('div', { class: 'progress' }, h('div', { class: 'progress-labels' }, title, detail), track);
  return {
    el,
    set(fraction, titleText, detailText = '') {
      const pct = Math.max(0, Math.min(1, fraction)) * 100;
      fill.style.width = `${pct}%`;
      track.setAttribute('aria-valuenow', String(Math.round(pct)));
      track.classList.remove('indeterminate');
      if (titleText != null) title.textContent = titleText;
      detail.textContent = detailText;
    },
    busy(titleText, detailText = '') {
      track.classList.add('indeterminate');
      track.removeAttribute('aria-valuenow');
      title.textContent = titleText;
      detail.textContent = detailText;
    },
    done(titleText) {
      this.set(1, titleText);
      el.classList.add('is-done');
    },
  };
}

export function toast(message, type = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast toast-${type}` }, message);
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 6000 : 3200);
}

export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { class: 'sr-only', readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  }
  toast(`${what} to clipboard`, 'success');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Concurrently maps 0..count-1 with bounded read-ahead, yielding results in order.
export async function* orderedMap(count, fn, concurrency, start = 0) {
  const inflight = new Map();
  let next = start;
  for (let i = start; i < count; i++) {
    while (next < count && inflight.size < concurrency) {
      const promise = fn(next);
      promise.catch(() => {});
      inflight.set(next, promise);
      next++;
    }
    const value = await inflight.get(i);
    inflight.delete(i);
    yield value;
  }
}

export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches;
}
