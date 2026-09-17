'use strict';

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_MS = 15_000;
const MODES = new Set(['practice', 'broadcast', 'lock']);

function validSnapshot(state) {
  return Boolean(state)
    && Number.isSafeInteger(state.revision)
    && MODES.has(state.mode)
    && Number.isFinite(Number(state.leaseMs))
    && Number(state.leaseMs) >= 0;
}

function websocketUrl(backendUrl) {
  const url = new URL('/api/connect', `${backendUrl.replace(/\/$/, '')}/`);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new Error('지원하지 않는 backendUrl 프로토콜입니다.');
  return url.toString();
}

class ControlSocket {
  constructor(options) {
    this.WebSocket = options.WebSocket;
    this.url = websocketUrl(options.backendUrl);
    this.headers = options.headers;
    this.onState = options.onState;
    this.onConnection = options.onConnection;
    this.canHeartbeat = options.canHeartbeat || (() => true);
    this.heartbeatMs = options.heartbeatMs || DEFAULT_HEARTBEAT_MS;
    this.staleMs = options.staleMs || DEFAULT_STALE_MS;
    this.now = options.now || (() => performance.now());
    this.random = options.random || Math.random;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.retryMs = 1_000;
    this.lastMessageAt = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners?.();
      socket.on?.('error', () => {});
      try { socket.terminate?.(); } catch {
        try { socket.close(); } catch { /* already closed */ }
      }
    }
  }

  clearTimers() {
    this.clearTimeout(this.heartbeatTimer);
    this.clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.stopped || this.socket) return;
    let socket;
    try {
      socket = new this.WebSocket(this.url, {
        headers: this.headers,
        handshakeTimeout: 8_000,
        maxPayload: 1_048_576
      });
    } catch (error) {
      this.onConnection({ online: false, message: error.message });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.lastMessageAt = this.now();
      this.onConnection({ online: true });
      this.scheduleHeartbeat(0);
    });
    socket.on('message', (data) => {
      if (this.socket !== socket || this.stopped) return;
      let message;
      try { message = JSON.parse(String(data)); }
      catch { return; }
      if (message?.type !== 'state' || !validSnapshot(message.state)) return;
      this.lastMessageAt = this.now();
      this.retryMs = 1_000;
      this.onState(message.state);
    });
    socket.on('error', (error) => {
      if (this.socket === socket && !this.stopped) {
        this.onConnection({ online: false, message: error.message });
      }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (!this.stopped) {
        this.onConnection({ online: false, message: '서버 연결이 종료되었습니다.' });
        this.scheduleReconnect();
      }
    });
  }

  scheduleHeartbeat(delay = this.heartbeatMs) {
    this.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.setTimeout(() => this.heartbeat(), delay);
  }

  heartbeat() {
    this.heartbeatTimer = null;
    const socket = this.socket;
    if (this.stopped || !socket) return;
    if (this.now() - this.lastMessageAt >= this.staleMs) {
      this.onConnection({ online: false, message: '서버 응답이 15초 동안 없습니다.' });
      try { socket.terminate(); } catch { socket.close(); }
      return;
    }
    if (this.canHeartbeat()) {
      try { socket.send(JSON.stringify({ type: 'heartbeat' })); }
      catch {
        try { socket.terminate(); } catch { socket.close(); }
        return;
      }
    }
    this.scheduleHeartbeat();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.round(this.retryMs * (0.8 + this.random() * 0.4));
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    this.reconnectTimer = this.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

module.exports = { ControlSocket, websocketUrl, validSnapshot, DEFAULT_HEARTBEAT_MS, DEFAULT_STALE_MS };
