'use strict';

// main.cjs를 실제 whenReady 경로까지 태우는 하네스. 네이티브 InputGuard는 절대 실행하지 않는다 —
// spawn은 가짜 프로세스를 돌려주고, 이 파일이 기록하는 LOCK/UNLOCK은 개발 PC 입력에 닿지 않는다.
// 창 조작 검증이 두 테스트 파일에 걸쳐 있으므로 가짜 창의 상태 모형은 여기 한 곳에만 둔다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'classrelay-test-'));
process.on('exit', () => { try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ } });
let harnessSeq = 0;

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
  const windowQueries = [];
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
  let windowInstance;

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

  // 실제 창처럼 상태를 들고 있어야 "이미 그 상태면 건드리지 않는다"를 검증할 수 있다.
  // Windows의 Electron은 kiosk를 전체화면 전환으로 구현하고 isKiosk()가 isFullScreen()과
  // 같은 값을 돌려주므로(NativeWindowViews::SetKiosk → SetFullScreen) 가짜 창도 그렇게 둔다.
  class FakeWindow {
    constructor() {
      this.webContents = { on: () => {}, send: (channel, value) => sent.push([channel, value]), setWindowOpenHandler: () => {} };
      this.destroyed = false;
      this.visible = false;
      this.minimized = false;
      this.kiosk = false;
      this.fullScreen = false;
      this.alwaysOnTop = false;
      windowInstance = this;
    }
    isDestroyed() { return this.destroyed; }
    loadFile() {}
    on() {}
    isVisible() { windowQueries.push('isVisible'); return this.visible && !this.minimized; }
    isKiosk() { windowQueries.push('isKiosk'); return this.kiosk; }
    isFullScreen() { windowQueries.push('isFullScreen'); return this.fullScreen; }
    isAlwaysOnTop() { windowQueries.push('isAlwaysOnTop'); return this.alwaysOnTop; }
    show() { this.visible = true; this.minimized = false; windowCalls.push('show'); }
    hide() { this.visible = false; windowCalls.push('hide'); }
    focus() { windowCalls.push('focus'); }
    minimize() { this.minimized = true; windowCalls.push('minimize'); }
    setFullScreen(value) { this.fullScreen = value; windowCalls.push(`fullScreen:${value}`); }
    setKiosk(value) { this.kiosk = value; this.fullScreen = value; windowCalls.push(`kiosk:${value}`); }
    setAlwaysOnTop(value) { this.alwaysOnTop = value; windowCalls.push(`alwaysOnTop:${value}`); }
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
    windowQueries,
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
    socketOptions: () => socketOptions,
    window: () => windowInstance,
    // vm 안에서 만들어진 객체는 프로토타입이 다른 렐름에 있어 deepStrictEqual이 통과하지 못한다.
    // 모드 통보는 값만 중요하므로 문자열로 눌러서 돌려준다.
    modeMessages: () => sent
      .filter(([channel]) => channel === 'agent:mode')
      .map(([, value]) => `${value?.mode}:${value?.revision}`)
  };
}

// 살아 있는 학생 앱 한 번의 상태 수신. 하트비트마다 같은 프레임이 다시 오는 것까지 흉내내려면
// 같은 revision·mode로 여러 번 부르면 된다 — 서버가 실제로 그렇게 보낸다.
function live(harness, mode, revision = 1) {
  harness.pulse(true);
  harness.state({ revision, mode, leaseMs: 15_000 });
}

function readSource(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

module.exports = { bootMain, live, readSource, SRC };
