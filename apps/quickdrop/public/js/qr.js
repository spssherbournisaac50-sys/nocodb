import qrcode from '/vendor/qrcode.mjs';
import { h, icon } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function qrSvg(text, label = 'QR code') {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 2;
  const size = count + margin * 2;
  let d = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#0b0b14');
  svg.append(bg, path);
  return svg;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = h('script', { src });
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(s);
  });
}

async function createDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => {
          const codes = await detector.detect(video);
          return codes[0]?.rawValue || null;
        };
      }
    } catch {
      // fall through to jsQR
    }
  }
  await loadScript('/vendor/jsQR.js');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const hgt = Math.round(video.videoHeight * scale);
    if (!w || !hgt) return null;
    canvas.width = w;
    canvas.height = hgt;
    ctx.drawImage(video, 0, 0, w, hgt);
    const image = ctx.getImageData(0, 0, w, hgt);
    const found = window.jsQR(image.data, w, hgt, { inversionAttempts: 'attemptBoth' });
    return found?.data || null;
  };
}

// Opens a full-screen camera scanner. Resolves with the decoded text, or null if closed.
export function scanQr() {
  return new Promise((resolve) => {
    let stream = null;
    let stopped = false;
    let timer = null;

    const video = h('video', { class: 'scanner-video', playsinline: true, muted: true, autoplay: true });
    video.muted = true;
    const status = h('p', { class: 'scanner-status' }, 'Starting camera…');
    const closeBtn = h('button', { class: 'btn btn-ghost scanner-close', type: 'button', 'aria-label': 'Close scanner' }, icon('x'));
    const overlay = h(
      'div',
      { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scan a QR code' },
      h('div', { class: 'scanner-stage' }, video, h('div', { class: 'scanner-frame', 'aria-hidden': 'true' })),
      status,
      closeBtn,
    );

    const stop = (result) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result ?? null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') stop(null);
    };
    closeBtn.addEventListener('click', () => stop(null));
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    closeBtn.focus();

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera is not available in this browser. Type the 6-digit code instead.');
      }
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      const detect = await createDetector();
      status.textContent = 'Point the camera at the QR code';
      const tick = async () => {
        if (stopped) return;
        try {
          if (video.readyState >= 2) {
            const text = await detect(video);
            if (text) {
              stop(text);
              return;
            }
          }
        } catch {
          // keep scanning
        }
        timer = setTimeout(tick, 180);
      };
      tick();
    })().catch((err) => {
      const denied = err?.name === 'NotAllowedError';
      status.textContent = denied
        ? 'Camera permission was denied. Allow camera access or type the 6-digit code instead.'
        : err?.message || 'Could not start the camera.';
      overlay.classList.add('scanner-error');
    });
  });
}
