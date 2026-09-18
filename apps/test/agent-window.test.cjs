'use strict';

// 학생 창 반영이 멱등한지 검증한다. Durable Object는 하트비트(5초)마다 state 프레임을 돌려주고
// safety.accept()는 같은 revision도 받아들이므로(lease 갱신이 15초 워치독의 근거다)
// applyAgentWindow()는 수업 내내 5초마다 다시 불린다. 예전에는 그때마다 show/전체화면/kiosk/focus를
// 무조건 다시 실행해 학생 화면이 깜빡이고, 입력을 일부러 풀어 둔 broadcast에서도 5초마다
// 포커스를 빼앗았다. 여기서 검증하는 것은 (1) 같은 상태면 아무 것도 하지 않는다 (2) 진짜 전환과
// 창이 어긋난 경우에는 반드시 다시 세운다 (3) 해제 경로는 여전히 조건 없이 실행된다 이 셋이다.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootMain, live, readSource } = require('./boot-main.cjs');

// 하트비트로 같은 프레임이 다시 오는 상황. 서버가 실제로 이렇게 보낸다.
function heartbeatState(harness, mode, revision) {
  harness.advance(5_000);
  harness.pulse(true);
  harness.state({ revision, mode, leaseMs: 15_000 });
}

test('같은 모드의 상태가 반복돼도 창을 건드리지 않고 포커스도 빼앗지 않는다', () => {
  for (const mode of ['broadcast', 'lecture', 'lock']) {
    const harness = bootMain();
    live(harness, mode, 5);
    const applied = harness.windowCalls.length;
    assert.ok(applied > 0, `${mode} 첫 반영에서 창을 세우지 않았다`);

    for (let round = 0; round < 3; round += 1) heartbeatState(harness, mode, 5);
    assert.equal(harness.windowCalls.length, applied, `${mode}에서 같은 상태로 창을 다시 조작했다:\n${harness.windowCalls.join(', ')}`);
    assert.equal(harness.windowCalls.filter((entry) => entry === 'focus').length, 1, `${mode}에서 포커스를 반복해 가져갔다`);
    assert.equal(harness.windowCalls.filter((entry) => entry === 'show').length, 1, `${mode}에서 창을 반복해 다시 띄웠다`);
    assert.equal(harness.windowCalls.filter((entry) => entry === 'kiosk:true').length, 1, `${mode}에서 kiosk를 반복해 걸었다`);
  }
});

test('실습에서 비실습으로 바뀔 때만 창을 세우고 포커스를 가져온다', () => {
  for (const mode of ['broadcast', 'lecture', 'lock']) {
    const harness = bootMain();
    harness.pulse(true);
    harness.state({ revision: 1, mode: 'practice', leaseMs: 0 });
    const released = harness.windowCalls.length;

    live(harness, mode, 2);
    const applied = harness.windowCalls.slice(released);
    assert.deepEqual(applied, ['show', 'alwaysOnTop:true', 'kiosk:true', 'focus'], `${mode} 전환이 창을 세우지 않았다`);
    assert.equal(harness.window().fullScreen, true, `${mode}에서 전체화면이 아니다`);
    assert.equal(harness.window().kiosk, true);
    assert.equal(harness.window().visible, true);
  }
});

test('비실습 모드 사이 전환은 포커스만 다시 가져온다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 3);
  const applied = harness.windowCalls.length;
  harness.pulse(true);
  harness.state({ revision: 4, mode: 'lock', leaseMs: 15_000 });
  assert.deepEqual(harness.windowCalls.slice(applied), ['focus'], '이미 발표 상태인 창을 다시 조작했다');
});

test('한 번의 반영에서 전체화면 전환을 두 번 하지 않는다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 6);
  assert.equal(harness.windowCalls.filter((entry) => entry === 'kiosk:true').length, 1);
  assert.equal(harness.windowCalls.some((entry) => entry.startsWith('fullScreen:')), false, 'kiosk와 별도로 전체화면을 또 전환했다');
  // Windows에서 kiosk 진입은 그 자체로 전체화면 전환이다(NativeWindowViews::SetKiosk → SetFullScreen).
  // 전체화면 호출이 다시 들어오면 한 번의 반영에서 전환이 두 번 일어나 화면이 번쩍인다.
  // 주석에는 그 사실을 적어 두므로 회귀 검사는 주석을 뺀 코드 줄만 본다.
  const code = readSource('main.cjs').split('\n').filter((line) => !line.trim().startsWith('//'));
  assert.equal(code.some((line) => /setFullScreen\(true\)/.test(line)), false, 'kiosk와 함께 전체화면 전환이 돌아왔다');
  assert.ok(code.some((line) => /mainWindow\.setKiosk\(true\)/.test(line)), '비실습 모드에서 kiosk를 켜지 않는다');
});

test('kiosk가 떨어지면 다음 상태에서 되살린다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 7);
  const applied = harness.windowCalls.length;
  // OS나 외부 요인이 kiosk를 떨어뜨린 상황. 앱은 이것을 스스로 알아차려야 한다.
  harness.window().kiosk = false;
  harness.window().fullScreen = false;

  heartbeatState(harness, 'lecture', 7);
  assert.deepEqual(harness.windowCalls.slice(applied), ['kiosk:true'], 'kiosk만 다시 걸어야 한다');
  assert.equal(harness.window().kiosk, true);
});

test('항상 위가 떨어지면 다음 상태에서 되살린다', () => {
  const harness = bootMain();
  live(harness, 'lock', 8);
  const applied = harness.windowCalls.length;
  harness.window().alwaysOnTop = false;

  heartbeatState(harness, 'lock', 8);
  assert.deepEqual(harness.windowCalls.slice(applied), ['alwaysOnTop:true'], '항상 위만 다시 걸어야 한다');
  assert.equal(harness.window().alwaysOnTop, true);
});

test('비실습 모드에서 창이 내려가면 다음 상태에서 다시 세운다', () => {
  for (const drift of [(window) => { window.visible = false; }, (window) => { window.minimized = true; }]) {
    const harness = bootMain();
    live(harness, 'broadcast', 9);
    const applied = harness.windowCalls.length;
    drift(harness.window());

    heartbeatState(harness, 'broadcast', 9);
    assert.deepEqual(harness.windowCalls.slice(applied), ['show'], '창만 다시 세워야 한다');
    assert.equal(harness.window().visible, true);
    assert.equal(harness.window().minimized, false);
  }
});

test('창 상태를 읽을 수 없으면 그 속성을 다시 적용한다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 10);
  const applied = harness.windowCalls.length;
  // 질의가 실패하면 "이미 맞다"로 읽지 않는다 — 모르면 다시 적용해야 학생이 어긋난 채 남지 않는다.
  harness.window().isKiosk = () => { throw new Error('창 질의 실패'); };

  heartbeatState(harness, 'lecture', 10);
  assert.deepEqual(harness.windowCalls.slice(applied), ['kiosk:true'], '읽을 수 없는 속성을 건너뛰었다');
  assert.equal(harness.windowCalls.includes('focus'), true);
  assert.equal(harness.windowCalls.filter((entry) => entry === 'focus').length, 1, '드리프트 복구에서 포커스를 빼앗았다');
});

test('실습 전환은 조건 없이 kiosk를 벗고 창을 숨긴다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 11);
  const queried = harness.windowQueries.length;

  harness.state({ revision: 12, mode: 'practice', leaseMs: 0 });
  assert.deepEqual(harness.windowCalls.slice(-3), ['kiosk:false', 'alwaysOnTop:false', 'hide']);
  assert.equal(harness.windowQueries.length, queried, '해제 경로가 창 상태를 읽고 건너뛸 여지를 만들었다');

  // 이미 풀린 창이라고 믿더라도 다시 전부 실행한다. 믿음이 틀렸을 때 학생이 kiosk에 갇힌다.
  harness.state({ revision: 13, mode: 'practice', leaseMs: 0 });
  assert.deepEqual(harness.windowCalls.slice(-3), ['kiosk:false', 'alwaysOnTop:false', 'hide']);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
});

test('비상 해제는 몇 번을 불러도 매번 창을 풀어 준다', () => {
  const harness = bootMain();
  live(harness, 'lock', 14);
  harness.emergency();
  assert.deepEqual(harness.windowCalls.slice(-3), ['kiosk:false', 'alwaysOnTop:false', 'hide']);
  harness.emergency();
  assert.deepEqual(harness.windowCalls.slice(-3), ['kiosk:false', 'alwaysOnTop:false', 'hide']);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
});

test('accept된 모든 상태에서 agent:mode를 보낸다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 15);
  for (let round = 0; round < 3; round += 1) heartbeatState(harness, 'lecture', 15);
  // 창 조작은 첫 반영에서 한 번뿐이지만 렌더러 통보는 네 번 모두 나가야 한다.
  // (vm 안에서 만들어진 객체라 값만 비교한다 — 프로토타입이 다른 렐름에 있다.)
  assert.deepEqual(harness.modeMessages(), Array.from({ length: 4 }, () => 'lecture:15'));

  harness.state({ revision: 16, mode: 'practice', leaseMs: 0 });
  assert.equal(harness.modeMessages().at(-1), 'practice:16');

  // 거부된 상태(지난 revision)는 창도 렌더러 통보도 건드리지 않는다.
  const messages = harness.modeMessages().length;
  const applied = harness.windowCalls.length;
  harness.state({ revision: 15, mode: 'lecture', leaseMs: 15_000 });
  assert.equal(harness.modeMessages().length, messages, '거부된 상태로 모드를 통보했다');
  assert.equal(harness.windowCalls.length, applied, '거부된 상태로 창을 조작했다');
});
