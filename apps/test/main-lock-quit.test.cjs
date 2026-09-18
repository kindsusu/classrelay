'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'classrelay-test-'));
process.on('exit', () => { try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ } });
let harnessSeq = 0;

// main.cjs를 실제 whenReady 경로까지 태우는 하네스. 네이티브 InputGuard는 절대 실행하지 않는다 —
// spawn은 가짜 프로세스를 돌려주고, 이 파일이 기록하는 LOCK/UNLOCK은 개발 PC 입력에 닿지 않는다.
function bootMain(overrides = {}) {
  harnessSeq += 1;
  const dir = path.join(TEMP_ROOT, `boot-${harnessSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    role: 'agent',
    backendUrl: 'https://relay.example.invalid',
    token: 'test-token-value',
    deviceId: 'student-01',
    nativeInputLock: true,
    ...overrides
  }));

  const guardWrites = [];
  const windowCalls = [];
  const sent = [];
  const fetchCalls = [];
  const appEvents = new Map();
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  let shortcut;
  let tick;
  let socketOptions;
  let guardEnded = false;
  let quitCount = 0;
  let clock = 1_000;

  const guard = {
    stdin: {
      writable: true,
      write: (line) => guardWrites.push(line.trim()),
      end: () => { guardEnded = true; guard.stdin.writable = false; },
      on: () => {}
    },
    stdout: { setEncoding: () => {}, on: () => {} },
    stderr: { on: () => {} },
    on: () => {}
  };

  class FakeWindow {
    constructor() {
      this.webContents = { on: () => {}, send: (channel, value) => sent.push([channel, value]), setWindowOpenHandler: () => {} };
    }
    isDestroyed() { return false; }
    loadFile() {}
    on() {}
    show() { windowCalls.push('show'); }
    hide() { windowCalls.push('hide'); }
    focus() {}
    minimize() { windowCalls.push('minimize'); }
    setFullScreen(value) { windowCalls.push(`fullScreen:${value}`); }
    setKiosk(value) { windowCalls.push(`kiosk:${value}`); }
    setAlwaysOnTop(value) { windowCalls.push(`alwaysOnTop:${value}`); }
  }

  const electron = {
    app: {
      whenReady: () => ({ then: (callback) => { callback(); return { then: () => {} }; } }),
      on: (event, handler) => appEvents.set(event, handler),
      getPath: () => dir,
      getAppPath: () => dir,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => {},
      isPackaged: false,
      quit: () => { quitCount += 1; }
    },
    BrowserWindow: FakeWindow,
    desktopCapturer: { getSources: async () => [] },
    dialog: { showErrorBox: () => { throw new Error('테스트에서 오류 대화상자가 떴다'); } },
    globalShortcut: { register: (_accel, handler) => { shortcut = handler; }, unregisterAll: () => {} },
    ipcMain: {
      handle: (channel, handler) => ipcHandlers.set(channel, handler),
      on: (channel, handler) => ipcListeners.set(channel, handler)
    },
    session: { defaultSession: { setDisplayMediaRequestHandler: () => {} } }
  };

  const stubs = {
    electron,
    // InputGuard.exe가 없는 환경에서도 같은 경로를 타도록 존재 검사만 고정한다.
    'node:fs': { ...fs, existsSync: (target) => (String(target).endsWith('InputGuard.exe') ? true : fs.existsSync(target)) },
    'node:path': path,
    'node:child_process': { spawn: () => guard },
    ws: class WebSocketStub {},
    './safety.cjs': require('../src/safety.cjs'),
    './control-socket.cjs': {
      ControlSocket: class {
        constructor(options) { socketOptions = options; this.stopped = false; }
        start() {}
        stop() { this.stopped = true; }
      }
    }
  };

  const moduleStub = { exports: {} };
  const context = {
    module: moduleStub,
    __dirname: SRC,
    require: (name) => {
      if (name in stubs) return stubs[name];
      throw new Error(`예상하지 못한 require: ${name}`);
    },
    process: { ...process, platform: 'win32', env: { ...process.env, CLASSROOM_CONFIG: configPath } },
    console,
    performance: { now: () => clock },
    URL,
    AbortController,
    fetch: async (url, options) => {
      fetchCalls.push({ url, method: options?.method, body: options?.body });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, notified: 27, revision: 5 }) };
    },
    setInterval: (callback) => { tick = callback; return 0; },
    clearInterval: () => {},
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(SRC, 'main.cjs'), 'utf8'), context, { filename: 'main.cjs' });

  return {
    exports: moduleStub.exports,
    guardWrites,
    windowCalls,
    sent,
    fetchCalls,
    tick: () => tick(),
    state: (snapshot) => socketOptions.onState(snapshot),
    quitCommand: () => socketOptions.onQuit(),
    emergency: () => shortcut(),
    beforeQuit: () => appEvents.get('before-quit')(),
    pulse: (mediaReady) => ipcListeners.get('renderer:pulse')({}, mediaReady),
    invoke: (channel, ...args) => ipcHandlers.get(channel)({}, ...args),
    listen: (channel, ...args) => ipcListeners.get(channel)({}, ...args),
    advance: (ms) => { clock += ms; },
    quitCount: () => quitCount,
    guardEnded: () => guardEnded,
    socketOptions: () => socketOptions
  };
}

function live(harness, mode, revision = 1) {
  harness.pulse(true);
  harness.state({ revision, mode, leaseMs: 15_000 });
}

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

test('비실습 모드는 모두 kiosk로 작업 표시줄까지 덮는다', () => {
  for (const mode of ['broadcast', 'lecture', 'lock']) {
    const harness = bootMain();
    live(harness, mode, 3);
    assert.ok(harness.windowCalls.includes('kiosk:true'), `${mode}에서 kiosk를 켜지 않았다`);
    assert.ok(harness.windowCalls.includes('fullScreen:true'), `${mode}에서 전체화면이 아니다`);
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
