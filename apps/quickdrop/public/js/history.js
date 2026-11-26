// Transfers created on this device, kept in localStorage so the sender can find,
// re-share or cancel them later without an account. Nothing here leaves the device.
const KEY = 'quickdrop:history:v1';
const KEEP_MS = 7 * 86400_000;

export function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(list)) return [];
    const cutoff = Date.now() - KEEP_MS;
    return list.filter((e) => e && e.id && (e.expiresAt || 0) > cutoff);
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    // storage full or disabled: history is a convenience only
  }
}

export function rememberTransfer(entry) {
  save([entry, ...loadHistory().filter((e) => e.id !== entry.id)]);
}

export function forgetTransfer(id) {
  save(loadHistory().filter((e) => e.id !== id));
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function findTransfer(id) {
  return loadHistory().find((e) => e.id === id) || null;
}
