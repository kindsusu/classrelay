'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SafetyState, ALLOWED_MODES, INPUT_LOCK_MODES, locksInput } = require('../src/safety.cjs');

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

test('네 가지 모드를 모두 허용한다', () => {
  assert.deepEqual([...ALLOWED_MODES].sort(), ['broadcast', 'lecture', 'lock', 'practice']);
});

test('입력을 잠그는 모드는 lecture와 lock 둘뿐이다', () => {
  assert.equal(locksInput('lecture'), true);
  assert.equal(locksInput('lock'), true);
  assert.equal(locksInput('broadcast'), false);
  assert.equal(locksInput('practice'), false);
  assert.deepEqual([...INPUT_LOCK_MODES].sort(), ['lecture', 'lock']);
});

test('알 수 없는 값이나 잘못된 자료형은 잠금으로 보지 않는다', () => {
  for (const value of [undefined, null, '', 'LOCK', 'Lecture', 'unknown', 0, 1, true, {}, ['lock']]) {
    assert.equal(locksInput(value), false, `${JSON.stringify(value)}를 잠금으로 판정했다`);
  }
});

// lecture는 lock과 똑같이 fail-safe를 물려받아야 한다. 하나라도 빠지면 학생이 잠긴 채 남는다.
test('lecture도 15초 lease가 지나면 practice로 해제된다', () => {
  let now = 0;
  const safety = new SafetyState(() => now);
  assert.equal(safety.accept({ revision: 3, mode: 'lecture', leaseMs: 15_000 }), true);
  assert.equal(locksInput(safety.effectiveMode()), true);
  now = 15_001;
  assert.equal(safety.effectiveMode(), 'practice');
  assert.equal(locksInput(safety.effectiveMode()), false);
});

test('lecture의 비상 해제 latch는 같은 revision 재수신으로 잠기지 않는다', () => {
  const safety = new SafetyState(() => 100);
  safety.accept({ revision: 9, mode: 'lecture', leaseMs: 15_000 });
  safety.emergencyUnlock();
  safety.accept({ revision: 9, mode: 'lecture', leaseMs: 15_000 });
  assert.equal(locksInput(safety.effectiveMode()), false);
  safety.accept({ revision: 10, mode: 'lecture', leaseMs: 15_000 });
  assert.equal(locksInput(safety.effectiveMode()), true);
});

test('만료된 lecture는 같은 revision 응답으로 부활하지 않는다', () => {
  let now = 0;
  const safety = new SafetyState(() => now);
  safety.accept({ revision: 5, mode: 'lecture', leaseMs: 15_000 });
  now = 20_000;
  safety.accept({ revision: 5, mode: 'lecture', leaseMs: 15_000 });
  assert.equal(locksInput(safety.effectiveMode()), false);
});

test('강사 UI는 네 모드의 이름과 설명을 모두 가진다', () => {
  const { controllerModeLabel, MODE_LABELS } = loadRendererExports();
  assert.deepEqual(Object.keys(MODE_LABELS).sort(), ['broadcast', 'lecture', 'lock', 'practice']);
  assert.equal(controllerModeLabel('practice')[0], '실습 모드');
  assert.equal(controllerModeLabel('broadcast')[0], '화면 보여주기');
  assert.equal(controllerModeLabel('lecture')[0], '이론 모드');
  assert.equal(controllerModeLabel('lock')[0], '강사 주목');
  for (const mode of ['practice', 'broadcast', 'lecture', 'lock']) {
    const [name, description] = controllerModeLabel(mode);
    assert.equal(typeof name, 'string');
    assert.ok(description.length > 0, `${mode} 설명이 비어 있다`);
  }
});

test('모르는 모드 이름은 실습 모드 표시로 되돌린다', () => {
  const { controllerModeLabel, agentStatusText } = loadRendererExports();
  assert.deepEqual(controllerModeLabel('unknown'), controllerModeLabel('practice'));
  assert.deepEqual(controllerModeLabel(undefined), controllerModeLabel('practice'));
  assert.equal(agentStatusText('unknown'), agentStatusText('practice'));
});

// 모드 문구는 장애 안내의 접두사로만 쓰인다. 정상 상태에서는 어디에도 표시되지 않으므로
// 학생 화면에 상주하던 단축키 안내도 함께 사라졌다 — 화면에 남는 곳은 lock 차단막뿐이다.
test('잠금 모드 접두사는 입력 차단을 알리되 단축키는 담지 않는다', () => {
  const { agentStatusText, AGENT_STATUS } = loadRendererExports();
  assert.deepEqual(Object.keys(AGENT_STATUS).sort(), ['broadcast', 'lecture', 'lock', 'practice']);
  for (const mode of ['lecture', 'lock']) {
    assert.ok(agentStatusText(mode).includes('입력 차단'), `${mode} 접두사에 입력 차단 표시가 없다`);
  }
  for (const mode of ['practice', 'broadcast', 'lecture', 'lock']) {
    assert.equal(agentStatusText(mode).includes('F12'), false, `${mode} 접두사에 단축키가 남아 있다`);
  }
  assert.equal(agentStatusText('broadcast').includes('입력 차단'), false);
  assert.equal(agentStatusText('practice').includes('입력 차단'), false);
});

test('강사 주목 안내는 강의실의 강사를 보라고 말한다', () => {
  const { controllerModeLabel } = loadRendererExports();
  const html = readSource('index.html');
  assert.ok(controllerModeLabel('lock')[1].includes('강사'), '강사 주목 설명에 강사가 없다');
  assert.equal(html.includes('이론교육 진행 중'), false, '차단막에 옛 이론교육 문구가 남아 있다');
  assert.ok(/id="input-shield"[\s\S]*?강의실의 강사/.test(html), '차단막이 강사를 보라고 안내하지 않는다');
});

test('모드 전환 메시지는 각 모드가 화면과 입력에 무엇을 하는지 말한다', () => {
  const { commandMessage } = loadRendererExports();
  assert.ok(commandMessage('broadcast').includes('입력'));
  assert.ok(commandMessage('lecture').includes('입력만 차단'));
  assert.ok(commandMessage('lock').includes('가리고'));
  assert.equal(commandMessage('practice'), '명령을 전송했습니다.');
});

test('학생 앱 종료 결과는 전달 대수와 재실행 불가를 함께 알린다', () => {
  const { quitReportMessage } = loadRendererExports();
  assert.equal(quitReportMessage({ ok: true, notified: 30 }), '학생 앱 30대에 종료를 전달했습니다. 강사 앱에서는 다시 실행할 수 없습니다.');
  assert.ok(quitReportMessage({ ok: true, notified: 1 }).includes('1대'));
  assert.ok(quitReportMessage({ ok: true, notified: 0 }).includes('없었습니다'));
  for (const bad of [undefined, null, {}, { notified: -1 }, { notified: 'many' }, { notified: 1.5 }]) {
    assert.ok(quitReportMessage(bad).includes('확인하지 못했습니다'), `${JSON.stringify(bad)}를 대수로 받아들였다`);
  }
});

// main.cjs가 잠금·해제를 실제로 결정하는 곳이다. 호출처 하나라도 mode === 'lock'으로 되돌아가면
// 그 자리에서 lecture가 잠기지 않거나(이론 모드 실패) 해제되지 않아(학생이 갇힘) 위험하므로,
// 직접 비교가 다시 생기는 회귀를 소스 검사로 잡는다.
test('main.cjs의 잠금 분기는 전부 locksInput을 거친다', () => {
  const source = readSource('main.cjs');
  const direct = source.split('\n').filter((line) => /mode\s*[=!]==\s*'lock'|'lock'\s*[=!]==\s*[\w.]*mode/.test(line));
  assert.deepEqual(direct, [], `locksInput을 우회한 lock 비교가 남아 있다:\n${direct.join('\n')}`);
  assert.ok(/const \{[^}]*locksInput[^}]*\} = require\('\.\/safety\.cjs'\)/.test(source), 'safety.cjs에서 locksInput을 가져오지 않는다');
  // 잠금을 결정하는 세 자리: 네이티브 가드 부재 처리, 렌더러 응답 없음, LOCK 갱신.
  assert.ok(source.includes('nativeGuardUnavailable && locksInput(state.mode)'), '네이티브 가드 부재 처리가 locksInput을 쓰지 않는다');
  assert.equal((source.match(/locksInput\(safety\.effectiveMode\(\)\)/g) || []).length, 2, 'watchdog의 두 잠금 분기가 locksInput을 쓰지 않는다');
});

// 렌더러는 샌드박스라 safety.cjs를 require할 수 없고 입력 보호에 쓰지도 않는다. 렌더러의
// lock 비교는 어느 오버레이를 띄울지 고르는 표시 결정뿐이어야 한다 — lecture는 화면을 가리지 않는다.
test('렌더러의 lock 비교는 차단막 표시 결정 하나뿐이다', () => {
  const source = readSource('renderer.js');
  const direct = source.split('\n').filter((line) => /mode\s*[=!]==\s*'lock'/.test(line));
  assert.equal(direct.length, 1, `표시 결정 외의 lock 비교가 있다:\n${direct.join('\n')}`);
  assert.ok(direct[0].includes('const locked'));
  assert.ok(/input-shield'\)\.classList\.toggle\('hidden', !locked\)/.test(source), '차단막이 lock 전용으로 묶여 있지 않다');
});

test('이론 모드는 차단막도 안내 띠도 쓰지 않는다', () => {
  const html = readSource('index.html');
  assert.equal(html.includes('lecture-note'), false, '이론 모드 안내 띠가 남아 있다');
  const css = readSource('styles.css');
  // 차단막만 화면을 흐린다. lock은 설계상 화면을 덮지만, 그 안에도 비상 해제 단축키는 더 이상 없다 —
  // 문제는 가림이 아니라 노출이었다.
  assert.ok(/\.input-shield\{[^}]*backdrop-filter:blur/.test(css), '차단막의 흐림 처리가 사라졌다');
  assert.equal(css.includes('.lecture-note'), false, '안내 띠 CSS가 남아 있다');
  assert.equal(/id="input-shield"[\s\S]*?Ctrl \+ Shift \+ F12/.test(html), false, 'lock 차단막에 비상 해제 단축키 안내가 남아 있다');
});

// 단축키를 학생이 볼 수 있으면 전원이 잠금을 풀 수 있다 — 강사와 현장 담당자만 알아야 한다.
// 표시를 지우는 동안 main.cjs의 실제 등록까지 함께 지워지는 회귀를 막기 위해 두 조건을 한 테스트에서 같이 본다.
test('비상 해제 단축키는 학생 쪽 소스 어디에도 없고 main.cjs의 전역 등록은 그대로다', () => {
  const html = readSource('index.html');
  const css = readSource('styles.css');
  const renderer = readSource('renderer.js');
  for (const [name, source] of [['index.html', html], ['styles.css', css], ['renderer.js', renderer]]) {
    assert.equal(source.includes('F12'), false, `${name}에 단축키 흔적(F12)이 남아 있다`);
    assert.equal(source.includes('Ctrl + Shift'), false, `${name}에 단축키 흔적(띄어쓰기 표기)이 남아 있다`);
    assert.equal(source.includes('Ctrl+Shift'), false, `${name}에 단축키 흔적(붙여쓰기 표기)이 남아 있다`);
  }
  const main = readSource('main.cjs');
  assert.ok(main.includes("globalShortcut.register('CommandOrControl+Shift+F12'"), 'main.cjs의 전역 단축키 등록이 사라졌다 — fail-safe 능력이 없어졌다');
});

test('에이전트 창은 실습이 아닌 모든 모드에서 kiosk로 작업 표시줄을 덮는다', () => {
  const source = readSource('main.cjs');
  assert.equal(source.includes("setKiosk(mode === 'lock')"), false, 'kiosk가 아직 lock 전용이다');
  assert.ok(/mainWindow\.setKiosk\(true\)/.test(source), '비실습 모드에서 kiosk를 켜지 않는다');
});
