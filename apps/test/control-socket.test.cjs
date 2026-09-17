'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ControlSocket, websocketUrl } = require('../src/control-socket.cjs');

class FakeClock {
  constructor() { this.now = 0; this.nextId = 1; this.tasks = new Map(); }
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (id) => this.tasks.delete(id);
  tick(ms) {
    const end = this.now + ms;
    while (true) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = end;
  }
}

function socketHarness(overrides = {}) {
  const clock = new FakeClock();
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.sent = [];
      this.terminated = false;
      sockets.push(this);
    }
    send(value) { this.sent.push(value); }
    close() { this.emit('close'); }
    terminate() { this.terminated = true; this.emit('close'); }
  }
  const states = [];
  const connections = [];
  const client = new ControlSocket({
    WebSocket: FakeWebSocket,
    backendUrl: 'https://class.example.test/base',
    headers: { Authorization: 'Bearer secret', 'X-Device-Id': 'student-01' },
    onState: (state) => states.push(state),
    onConnection: (state) => connections.push(state),
    now: () => clock.now,
    random: () => 0.5,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides
  });
  return { clock, sockets, states, connections, client };
}

test('connect URL uses WebSocket while credentials remain in headers', () => {
  const { client, sockets } = socketHarness();
  client.start();
  client.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://class.example.test/api/connect');
  assert.deepEqual(sockets[0].options.headers, { Authorization: 'Bearer secret', 'X-Device-Id': 'student-01' });
  assert.equal(sockets[0].options.handshakeTimeout, 8_000);
  assert.equal(sockets[0].options.maxPayload, 1_048_576);
  assert.equal(sockets[0].url.includes('secret'), false);
  client.stop();
});

test('initial and changed state frames are delivered and heartbeat is not REST polling', () => {
  const { client, sockets, states, clock } = socketHarness();
  client.start();
  const socket = sockets[0];
  socket.emit('open');
  clock.tick(0);
  assert.deepEqual(socket.sent.map(JSON.parse), [{ type: 'heartbeat' }]);
  socket.emit('message', JSON.stringify({ type: 'state', state: { revision: 1, mode: 'practice', leaseMs: 0 } }));
  socket.emit('message', JSON.stringify({ type: 'state', state: { revision: 2, mode: 'lock', leaseMs: 15_000 } }));
  assert.deepEqual(states.map((state) => state.revision), [1, 2]);
  clock.tick(5_000);
  assert.equal(socket.sent.length, 2);
  client.stop();
});

test('controller heartbeat is suppressed when its renderer is unhealthy', () => {
  let healthy = false;
  const { client, sockets, clock } = socketHarness({ canHeartbeat: () => healthy });
  client.start();
  sockets[0].emit('open');
  clock.tick(0);
  assert.equal(sockets[0].sent.length, 0);
  healthy = true;
  clock.tick(5_000);
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: 'heartbeat' });
  client.stop();
});

test('15 seconds without a state reply terminates and reconnects with backoff', () => {
  const { client, sockets, connections, clock } = socketHarness();
  client.start();
  sockets[0].emit('open');
  clock.tick(15_000);
  assert.equal(sockets[0].terminated, true);
  assert.equal(connections.at(-1).online, false);
  clock.tick(1_000);
  assert.equal(sockets.length, 2);
  client.stop();
});

test('malformed state cannot keep a stalled connection alive', () => {
  const { client, sockets, states, clock } = socketHarness();
  client.start();
  sockets[0].emit('open');
  sockets[0].emit('message', JSON.stringify({ type: 'state', state: {} }));
  clock.tick(15_000);
  assert.deepEqual(states, []);
  assert.equal(sockets[0].terminated, true);
  client.stop();
});

test('websocket URL supports local HTTP development', () => {
  assert.equal(websocketUrl('http://127.0.0.1:8787'), 'ws://127.0.0.1:8787/api/connect');
});
