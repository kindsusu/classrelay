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

// 라이브 SFU 실측: 세션 생성에 sessionDescription이 없으면 400 decoding_error가 온다.
// 예전 api()는 body.error만 읽어 이 이유를 버리고 '서버 오류 400'만 보여줬다.
test('SFU 오류 본문의 errorCode·errorDescription을 메시지에 남긴다', () => {
  const { describeApiError } = loadMainExports();
  const message = describeApiError(400, {
    errorCode: 'decoding_error',
    errorDescription: 'Body JSON validation error: sessionDescription'
  });
  assert.equal(message, '서버 오류 400 · decoding_error: Body JSON validation error: sessionDescription');
});

test('errorCode나 errorDescription 한쪽만 있어도 남긴다', () => {
  const { describeApiError } = loadMainExports();
  assert.equal(describeApiError(400, { errorCode: 'decoding_error' }), '서버 오류 400 · decoding_error');
  assert.equal(describeApiError(500, { errorDescription: 'internal failure' }), '서버 오류 500 · internal failure');
});

test('Worker 자체 오류(error 필드)도 상태 코드와 함께 남긴다', () => {
  const { describeApiError } = loadMainExports();
  assert.equal(describeApiError(401, { error: 'unauthorized' }), '서버 오류 401 · unauthorized');
  assert.equal(describeApiError(502, { error: 'Realtime service unavailable' }), '서버 오류 502 · Realtime service unavailable');
});

test('읽을 만한 내용이 없으면 상태 코드만 남긴다', () => {
  const { describeApiError } = loadMainExports();
  assert.equal(describeApiError(503, null), '서버 오류 503');
  assert.equal(describeApiError(503, {}), '서버 오류 503');
  assert.equal(describeApiError(503, { errorCode: '   ', error: 42 }), '서버 오류 503');
});

test('SDP를 담은 오류 본문은 메시지로 옮기지 않는다', () => {
  const { describeApiError } = loadMainExports();
  const sdp = 'v=0\r\no=- 123456 2 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fingerprint:sha-256 AA:BB\r\n';
  const message = describeApiError(400, { errorCode: 'decoding_error', errorDescription: sdp });
  assert.equal(message, '서버 오류 400 · decoding_error');
  assert.equal(message.includes('v=0'), false);
  assert.equal(message.includes('fingerprint'), false);
  assert.equal(describeApiError(400, { error: `rejected offer ${sdp}` }), '서버 오류 400');
});

test('자격증명처럼 보이는 불투명 문자열은 값을 보여주지 않는다', () => {
  const { describeApiError } = loadMainExports();
  const message = describeApiError(401, { errorDescription: 'token eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123456789 rejected' });
  assert.equal(message.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.equal(message.includes('[생략]'), true);
});

test('업스트림 본문을 그대로 쏟지 않도록 길이를 제한한다', () => {
  const { describeApiError, API_ERROR_MAX } = loadMainExports();
  const long = 'why '.repeat(200);
  const message = describeApiError(400, { errorDescription: long });
  assert.equal(API_ERROR_MAX, 160);
  assert.equal(message.length <= `서버 오류 400 · `.length + API_ERROR_MAX + 1, true);
  assert.equal(message.endsWith('…'), true);
});

test('여러 줄 본문은 한 줄로 접어 메시지 줄을 깨지 않는다', () => {
  const { describeApiError } = loadMainExports();
  assert.equal(describeApiError(400, { errorDescription: 'first line\r\n  second line' }), '서버 오류 400 · first line second line');
});
