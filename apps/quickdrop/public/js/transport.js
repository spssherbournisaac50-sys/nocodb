// Live transfers: a direct WebRTC data channel between the two browsers, with an
// automatic fallback to relaying through the server when NATs/firewalls block a
// direct path. Data is end-to-end encrypted before it reaches either transport.
//
// Both channel types expose: send(stringOrBinary), bufferedAmount, onmessage,
// onclose, close(), and kind ('direct' | 'relay').

const HOST_CONNECT_TIMEOUT_MS = 12_000;
const PEER_CONNECT_TIMEOUT_MS = 40_000;

export const hasWebRtc = typeof RTCPeerConnection !== 'undefined';

class RtcChannel {
  constructor(pc, dc) {
    this.kind = 'direct';
    this.pc = pc;
    this.dc = dc;
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (event) => this.onmessage?.(event.data);
    const closed = () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    };
    dc.onclose = closed;
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closed();
    });
  }

  send(data) {
    this.dc.send(data);
  }

  get bufferedAmount() {
    return this.dc.bufferedAmount;
  }

  close() {
    this.closed = true;
    try {
      this.dc.close();
    } catch {
      // ignore
    }
    try {
      this.pc.close();
    } catch {
      // ignore
    }
  }
}

class RelayChannel {
  constructor(signal) {
    this.kind = 'relay';
    this.signal = signal;
    this.onmessage = null;
    this.onclose = null;
    this.offs = [
      signal.on('relay', (msg) => this.onmessage?.(msg.data)),
      signal.on('close', () => this.onclose?.()),
    ];
    signal.binaryListener = (data) => this.onmessage?.(data);
  }

  send(data) {
    if (typeof data === 'string') this.signal.send({ t: 'relay', data });
    else this.signal.sendBinary(data);
  }

  get bufferedAmount() {
    return this.signal.bufferedAmount;
  }

  close() {
    this.offs.forEach((off) => off());
    this.signal.binaryListener = null;
  }
}

function sequential() {
  let chain = Promise.resolve();
  return (task) => {
    chain = chain.then(task).catch((err) => console.warn('[quickdrop] signaling step failed', err));
  };
}

// The sender decides which transport is used and tells the receiver.
export function connectAsHost(signal, { iceServers, relayEnabled, forceRelay }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pc = null;
    let timer = null;
    const offs = [];

    const finish = (channel, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offs.forEach((off) => off());
      if (error) reject(error);
      else resolve(channel);
    };

    const useRelay = () => {
      if (settled) return;
      try {
        pc?.close();
      } catch {
        // ignore
      }
      if (!relayEnabled) {
        finish(null, new Error('Could not connect the two devices directly. Try “Upload” mode instead.'));
        return;
      }
      signal.send({ t: 'signal', data: { transport: 'relay' } });
      finish(new RelayChannel(signal));
    };

    if (forceRelay || !hasWebRtc) {
      useRelay();
      return;
    }

    try {
      pc = new RTCPeerConnection({ iceServers });
    } catch {
      useRelay();
      return;
    }
    const dc = pc.createDataChannel('quickdrop', { ordered: true });
    pc.onicecandidate = (event) => {
      if (event.candidate) signal.send({ t: 'signal', data: { candidate: event.candidate.toJSON() } });
    };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') useRelay();
    });
    dc.onopen = () => {
      if (settled) return;
      signal.send({ t: 'signal', data: { transport: 'direct' } });
      finish(new RtcChannel(pc, dc));
    };

    const queue = sequential();
    offs.push(
      signal.on('signal', ({ data }) =>
        queue(async () => {
          if (settled || !data) return;
          if (data.sdp) await pc.setRemoteDescription(data.sdp);
          else if (data.candidate) await pc.addIceCandidate(data.candidate).catch(() => {});
        }),
      ),
    );

    timer = setTimeout(useRelay, HOST_CONNECT_TIMEOUT_MS);
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signal.send({ t: 'signal', data: { sdp: pc.localDescription.toJSON() } });
    })().catch(useRelay);
  });
}

export function connectAsPeer(signal, { iceServers }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pc = null;
    let dc = null;
    let decided = null;
    const offs = [];

    const finish = (channel, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offs.forEach((off) => off());
      if (error) reject(error);
      else resolve(channel);
    };

    // Called from several events (channel announced, channel open, sender's
    // decision). Only the first successful call may wrap the channel: a second
    // RtcChannel would take over dc.onmessage and silently swallow the data.
    const tryDirect = () => {
      if (settled) return;
      if (decided === 'direct' && dc?.readyState === 'open') finish(new RtcChannel(pc, dc));
    };

    const ensurePc = () => {
      if (pc || !hasWebRtc) return;
      pc = new RTCPeerConnection({ iceServers });
      pc.onicecandidate = (event) => {
        if (event.candidate) signal.send({ t: 'signal', data: { candidate: event.candidate.toJSON() } });
      };
      pc.ondatachannel = (event) => {
        dc = event.channel;
        dc.binaryType = 'arraybuffer';
        dc.onopen = tryDirect;
        tryDirect();
      };
    };

    const queue = sequential();
    offs.push(
      signal.on('signal', ({ data }) =>
        queue(async () => {
          if (settled || !data) return;
          if (data.transport === 'relay') {
            try {
              pc?.close();
            } catch {
              // ignore
            }
            if (!settled) finish(new RelayChannel(signal));
            return;
          }
          if (data.transport === 'direct') {
            decided = 'direct';
            tryDirect();
            return;
          }
          ensurePc();
          if (!pc) return;
          if (data.sdp) {
            await pc.setRemoteDescription(data.sdp);
            if (data.sdp.type === 'offer') {
              await pc.setLocalDescription(await pc.createAnswer());
              signal.send({ t: 'signal', data: { sdp: pc.localDescription.toJSON() } });
            }
          } else if (data.candidate) {
            await pc.addIceCandidate(data.candidate).catch(() => {});
          }
        }),
      ),
    );

    const timer = setTimeout(
      () => finish(null, new Error('Could not connect to the sender. Ask them to keep the page open and try again.')),
      PEER_CONNECT_TIMEOUT_MS,
    );
  });
}
