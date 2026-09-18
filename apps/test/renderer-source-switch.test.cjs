'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRendererExports({ api = {}, getDisplayMedia } = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const module = { exports: {} };
  const never = new Promise(() => {});
  const context = {
    module,
    window: { classroom: { getConfig: () => never, selectCaptureSource: async () => true, ...api } },
    document: { getElementById: () => null, body: {} },
    navigator: getDisplayMedia ? { mediaDevices: { getDisplayMedia } } : {},
    performance: { now: () => 0 },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    Promise,
    console
  };
  vm.runInNewContext(code, context, { filename: 'renderer.js' });
  return module.exports;
}

function readSource(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
}

// ended를 stop()에서 실제로 발생시킨다. 리스너가 남아 있는 트랙을 멈추면 그 자리에서
// setPractice 대역인 endedCalls가 올라가므로 순서가 틀리면 테스트가 잡아낸다.
function fakeTrack(label, state) {
  return {
    label,
    contentHint: '',
    stopped: false,
    listeners: [],
    applyConstraints: async () => { state.constrained.push(label); },
    addEventListener(type, handler, options) { this.listeners.push({ type, handler, options }); },
    removeEventListener(type, handler) {
      this.listeners = this.listeners.filter((entry) => entry.type !== type || entry.handler !== handler);
    },
    stop() {
      this.stopped = true;
      this.listeners.filter((entry) => entry.type === 'ended').forEach((entry) => entry.handler());
    },
    endedListener() { return this.listeners.some((entry) => entry.type === 'ended'); }
  };
}

function fakeStream(track) {
  return { getTracks: () => [track], getVideoTracks: () => [track] };
}

function fakePublication(state, { replaceTrack } = {}) {
  const track = fakeTrack('old', state);
  const descriptor = { sessionId: 'sess-1', trackName: 'screen-a' };
  const publication = {
    pc: { id: 'pc-1' },
    stream: fakeStream(track),
    track,
    sender: {
      current: track,
      replaceTrack: replaceTrack || (async function (next) { publication.sender.current = next; })
    },
    endedHandler: () => { state.ended += 1; },
    descriptor,
    activationRevision: 11,
    sourceId: 'screen:0'
  };
  track.addEventListener('ended', publication.endedHandler, { once: true });
  return publication;
}

function newState() {
  return { ended: 0, constrained: [], selected: [] };
}

test('화면 교체는 ended 리스너를 새 트랙으로 옮긴 뒤에만 헌 트랙을 멈춘다', async () => {
  const state = newState();
  const next = fakeTrack('new', state);
  const { replaceLiveTrack } = loadRendererExports({
    api: { selectCaptureSource: async (id) => { state.selected.push(id); return true; } },
    getDisplayMedia: async () => fakeStream(next)
  });
  const publication = fakePublication(state);
  const old = publication.track;

  await replaceLiveTrack(publication, 'screen:1', () => false);

  assert.equal(old.stopped, true, '헌 트랙을 멈추지 않았다');
  assert.equal(state.ended, 0, '헌 트랙의 ended가 발생해 수업이 실습으로 풀렸다');
  assert.equal(old.endedListener(), false, '헌 트랙에 ended 리스너가 남아 있다');
  assert.equal(next.endedListener(), true, '새 트랙에 ended 리스너가 옮겨지지 않았다');
  assert.equal(next.listeners.find((entry) => entry.type === 'ended').handler, publication.endedHandler, 'stopPublishing이 떼어낼 수 없는 다른 핸들러가 붙었다');
  assert.equal(next.listeners.find((entry) => entry.type === 'ended').options.once, true);
  assert.equal(next.stopped, false, '새 트랙이 멈춰 있다');
  assert.equal(publication.track, next, '새 트랙이 발행 정보에 반영되지 않았다');
  assert.equal(publication.sender.current, next, 'sender가 새 트랙을 들고 있지 않다');
  assert.equal(state.selected[0], 'screen:1');
});

test('화면 교체는 발행 신분과 activationRevision을 건드리지 않는다', async () => {
  const state = newState();
  const next = fakeTrack('new', state);
  const { replaceLiveTrack } = loadRendererExports({ getDisplayMedia: async () => fakeStream(next) });
  const publication = fakePublication(state);
  const descriptor = publication.descriptor;
  const pc = publication.pc;
  const sender = publication.sender;

  await replaceLiveTrack(publication, 'screen:1', () => false);

  assert.equal(publication.activationRevision, 11, 'activationRevision이 바뀌었다');
  assert.equal(publication.descriptor, descriptor, 'descriptor 객체가 교체됐다');
  assert.deepEqual({ ...publication.descriptor }, { sessionId: 'sess-1', trackName: 'screen-a' });
  assert.equal(publication.pc, pc, 'peer connection이 교체됐다');
  assert.equal(publication.sender, sender, 'sender가 교체됐다');
  assert.equal(publication.sourceId, 'screen:1', '지금 나가는 화면 기록이 갱신되지 않았다');
});

test('교체 트랙에도 같은 송출 상한을 적용한다', async () => {
  const state = newState();
  const next = fakeTrack('new', state);
  const captured = [];
  const { replaceLiveTrack, DEFAULT_VIDEO } = loadRendererExports({
    getDisplayMedia: async (constraints) => { captured.push(constraints); return fakeStream(next); }
  });

  await replaceLiveTrack(fakePublication(state), 'screen:1', () => false);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].video.height.max, DEFAULT_VIDEO.maxHeight);
  assert.equal(captured[0].video.frameRate.max, DEFAULT_VIDEO.maxFps);
  assert.equal(captured[0].audio, false);
  assert.equal(next.contentHint, 'text', '가독성 힌트를 새 트랙에 적용하지 않았다');
  assert.deepEqual(state.constrained, ['new']);
});

test('화면 선택이 거절되면 이전 화면을 그대로 계속 송출한다', async () => {
  const state = newState();
  const { replaceLiveTrack } = loadRendererExports({
    getDisplayMedia: async () => { throw new Error('Permission denied by system'); }
  });
  const publication = fakePublication(state);
  const old = publication.track;

  await assert.rejects(() => replaceLiveTrack(publication, 'screen:1', () => false), /Permission denied/);

  assert.equal(old.stopped, false, '헌 트랙이 멈췄다');
  assert.equal(old.endedListener(), true, '헌 트랙의 ended 리스너가 사라졌다');
  assert.equal(publication.track, old, '발행 정보가 사라진 트랙을 가리킨다');
  assert.equal(publication.sender.current, old, 'sender가 트랙을 잃었다');
  assert.equal(state.ended, 0);
  assert.equal(publication.sourceId, 'screen:0', '실패한 교체가 지금 나가는 화면 기록을 바꿨다');
});

test('replaceTrack이 실패하면 새로 딴 스트림만 버린다', async () => {
  const state = newState();
  const next = fakeTrack('new', state);
  const { replaceLiveTrack } = loadRendererExports({ getDisplayMedia: async () => fakeStream(next) });
  const publication = fakePublication(state, {
    replaceTrack: async () => { throw new Error('InvalidStateError'); }
  });
  const old = publication.track;

  await assert.rejects(() => replaceLiveTrack(publication, 'screen:1', () => false), /InvalidStateError/);

  assert.equal(next.stopped, true, '실패한 교체가 새 캡처를 계속 돌린다');
  assert.equal(old.stopped, false, '헌 트랙이 멈췄다');
  assert.equal(old.endedListener(), true, '헌 트랙의 ended 리스너가 사라졌다');
  assert.equal(publication.track, old);
  assert.equal(state.ended, 0);
});

test('교체 도중 재연결이 끼어들면 새 스트림을 정리하고 취소한다', async () => {
  const state = newState();
  const next = fakeTrack('new', state);
  let cancelled = false;
  const { replaceLiveTrack, SWITCH_CANCELLED } = loadRendererExports({
    getDisplayMedia: async () => { cancelled = true; return fakeStream(next); }
  });
  const publication = fakePublication(state);
  const old = publication.track;

  await assert.rejects(() => replaceLiveTrack(publication, 'screen:1', () => cancelled), (error) => error.message === SWITCH_CANCELLED);

  assert.equal(next.stopped, true, '취소된 교체가 새 캡처를 계속 돌린다');
  assert.equal(publication.track, old);
  assert.equal(old.endedListener(), true);
  assert.equal(publication.sender.current, old, 'sender가 트랙을 잃었다');
  assert.equal(state.ended, 0);
});

test('replaceTrack이 성공한 뒤 취소된 경우에도 새 트랙을 남겨 두지 않는다', async () => {
  const state = newState();
  const next = fakeTrack('new', state);
  let replaced = false;
  const { replaceLiveTrack, SWITCH_CANCELLED } = loadRendererExports({ getDisplayMedia: async () => fakeStream(next) });
  const publication = fakePublication(state, {
    replaceTrack: async (track) => { publication.sender.current = track; replaced = true; }
  });

  await assert.rejects(() => replaceLiveTrack(publication, 'screen:1', () => replaced), (error) => error.message === SWITCH_CANCELLED);

  assert.equal(next.stopped, true, '취소 뒤 새 캡처가 강사 화면을 계속 잡고 있다');
  assert.equal(publication.sourceId, 'screen:0', '취소된 교체가 기록을 갱신했다');
  assert.equal(state.ended, 0);
});

test('replaceTrack이 없는 실행 환경은 송출을 건드리지 않고 거절한다', async () => {
  const state = newState();
  let pickerOpened = false;
  const { replaceLiveTrack } = loadRendererExports({
    getDisplayMedia: async () => { pickerOpened = true; return fakeStream(fakeTrack('new', state)); }
  });
  const publication = fakePublication(state);
  publication.sender = {};
  const old = publication.track;

  await assert.rejects(() => replaceLiveTrack(publication, 'screen:1', () => false), /화면 교체를 지원하지 않습니다/);

  assert.equal(pickerOpened, false, '지원하지 않는 환경에서 화면 캡처를 먼저 열었다');
  assert.equal(old.stopped, false);
  assert.equal(publication.track, old);
});

test('고른 화면과 지금 나가는 화면을 표시로 구분한다', () => {
  const { sourceStateClass } = loadRendererExports();
  assert.equal(sourceStateClass('a', 'a', 'b'), 'source selected');
  assert.equal(sourceStateClass('b', 'a', 'b'), 'source live');
  assert.equal(sourceStateClass('a', 'a', 'a'), 'source selected live');
  assert.equal(sourceStateClass('c', 'a', 'b'), 'source');
  assert.equal(sourceStateClass('a', 'a', null), 'source selected');
  assert.equal(sourceStateClass('a', null, null), 'source');
});

test('교체 성공 메시지는 수업 모드와 잠금이 그대로임을 알린다', () => {
  const { sourceSwitchMessage } = loadRendererExports();
  const text = sourceSwitchMessage('발표 자료.pptx');
  assert.ok(text.includes('발표 자료.pptx'), '어느 화면으로 바뀠는지 말하지 않는다');
  assert.ok(text.includes('수업 모드'));
  assert.ok(text.includes('입력 잠금은 그대로'));
});

// 교체가 수업 revision을 건드리면 해제된 잠금이 되살아날 수 있다. 명령 경로가 늘지 않았음을
// 소스 수준에서 고정한다.
test('화면 교체는 새 모드 명령도 revision 대입도 추가하지 않는다', () => {
  const source = readSource('renderer.js');
  assert.equal((source.match(/api\.setMode\(/g) || []).length, 2, 'setMode 호출처가 broadcast·setPractice 외에 늘었다');
  assert.equal((source.match(/activationRevision\s*=[^=]/g) || []).length, 1, 'activationRevision을 대입하는 곳이 늘었다');
  assert.equal(/createRtcSession|addRtcTracks|renegotiateRtc/.test(source.slice(source.indexOf('async function replaceLiveTrack'), source.indexOf('async function switchLiveSource'))), false, '교체 경로가 재협상이나 새 세션을 만든다');
});

test('교체는 취소 조건으로 재연결 세대와 발행 동일성을 함께 본다', () => {
  const source = readSource('renderer.js');
  assert.ok(/publishing !== publication/.test(source), '발행 동일성 검사가 없다');
  assert.ok(/connectionGeneration !== controllerConnectionGeneration/.test(source), '재연결 세대 검사가 없다');
  assert.ok(/function publicationCancelled\(publication, connectionGeneration\)/.test(source));
});
