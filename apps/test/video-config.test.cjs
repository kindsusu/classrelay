'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMainExports() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  const moduleStub = { exports: {} };
  const noop = () => {};
  const electron = {
    app: {
      whenReady: () => ({ then: noop }),
      on: noop,
      getPath: () => '',
      getAppPath: () => '',
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: noop,
      isPackaged: false,
      quit: noop,
      exit: noop,
      requestSingleInstanceLock: () => true
    },
    BrowserWindow: class {},
    desktopCapturer: { getSources: async () => [] },
    dialog: { showErrorBox: noop },
    globalShortcut: { register: noop, unregisterAll: noop },
    ipcMain: { handle: noop, on: noop },
    session: { defaultSession: { setDisplayMediaRequestHandler: noop } }
  };
  const stubs = {
    electron,
    'node:fs': fs,
    'node:path': path,
    'node:child_process': require('node:child_process'),
    ws: class WebSocketStub {},
    './safety.cjs': require('../src/safety.cjs'),
    './control-socket.cjs': require('../src/control-socket.cjs')
  };
  const context = {
    module: moduleStub,
    require: (name) => {
      if (name in stubs) return stubs[name];
      throw new Error(`예상하지 못한 require: ${name}`);
    },
    process,
    console,
    performance,
    URL,
    AbortController,
    fetch: noop,
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(code, context, { filename: 'main.cjs' });
  return moduleStub.exports;
}

test('video 블록이 없으면 기본 상한을 적용한다', () => {
  const { resolveVideoConfig } = loadMainExports();
  const resolved = resolveVideoConfig(undefined);
  assert.equal(resolved.maxHeight, 720);
  assert.equal(resolved.maxFps, 15);
  assert.equal(resolved.maxBitrateKbps, 2_000);
  assert.equal(resolveVideoConfig(null).maxHeight, 720);
});

test('일부 항목만 지정하면 나머지는 기본값으로 채운다', () => {
  const { resolveVideoConfig } = loadMainExports();
  const resolved = resolveVideoConfig({ maxHeight: 1080 });
  assert.equal(resolved.maxHeight, 1_080);
  assert.equal(resolved.maxFps, 15);
  assert.equal(resolved.maxBitrateKbps, 2_000);
});

test('범위 경계값은 허용한다', () => {
  const { resolveVideoConfig } = loadMainExports();
  const low = resolveVideoConfig({ maxHeight: 360, maxFps: 5, maxBitrateKbps: 300 });
  assert.equal(low.maxHeight, 360);
  assert.equal(low.maxFps, 5);
  assert.equal(low.maxBitrateKbps, 300);
  const high = resolveVideoConfig({ maxHeight: 1440, maxFps: 30, maxBitrateKbps: 8_000 });
  assert.equal(high.maxHeight, 1_440);
  assert.equal(high.maxFps, 30);
  assert.equal(high.maxBitrateKbps, 8_000);
});

test('범위를 벗어난 값은 한국어 오류로 거부한다', () => {
  const { resolveVideoConfig } = loadMainExports();
  assert.throws(() => resolveVideoConfig({ maxHeight: 359 }), /video\.maxHeight는 360~1440 사이 정수여야 합니다\./);
  assert.throws(() => resolveVideoConfig({ maxHeight: 1_441 }), /video\.maxHeight/);
  assert.throws(() => resolveVideoConfig({ maxFps: 4 }), /video\.maxFps는 5~30 사이 정수여야 합니다\./);
  assert.throws(() => resolveVideoConfig({ maxFps: 31 }), /video\.maxFps/);
  assert.throws(() => resolveVideoConfig({ maxBitrateKbps: 299 }), /video\.maxBitrateKbps는 300~8000 사이 정수여야 합니다\./);
  assert.throws(() => resolveVideoConfig({ maxBitrateKbps: 8_001 }), /video\.maxBitrateKbps/);
});

test('정수가 아닌 값과 잘못된 자료형을 거부한다', () => {
  const { resolveVideoConfig } = loadMainExports();
  assert.throws(() => resolveVideoConfig({ maxFps: 15.5 }), /video\.maxFps/);
  assert.throws(() => resolveVideoConfig({ maxFps: '15' }), /video\.maxFps/);
  assert.throws(() => resolveVideoConfig({ maxHeight: NaN }), /video\.maxHeight/);
  assert.throws(() => resolveVideoConfig('720p'), /video는 객체여야 합니다\./);
  assert.throws(() => resolveVideoConfig([720]), /video는 객체여야 합니다\./);
});

test('오타 난 항목은 조용히 무시하지 않고 거부한다', () => {
  const { resolveVideoConfig } = loadMainExports();
  assert.throws(() => resolveVideoConfig({ maxFPS: 15 }), /video에 알 수 없는 항목이 있습니다: maxFPS/);
});

test('예시 설정 파일의 video 블록이 검증을 통과한다', () => {
  const { resolveVideoConfig } = loadMainExports();
  for (const name of ['config.controller.example.json', 'config.agent.example.json']) {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));
    const resolved = resolveVideoConfig(parsed.video);
    assert.equal(resolved.maxHeight, 720);
    assert.equal(resolved.maxFps, 15);
    assert.equal(resolved.maxBitrateKbps, 2_000);
  }
});
