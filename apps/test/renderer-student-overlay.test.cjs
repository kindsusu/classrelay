'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRendererExports() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const module = { exports: {} };
  const never = new Promise(() => {});
  const context = {
    module,
    window: { classroom: { getConfig: () => never } },
    document: { getElementById: () => null, body: {} },
    navigator: {},
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

// 학생 화면은 발표 모드다. 정상이면 영상만 남고, 고장났을 때만 말한다.
test('정상 상태의 학생 화면에는 어떤 문구도 올리지 않는다', () => {
  const { agentOverlayText } = loadRendererExports();
  for (const mode of ['practice', 'broadcast', 'lecture', 'lock']) {
    assert.equal(agentOverlayText({ mode, revision: 4, offline: false, subscribe: '', released: '' }), '', `${mode}에서 문구가 남는다`);
  }
  assert.equal(agentOverlayText(null), '');
  assert.equal(agentOverlayText(undefined), '');
  assert.equal(agentOverlayText({}), '');
});

test('제어 연결이 끊기면 남은 시간과 현재 잠금 상태를 함께 알린다', () => {
  const { agentOverlayText, AGENT_OFFLINE_TEXT } = loadRendererExports();
  const lecture = agentOverlayText({ mode: 'lecture', offline: true });
  assert.ok(lecture.includes('서버 재연결 중'), '재연결 상태를 말하지 않는다');
  assert.ok(lecture.includes('15초'), '자동 해제까지의 시간을 말하지 않는다');
  assert.ok(lecture.includes('이론 모드'), '어느 모드에서 끊겼는지 말하지 않는다');
  assert.ok(lecture.includes('입력 차단'), '입력이 아직 잠겨 있다는 사실을 말하지 않는다');
  // 실습은 창 자체가 숨겨지는 모드라 접두사를 붙이지 않는다.
  assert.equal(agentOverlayText({ mode: 'practice', offline: true }), AGENT_OFFLINE_TEXT);
});

test('구독 재시도와 실패 안내는 그대로 학생 화면에 남는다', () => {
  const { agentOverlayText } = loadRendererExports();
  const retry = agentOverlayText({ mode: 'broadcast', subscribe: '영상 재연결 시도 2/3' });
  assert.ok(retry.includes('영상 재연결 시도 2/3'));
  assert.ok(retry.includes('화면 보여주기'));
  const failed = agentOverlayText({ mode: 'lock', subscribe: '영상 연결 실패 · 강사에게 알려주세요 (타임아웃)' });
  assert.ok(failed.includes('영상 연결 실패'));
  assert.ok(failed.includes('강사 주목'));
});

test('제어 연결 끊김이 구독 재시도보다 먼저 보인다', () => {
  const { agentOverlayText, AGENT_OFFLINE_TEXT } = loadRendererExports();
  const both = agentOverlayText({ mode: 'lecture', offline: true, subscribe: '영상 재연결 시도 1/3' });
  assert.ok(both.includes(AGENT_OFFLINE_TEXT), '근본 원인인 제어 연결 끊김이 가려졌다');
  assert.equal(both.includes('영상 재연결 시도'), false);
});

// 프리즈 안전 해제와 비상 해제 문구는 잠금이 이미 풀린 상태다. 여기에 '입력 차단 중'을
// 덧붙이면 학생에게 거짓을 말하게 된다.
test('해제 문구는 최우선으로 보이고 잠금 접두사를 붙이지 않는다', () => {
  const { agentOverlayText } = loadRendererExports();
  const released = '강사 화면 신호가 3초 이상 멈춰 입력 차단을 해제했습니다. 강사의 새 명령을 기다립니다.';
  const alert = { mode: 'lecture', offline: true, subscribe: '영상 재연결 시도 3/3', released };
  assert.equal(agentOverlayText(alert), released);
  assert.equal(agentOverlayText(alert).includes('입력 차단 중'), false);
  const notice = '비상 해제됨 (영상 연결 실패). 새 명령 전까지 유지됩니다.';
  assert.equal(agentOverlayText({ mode: 'lock', released: notice }), notice);
});

// 해제는 그 revision 동안 유지된다는 fail-safe 규칙을 화면 문구도 그대로 따른다.
test('해제 문구는 같은 revision 재수신으로 지워지지 않고 새 명령에서만 사라진다', () => {
  const { alertClearedByRevision } = loadRendererExports();
  const alert = { revision: 9 };
  assert.equal(alertClearedByRevision(alert, 9), false, '같은 revision이 해제 문구를 지웠다');
  assert.equal(alertClearedByRevision(alert, 8), false, '오래된 revision이 해제 문구를 지웠다');
  assert.equal(alertClearedByRevision(alert, 10), true, '새 명령이 학생 화면을 조용하게 만들지 못한다');
  for (const bad of [undefined, null, '10', 10.5, NaN]) {
    assert.equal(alertClearedByRevision(alert, bad), false, `${String(bad)}를 revision으로 받아들였다`);
  }
  assert.equal(alertClearedByRevision(null, 10), false);
  assert.equal(alertClearedByRevision({}, 10), false);
});

test('이론 모드도 강사 주목도 학생 화면에 비상 해제 단축키를 띄우지 않는다', () => {
  const html = readSource('index.html');
  assert.equal(html.includes('lecture-note'), false, '안내 띠 요소가 남아 있다');
  // 단축키는 강사와 현장 담당자만 알아야 한다. lock 차단막이 화면을 덮더라도 노출해도 되는 이유는 아니므로
  // 예외를 두지 않는다 — 두 표기 모두 학생 화면 어디에도 없어야 한다.
  assert.equal((html.match(/Ctrl \+ Shift \+ F12/g) || []).length, 0, '단축키 안내(띄어쓰기 표기)가 학생 화면에 남아 있다');
  assert.equal((html.match(/Ctrl\+Shift\+F12/g) || []).length, 0, '단축키 안내(붙여쓰기 표기)가 학생 화면에 남아 있다');
});

test('학생 화면에서 실측 통계 줄을 없애고 강사 화면에는 그대로 둔다', () => {
  const html = readSource('index.html');
  const css = readSource('styles.css');
  const source = readSource('renderer.js');
  assert.equal(html.includes('agent-detail'), false, '학생 통계 요소가 남아 있다');
  assert.equal(css.includes('.agent-detail'), false, '학생 통계 CSS가 남아 있다');
  assert.equal(source.includes('setAgentDetail'), false, '학생 통계 표시 코드가 남아 있다');
  // 강사 계측은 실측 수치로 용량 계획을 대체하는 근거라 그대로 유지한다.
  assert.ok(html.includes('id="publish-stats"'), '강사 통계 요소가 사라졌다');
  assert.ok(/\$\('publish-stats'\)/.test(source), '강사 통계 표시 코드가 사라졌다');
  assert.ok(/formatMediaLine\(publishSample, sample, 'bytesSent'\)/.test(source), '강사 송출 실측 줄이 사라졌다');
});

test('학생 쪽 수신 통계 폴링은 프리즈 감지용으로 계속 돈다', () => {
  const source = readSource('renderer.js');
  assert.ok(/inboundStatsTimer = setInterval/.test(source), '수신 통계 폴링이 사라졌다');
  assert.ok(/inboundProgress = evaluateVideoProgress\(inboundProgress, sample\)/.test(source), '프리즈 진행 판정이 사라졌다');
  assert.ok(/if \(inboundProgress\.frozen\) declareFreeze\(generation\)/.test(source), '프리즈 안전 해제 호출이 사라졌다');
});

test('빈 문구는 오버레이 자체를 숨긴다', () => {
  const css = readSource('styles.css');
  const source = readSource('renderer.js');
  const html = readSource('index.html');
  assert.ok(css.includes('.agent-status:empty{display:none}'), '빈 오버레이가 여전히 상자를 그린다');
  assert.ok(/id="agent-status" class="agent-status hidden"/.test(html), '오버레이가 숨김 상태로 시작하지 않는다');
  assert.ok(/el\.classList\.toggle\('hidden', !text\)/.test(source), '문구가 없을 때 오버레이를 숨기지 않는다');
});
