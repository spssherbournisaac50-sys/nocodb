// WebSocket client for the signaling hub (see server/signaling.js).
export class SignalClient {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.binaryListener = null;
  }

  connect(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Could not reach the server'));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        // Regular small messages keep idle proxies (and sleeping free hosts) from
        // closing the connection while someone waits for the other device.
        this.keepalive = setInterval(() => this.send({ t: 'ping' }), 45_000);
        resolve(this);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not reach the server'));
      };
      ws.onclose = (event) => {
        clearInterval(this.keepalive);
        this.#emit('close', event);
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          this.binaryListener?.(event.data);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this.#emit(msg.t, msg);
      };
    });
  }

  #emit(type, payload) {
    for (const fn of [...(this.listeners.get(type) || [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  // Resolves with the first message of any of the given types.
  once(...types) {
    return new Promise((resolve) => {
      const offs = types.map((type) =>
        this.on(type, (msg) => {
          offs.forEach((off) => off());
          resolve(msg ?? { t: type });
        }),
      );
    });
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(message) {
    if (this.open) this.ws.send(JSON.stringify(message));
  }

  sendBinary(data) {
    if (this.open) this.ws.send(data);
  }

  get bufferedAmount() {
    return this.ws?.bufferedAmount ?? 0;
  }

  close() {
    clearInterval(this.keepalive);
    this.listeners.clear();
    this.binaryListener = null;
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }
}
