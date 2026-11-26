import { WebSocketServer } from 'ws';
import { describeDevice } from './http.js';

const OPEN = 1;

function send(ws, message) {
  if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(message));
}

// WebSocket hub for:
//  - Live transfers: pairs the sender ("host") with one receiver ("peer") and
//    forwards WebRTC offers/answers/ICE candidates between them. If a direct
//    connection cannot be made, it relays the (already encrypted) data frames.
//  - Upload transfers: pushes real-time events (code used, download progress,
//    delivered) to the sender's open tab ("watcher").
export class SignalingHub {
  constructor({ service, config, limiter, trustProxyIp }) {
    this.service = service;
    this.config = config;
    this.limiter = limiter;
    this.clientIp = trustProxyIp;
    this.rooms = new Map();
    this.hostGone = new Map();
    this.relayedBytes = 0;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.#onConnection(ws, req));
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 25_000);
    this.heartbeat.unref();
  }

  handleUpgrade(req, socket, head) {
    const ip = this.clientIp(req);
    if (!this.limiter.take(ip)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  #room(id) {
    let room = this.rooms.get(id);
    if (!room) {
      room = { host: null, peer: null, watchers: new Set() };
      this.rooms.set(id, room);
    }
    return room;
  }

  #pruneRoom(id) {
    const room = this.rooms.get(id);
    if (room && !room.host && !room.peer && room.watchers.size === 0) this.rooms.delete(id);
  }

  #onConnection(ws, req) {
    ws.isAlive = true;
    ws.device = describeDevice(req.headers['user-agent']);
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) this.#onBinary(ws, data);
        else this.#onText(ws, data.toString());
      } catch (err) {
        console.error('[quickdrop] signaling error', err);
        send(ws, { t: 'error', code: 'bad_message' });
      }
    });
    ws.on('close', () => this.#onClose(ws));
    ws.on('error', () => {});
  }

  #onText(ws, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      send(ws, { t: 'error', code: 'bad_message' });
      return;
    }
    switch (msg?.t) {
      case 'host':
        return this.#host(ws, msg);
      case 'join':
        return this.#join(ws, msg);
      case 'signal':
        return this.#forward(ws, { t: 'signal', data: msg.data });
      case 'relay':
        if (this.config.relayEnabled) this.#forward(ws, { t: 'relay', data: String(msg.data ?? '') });
        return undefined;
      case 'complete':
        return this.#complete(ws);
      case 'ping':
        return send(ws, { t: 'pong' });
      default:
        return send(ws, { t: 'error', code: 'unknown_type' });
    }
  }

  #host(ws, { id, token }) {
    if (ws.role) return send(ws, { t: 'error', code: 'already_bound' });
    const row = this.service.verifyManage(id, token);
    if (!row) {
      send(ws, { t: 'error', code: 'forbidden' });
      ws.close(4003, 'forbidden');
      return undefined;
    }
    if (row.status !== 'active') {
      return send(ws, { t: 'event', kind: 'ended', status: row.status });
    }
    const room = this.#room(id);
    ws.room = id;
    if (row.mode === 'direct') {
      if (room.host && room.host !== ws) {
        const old = room.host;
        old.role = 'replaced';
        send(old, { t: 'replaced' });
        old.close(4000, 'replaced');
        if (room.peer) this.#dropPeer(room, { t: 'host-left' });
      }
      room.host = ws;
      ws.role = 'host';
      this.hostGone.delete(id);
      return send(ws, { t: 'hosted', mode: 'direct' });
    }
    room.watchers.add(ws);
    ws.role = 'watcher';
    return send(ws, { t: 'hosted', mode: 'upload' });
  }

  #join(ws, { id, forceRelay }) {
    if (ws.role) return send(ws, { t: 'error', code: 'already_bound' });
    const problem = this.service.canJoinDirect(id);
    if (problem) return send(ws, { t: 'error', code: problem });
    const room = this.rooms.get(id);
    if (!room?.host) return send(ws, { t: 'error', code: 'host_offline' });
    if (room.peer) return send(ws, { t: 'error', code: 'busy' });
    room.peer = ws;
    ws.role = 'peer';
    ws.room = id;
    send(ws, { t: 'joined', iceServers: this.config.iceServers, relayEnabled: this.config.relayEnabled });
    send(room.host, { t: 'peer-joined', device: ws.device, forceRelay: Boolean(forceRelay) });
    return undefined;
  }

  #counterpart(ws) {
    const room = ws.room ? this.rooms.get(ws.room) : null;
    if (!room) return null;
    if (ws.role === 'host') return room.peer;
    if (ws.role === 'peer' && room.peer === ws) return room.host;
    return null;
  }

  #forward(ws, message) {
    send(this.#counterpart(ws), message);
  }

  #onBinary(ws, data) {
    if (!this.config.relayEnabled) return;
    const target = this.#counterpart(ws);
    if (target && target.readyState === OPEN) {
      this.relayedBytes += data.length;
      target.send(data, { binary: true });
    }
  }

  #complete(ws) {
    if (ws.role !== 'peer' || ws.completed) return;
    ws.completed = true;
    const id = ws.room;
    const result = this.service.recordDirectDownload(id);
    if (!result) return;
    const room = this.rooms.get(id);
    send(room?.host, { t: 'peer-complete', device: ws.device, ...result });
    send(ws, { t: 'complete-ack' });
    if (result.exhausted) {
      // Give the final messages a moment to flush before tearing down the room.
      setTimeout(() => this.service.end(id, 'completed'), 1500).unref();
    }
  }

  #dropPeer(room, message) {
    const peer = room.peer;
    room.peer = null;
    if (peer) {
      send(peer, message);
      peer.role = null;
      peer.room = null;
    }
  }

  #onClose(ws) {
    const id = ws.room;
    const room = id ? this.rooms.get(id) : null;
    if (!room) return;
    if (ws.role === 'host' && room.host === ws) {
      room.host = null;
      this.hostGone.set(id, Date.now());
      this.#dropPeer(room, { t: 'host-left' });
    } else if (ws.role === 'peer' && room.peer === ws) {
      room.peer = null;
      send(room.host, { t: 'peer-left', device: ws.device });
    } else if (ws.role === 'watcher') {
      room.watchers.delete(ws);
    }
    this.#pruneRoom(id);
  }

  hostOnline(id) {
    return Boolean(this.rooms.get(id)?.host);
  }

  hostGoneSince(id) {
    return this.hostGone.get(id) ?? null;
  }

  notify(id, event) {
    const room = this.rooms.get(id);
    if (!room) return;
    const message = { t: 'event', ...event };
    send(room.host, message);
    for (const watcher of room.watchers) send(watcher, message);
  }

  transferEnded(id, status) {
    const room = this.rooms.get(id);
    this.hostGone.delete(id);
    if (!room) return;
    const message = { t: 'event', kind: 'ended', status };
    send(room.host, message);
    send(room.peer, message);
    for (const watcher of room.watchers) send(watcher, message);
    for (const ws of [room.host, room.peer, ...room.watchers]) {
      if (ws) {
        ws.role = 'ended';
        ws.room = null;
      }
    }
    this.rooms.delete(id);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
