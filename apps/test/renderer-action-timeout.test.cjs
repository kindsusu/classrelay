'use strict';

// 실기기에서 강사 앱의 버튼이 4분 동안 전부 죽어 있었다. Worker 로그에는 /api/ice조차 없었으니
// getDisplayMedia가 돌아오지 않은 채 withBusy가 버튼을 잠근 것이다. 여기서는 어떤 동작도 영원히
// 기다리지 않고, 상한에 걸려 취소된 동작이 뒤늦게 수업을 덮지 않는 것을 검증한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load({ api = {}, getDisplayMedia, RTCPeerConnection } = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const module = { exports: {} };
  const never = new Promise(() => {});
  const elements = new Map();
  const buttons = ['broadcast', 'lecture', 'lock', 'practice'].map((id) => ({ id, disabled: false }));
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, textContent: '', className: '', style: {},
        classList: { toggle() {}, add() {}, remove() {} },
        querySelectorAll: () => []
      });
    }
    return elements.get(id);
  };
  // 타이머는 실행하지 않고 모아 둔다. 30초를 실제로 기다리지 않으려면 테스트가 시계를 쥐어야 한다.
  const timers = [];
  const context = {
    module,
    window: { classroom: { getConfig: () => never, selectCaptureSource: async () => true, ...api } },
    document: { getElementById: element, querySelectorAll: (selector) => (selector === '.action' ? buttons : []), body: {} },
    navigator: getDisplayMedia ? { mediaDevices: { getDisplayMedia } } : {},
    RTCPeerConnection,
    performance: { now: () => 0 },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (callback, ms) => { const entry = { callback, ms, cleared: false }; timers.push(entry); return entry; },
    clearTimeout: (entry) => { if (entry) entry.cleared = true; },
    Promise,
    Map,
    console
  };
  vm.runInNewContext(code, context, { filename: 'renderer.js' });
  const fire = (ms) => timers.filter((entry) => entry.ms === ms && !entry.cleared).forEach((entry) => { entry.cleared = true; entry.callback(); });
  const pending = (ms) => timers.filter((entry) => entry.ms === ms && !entry.cleared).length;
  return { ...module.exports, buttons, element, fire, pending };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeTrack() {
  return {
    stopped: false, contentHint: '', listeners: [],
    applyConstraints: async () => {},
    addEventListener(type, handler) { this.listeners.push({ type, handler }); },
    removeEventListener(type, handler) { this.listeners = this.listeners.filter((entry) => entry.type !== type || entry.handler !== handler); },
    stop() { this.stopped = true; }
  };
}

function fakeStream(track) {
  return { getTracks: () => [track], getVideoTracks: () => [track] };
}

class FakePeerConnection {
  constructor() {
    this.iceGatheringState = 'complete';
    this.signalingState = 'stable';
    this.connectionState = 'connected';
    this.localDescription = null;
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }
  addTransceiver() { return { mid: '0', sender: { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {}, replaceTrack: async () => {} } }; }
  async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
  async setLocalDescription(description) { this.localDescription = description; this.signalingState = 'have-local-offer'; }
  async setRemoteDescription() { this.signalingState = 'stable'; }
  addEventListener() {}
  removeEventListener() {}
  async getStats() { return new Map(); }
  close() { this.closed = true; }
}
FakePeerConnection.instances = [];

// 송출 전 단계(캡처·ICE·세션·트랙)를 전부 성공시키고 setMode만 테스트가 쥔다.
async function broadcastHarness({ getDisplayMedia }) {
  const setModeCalls = [];
  let setModeGate = deferred();
  const r = load({
    api: {
      // 트랙 이름에 deviceId가 들어가므로 설정이 있어야 한다. 초기화가 UI 요소를 찾다 실패해도 config는 남는다.
      getConfig: async () => ({ role: 'controller', deviceId: 'instructor' }),
      pulse: () => {},
      getIce: async () => ({ iceServers: [] }),
      createRtcSession: async () => ({ sessionId: 'sess-1', sessionDescription: { type: 'answer', sdp: 'v=0' } }),
      addRtcTracks: async () => ({ tracks: [{ trackName: 'screen-1' }] }),
      renegotiateRtc: async () => ({ ok: true }),
      setMode: (payload) => { setModeCalls.push(payload); return payload.mode === 'practice' ? Promise.resolve({ revision: 99 }) : setModeGate.promise; },
      backgroundWindow: () => {}
    },
    getDisplayMedia,
    RTCPeerConnection: FakePeerConnection
  });
  await settle();
  r.setSelectedSourceForTest('screen:0');
  r.handleControllerConnection({ online: true });
  return { r, setModeCalls, resolveSetMode: (value) => setModeGate.resolve(value) };
}

test('끝나지 않는 동작은 30초 상한에서 버튼을 풀고 취소 문구를 띄운다', async () => {
  const r = load();
  const busy = r.withBusy(() => new Promise(() => {}));
  assert.ok(r.buttons.every((button) => button.disabled), '동작 중에 버튼을 잠그지 않았다');
  assert.equal(r.pending(r.ACTION_TIMEOUT_MS), 1);
  r.fire(r.ACTION_TIMEOUT_MS);
  assert.ok(r.buttons.every((button) => !button.disabled), '상한에서 버튼을 풀지 않았다');
  assert.equal(r.element('message').textContent, r.ACTION_TIMEOUT);
  assert.equal(r.currentActionGeneration(), 1, '취소된 동작의 세대를 폐기하지 않았다');
  void busy;
});

test('제때 끝난 동작은 상한 타이머를 지우고 세대를 바꾸지 않는다', async () => {
  const r = load();
  await r.withBusy(async () => {});
  assert.ok(r.buttons.every((button) => !button.disabled));
  assert.equal(r.pending(r.ACTION_TIMEOUT_MS), 0, '상한 타이머가 남아 있다');
  assert.equal(r.currentActionGeneration(), 0);
  assert.equal(r.element('message').textContent, '');
});

test('취소된 동작이 뒤늦게 실패하거나 끝나도 문구와 새 동작의 버튼을 건드리지 않는다', async () => {
  const r = load();
  const late = deferred();
  const first = r.withBusy(() => late.promise);
  r.fire(r.ACTION_TIMEOUT_MS);
  assert.equal(r.element('message').textContent, r.ACTION_TIMEOUT);

  // 새 동작이 버튼을 잠근 상태에서 옛 동작이 끝난다.
  const second = r.withBusy(() => new Promise(() => {}));
  assert.ok(r.buttons.every((button) => button.disabled));
  late.reject(new Error('늦은 오류'));
  await first;
  assert.equal(r.element('message').textContent, r.ACTION_TIMEOUT, '옛 동작의 오류가 문구를 덮었다');
  assert.ok(r.buttons.every((button) => button.disabled), '옛 동작이 새 동작의 버튼을 풀었다');
  void second;
});

test('화면 캡처가 10초 안에 돌아오지 않으면 오류로 돌려주고, 늦게 온 스트림은 그 자리에서 멈춘다', async () => {
  const r = load();
  const capture = deferred();
  const attempt = r.captureWithTimeout(capture.promise);
  r.fire(r.CAPTURE_TIMEOUT_MS);
  await assert.rejects(attempt, { message: r.CAPTURE_TIMEOUT });

  const track = fakeTrack();
  capture.resolve(fakeStream(track));
  await settle();
  assert.equal(track.stopped, true, '상한 뒤 도착한 스트림의 트랙을 멈추지 않았다');
});

test('제때 온 스트림은 그대로 돌려주고 타이머를 지운다', async () => {
  const r = load();
  const track = fakeTrack();
  const stream = await r.captureWithTimeout(Promise.resolve(fakeStream(track)));
  assert.equal(stream.getVideoTracks()[0], track);
  assert.equal(track.stopped, false);
  assert.equal(r.pending(r.CAPTURE_TIMEOUT_MS), 0);
});

test('송출 준비 중 상한에 걸리면 모드를 보내지 않고 송출을 접는다', async () => {
  FakePeerConnection.instances = [];
  const capture = deferred();
  const { r, setModeCalls } = await broadcastHarness({ getDisplayMedia: () => capture.promise });
  const action = r.withBusy(() => r.broadcast('lecture'));
  r.fire(r.ACTION_TIMEOUT_MS);
  capture.resolve(fakeStream(fakeTrack()));
  await action;
  assert.deepEqual(setModeCalls, [], '취소된 동작이 모드를 보냈다');
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.equal(FakePeerConnection.instances[0].closed, true, '송출 연결을 닫지 않았다');
  assert.equal(r.element('message').textContent, r.ACTION_TIMEOUT);
});

test('서버가 상한 뒤에야 모드를 받아들이면 실습으로 되돌린다', async () => {
  FakePeerConnection.instances = [];
  const { r, setModeCalls, resolveSetMode } = await broadcastHarness({ getDisplayMedia: async () => fakeStream(fakeTrack()) });
  const action = r.withBusy(() => r.broadcast('lock'));
  for (let i = 0; i < 50 && setModeCalls.length === 0; i += 1) await settle();
  assert.ok(setModeCalls.length > 0, `setMode에 이르지 못했다: ${r.element('message').textContent}`);
  assert.equal(setModeCalls[0].mode, 'lock');
  r.fire(r.ACTION_TIMEOUT_MS);
  assert.ok(r.buttons.every((button) => !button.disabled));
  resolveSetMode({ revision: 12 });
  await action;
  assert.equal(setModeCalls.length, 2, '실습 전환을 보내지 않았다');
  assert.equal(setModeCalls[1].mode, 'practice');
  assert.equal(FakePeerConnection.instances[0].closed, true);
  assert.equal(r.element('message').textContent, r.ACTION_TIMEOUT);
});

test('정상 송출은 상한에 걸리지 않고 안내 문구로 끝난다', async () => {
  FakePeerConnection.instances = [];
  const { r, setModeCalls, resolveSetMode } = await broadcastHarness({ getDisplayMedia: async () => fakeStream(fakeTrack()) });
  const action = r.withBusy(() => r.broadcast('broadcast'));
  for (let i = 0; i < 50 && setModeCalls.length === 0; i += 1) await settle();
  assert.ok(setModeCalls.length > 0, `setMode에 이르지 못했다: ${r.element('message').textContent}`);
  resolveSetMode({ revision: 3, mode: 'broadcast' });
  await action;
  assert.equal(setModeCalls.length, 1);
  assert.equal(FakePeerConnection.instances[0].closed, false);
  assert.equal(r.pending(r.ACTION_TIMEOUT_MS), 0);
  assert.equal(r.element('message').textContent, r.commandMessage('broadcast'));
});

test('재접속은 내가 띄운 끊김 문구만 지운다', () => {
  const r = load();
  r.handleControllerConnection({ online: false, message: '서버 연결이 종료되었습니다.' });
  assert.equal(r.element('message').textContent, '서버 연결이 종료되었습니다.');
  assert.equal(r.element('connection').textContent, '연결 끊김');
  r.handleControllerConnection({ online: true });
  assert.equal(r.element('message').textContent, '', '재접속 뒤 끊김 문구가 남았다');
  assert.equal(r.element('connection').textContent, '서버 연결됨');
});

test('재접속은 강사가 봐야 할 다른 오류 문구는 남긴다', () => {
  const r = load();
  r.handleControllerConnection({ online: false, message: '서버 연결이 종료되었습니다.' });
  r.element('message').textContent = '화면 트랙 발행 실패: 응답 없음';
  r.handleControllerConnection({ online: true });
  assert.equal(r.element('message').textContent, '화면 트랙 발행 실패: 응답 없음');
  // 다음 끊김 문구는 다시 지워져야 한다 — 이전 문구를 기억한 채로 남아 있으면 안 된다.
  r.handleControllerConnection({ online: false, message: '오류 x' });
  r.handleControllerConnection({ online: true });
  assert.equal(r.element('message').textContent, '');
});
