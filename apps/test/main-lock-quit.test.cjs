'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootMain, live } = require('./boot-main.cjs');

test('이론 모드도 강사 주목과 똑같이 네이티브 잠금을 갱신한다', () => {
  for (const mode of ['lecture', 'lock']) {
    const harness = bootMain();
    live(harness, mode, 4);
    harness.tick();
    assert.equal(harness.guardWrites.at(-1), 'LOCK 4', `${mode}에서 잠금을 갱신하지 않았다`);
  }
});

test('화면 보여주기는 입력을 잠그지 않는다', () => {
  const harness = bootMain();
  live(harness, 'broadcast', 2);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
});

// 작업 표시줄을 덮는 것은 kiosk 하나로 끝난다. Windows에서 kiosk 진입이 곧 전체화면 전환이므로
// setFullScreen(true)를 따로 부르면 한 번의 반영에서 전환이 두 번 일어난다(학생 화면 번쩍임).
test('비실습 모드는 모두 kiosk로 작업 표시줄까지 덮는다', () => {
  for (const mode of ['broadcast', 'lecture', 'lock']) {
    const harness = bootMain();
    live(harness, mode, 3);
    assert.ok(harness.windowCalls.includes('kiosk:true'), `${mode}에서 kiosk를 켜지 않았다`);
    assert.equal(harness.window().fullScreen, true, `${mode}에서 전체화면이 아니다`);
    assert.equal(harness.windowCalls.includes('fullScreen:true'), false, `${mode}에서 전체화면 전환을 두 번 했다`);
    assert.ok(harness.windowCalls.includes('alwaysOnTop:true'));
  }
});

test('실습 모드는 kiosk와 항상 위를 벗고 창을 숨긴다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 3);
  harness.state({ revision: 4, mode: 'practice', leaseMs: 0 });
  assert.deepEqual(harness.windowCalls.slice(-3), ['kiosk:false', 'alwaysOnTop:false', 'hide']);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
});

test('이론 모드에서 렌더러가 응답하지 않으면 잠금을 해제한다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 6);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'LOCK 6');
  harness.advance(5_000);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
  // 해제는 해당 revision에 latch된다. 렌더러가 살아 돌아와도 같은 명령으로 다시 잠기지 않는다.
  harness.pulse(true);
  harness.state({ revision: 6, mode: 'lecture', leaseMs: 15_000 });
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
});

test('이론 모드도 lease가 끝나면 잠금을 해제한다', () => {
  const harness = bootMain();
  harness.pulse(true);
  harness.state({ revision: 7, mode: 'lecture', leaseMs: 0 });
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
});

test('비상 해제 단축키는 이론 모드에서도 즉시 듣는다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 8);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'LOCK 8');
  harness.emergency();
  assert.deepEqual(harness.windowCalls.slice(-3), ['kiosk:false', 'alwaysOnTop:false', 'hide']);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
});

test('강사 종료 명령은 입력 차단을 해제한 뒤에 앱을 종료한다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 9);
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'LOCK 9');

  harness.quitCommand();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK', '종료 전에 UNLOCK을 보내지 않았다');
  assert.equal(harness.guardEnded(), true, 'InputGuard 표준입력을 닫지 않았다');
  assert.ok(harness.windowCalls.includes('kiosk:false'), 'kiosk를 벗지 않았다');
  assert.ok(harness.windowCalls.includes('alwaysOnTop:false'), '항상 위를 벗지 않았다');
  assert.equal(harness.quitCount(), 1);
  assert.equal(harness.socketOptions().onQuit.length, 0);
});

test('종료는 크래시로 오인되지 않고 before-quit을 다시 타도 안전하다', () => {
  const harness = bootMain();
  live(harness, 'lock', 10);
  harness.quitCommand();
  const notices = harness.sent.filter(([channel]) => channel === 'agent:notice');
  // stopping이 서 있어야 비상 해제 안내가 아니라 종료 안내만 남는다.
  assert.equal(notices.length, 1);
  assert.ok(notices[0][1].includes('종료'));
  assert.equal(notices.some(([, text]) => text.includes('비상 해제됨')), false);

  const before = harness.guardWrites.length;
  harness.beforeQuit();
  assert.equal(harness.guardWrites.length, before, 'before-quit이 파이프에 다시 썼다');
  harness.tick();
  assert.equal(harness.guardWrites.at(-1), 'UNLOCK');
});

test('학생 앱은 종료 명령을 학생 앱에서만 처리한다', () => {
  const harness = bootMain({ role: 'controller', deviceId: 'instructor' });
  harness.quitCommand();
  assert.equal(harness.quitCount(), 0);
});

test('강사 앱만 학생 앱 종료 경로를 호출할 수 있다', async () => {
  const controller = bootMain({ role: 'controller', deviceId: 'instructor', nativeInputLock: false });
  const result = await controller.invoke('api:quit-agents');
  assert.equal(result.ok, true);
  assert.equal(result.notified, 27);
  const call = controller.fetchCalls.at(-1);
  assert.ok(call.url.endsWith('/api/agents/quit'));
  assert.equal(call.method, 'POST');

  const agent = bootMain();
  assert.throws(() => agent.invoke('api:quit-agents'), /controller 전용/);
});

test('실습 시작만 강사 창을 작업 표시줄로 내린다', () => {
  const harness = bootMain({ role: 'controller', deviceId: 'instructor', nativeInputLock: false });
  harness.listen('window:background');
  assert.equal(harness.windowCalls.filter((entry) => entry === 'minimize').length, 1);

  const agent = bootMain();
  agent.listen('window:background');
  assert.equal(agent.windowCalls.includes('minimize'), false, '학생 앱 창을 최소화했다');
});

test('네 모드 모두 강사 모드 명령으로 통과한다', async () => {
  const harness = bootMain({ role: 'controller', deviceId: 'instructor', nativeInputLock: false });
  for (const mode of ['practice', 'broadcast', 'lecture', 'lock']) {
    await harness.invoke('api:mode', { mode });
    assert.equal(harness.fetchCalls.at(-1).body, JSON.stringify({ mode }));
  }
  assert.throws(() => harness.invoke('api:mode', { mode: 'unknown' }), /허용되지 않은 모드/);
});
