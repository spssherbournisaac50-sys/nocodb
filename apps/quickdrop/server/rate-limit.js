// Fixed-window in-memory rate limiter. Good enough for a single instance; swap
// for a shared store (Redis, etc.) when running several instances.
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  #entry(key) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      entry = { start: now, count: 0 };
      this.hits.set(key, entry);
    }
    return entry;
  }

  // Counts a hit and returns true while the key is within its budget.
  take(key) {
    const entry = this.#entry(key);
    entry.count++;
    return entry.count <= this.max;
  }

  // Checks without counting (used for "failures only" budgets).
  blocked(key) {
    return this.#entry(key).count >= this.max;
  }

  retryAfterSeconds(key) {
    const entry = this.hits.get(key);
    if (!entry) return 0;
    return Math.max(1, Math.ceil((entry.start + this.windowMs - Date.now()) / 1000));
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now - entry.start >= this.windowMs) this.hits.delete(key);
    }
  }
}
