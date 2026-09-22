'use strict';

// 실기기에서 종료 명령을 받은 학생 앱이 송출만 끊고 프로세스는 남았다. app.quit()은 창 정리에서
// 멈출 수 있으므로 3초 강제 종료 보험이 있어야 하고, run.bat 두 번 실행이 같은 deviceId로 두
// 프로세스를 띄워 서로를 1012로 밀어내는 것은 단일 인스턴스 잠금으로 막는다.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootMain, live } = require('./boot-main.cjs');

test('종료 명령은 app.quit() 뒤 3초 강제 종료를 예약하고, 그 타이머는 정상 종료를 붙잡지 않는다', () => {
  const harness = bootMain();
  live(harness, 'lecture', 9);
  harness.quitCommand();
  assert.equal(harness.quitCount(), 1, 'app.quit()을 먼저 부르지 않았다');
  const [fallback, ...rest] = harness.timeouts(3_000);
  assert.ok(fallback, '3초 강제 종료를 예약하지 않았다');
  assert.equal(rest.length, 0);
  assert.equal(fallback.unrefed, true, '강제 종료 타이머가 정상 종료를 붙잡는다');
  assert.deepEqual(harness.exitCalls(), [], '3초 전에 강제 종료했다');
  fallback.run();
  assert.deepEqual(harness.exitCalls(), [0]);
});

test('강사 앱은 종료 명령에 강제 종료도 예약하지 않는다', () => {
  const harness = bootMain({ role: 'controller', deviceId: 'instructor', nativeInputLock: false });
  harness.quitCommand();
  assert.equal(harness.quitCount(), 0);
  assert.equal(harness.timeouts(3_000).length, 0);
});

test('두 번째 인스턴스는 창·소켓·IPC를 만들지 않고 즉시 물러난다', () => {
  const second = bootMain({}, { singleInstanceLock: false });
  assert.equal(second.quitCount(), 1);
  assert.equal(second.window(), undefined, '두 번째 인스턴스가 창을 만들었다');
  assert.equal(second.socketOptions(), undefined, '두 번째 인스턴스가 제어 소켓을 열었다');
  assert.deepEqual(second.ipcChannels(), [], '두 번째 인스턴스가 IPC를 등록했다');
  assert.equal(second.guardWrites.length, 0);
});

test('첫 인스턴스는 잠금을 얻고 평소대로 시작한다', () => {
  const first = bootMain();
  assert.equal(first.quitCount(), 0);
  assert.ok(first.window());
  assert.ok(first.socketOptions());
  assert.ok(first.ipcChannels().includes('api:quit-agents'));
});

test('강사 앱만 두 번째 실행에 창을 앞으로 가져온다', () => {
  const controller = bootMain({ role: 'controller', deviceId: 'instructor', nativeInputLock: false });
  controller.window().minimized = true;
  controller.secondInstance();
  assert.deepEqual(controller.windowCalls.slice(-2), ['restore', 'focus']);

  const agent = bootMain();
  agent.secondInstance();
  assert.equal(agent.windowCalls.includes('focus'), false, '학생 앱이 두 번째 실행에 창을 띄웠다');
  assert.equal(agent.windowCalls.includes('restore'), false);
});
