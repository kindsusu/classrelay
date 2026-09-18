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

// 프리즈 판정: 1초 폴링 기준으로 3초(연속 3회 무진행)를 넘겨야 해제가 발동한다.
test('디코딩 프레임이 계속 늘어나면 프리즈로 보지 않는다', () => {
  const { evaluateVideoProgress } = loadRendererExports();
  let progress = null;
  for (let tick = 0; tick <= 10; tick += 1) {
    progress = evaluateVideoProgress(progress, { at: tick * 1_000, framesDecoded: tick * 15, bytesReceived: tick * 40_000 });
    assert.equal(progress.frozen, false);
  }
});

test('한두 번의 폴링 결함으로는 잠금을 영구 해제하지 않는다', () => {
  const { evaluateVideoProgress, FREEZE_MS } = loadRendererExports();
  assert.equal(FREEZE_MS, 3_000);
  let progress = evaluateVideoProgress(null, { at: 0, framesDecoded: 100 });
  progress = evaluateVideoProgress(progress, { at: 1_000, framesDecoded: 100 });
  assert.equal(progress.stalledMs, 1_000);
  assert.equal(progress.frozen, false);
  progress = evaluateVideoProgress(progress, { at: 2_000, framesDecoded: 100 });
  assert.equal(progress.stalledMs, 2_000);
  assert.equal(progress.frozen, false);
});

test('3초 동안 디코딩 프레임이 늘지 않으면 프리즈로 판정한다', () => {
  const { evaluateVideoProgress } = loadRendererExports();
  let progress = evaluateVideoProgress(null, { at: 0, framesDecoded: 100 });
  progress = evaluateVideoProgress(progress, { at: 1_000, framesDecoded: 100 });
  progress = evaluateVideoProgress(progress, { at: 2_000, framesDecoded: 100 });
  progress = evaluateVideoProgress(progress, { at: 3_000, framesDecoded: 100 });
  assert.equal(progress.stalledMs, 3_000);
  assert.equal(progress.frozen, true);
});

test('정지 뒤 프레임이 다시 늘면 프리즈 판정이 초기화된다', () => {
  const { evaluateVideoProgress } = loadRendererExports();
  let progress = evaluateVideoProgress(null, { at: 0, framesDecoded: 100 });
  progress = evaluateVideoProgress(progress, { at: 2_500, framesDecoded: 100 });
  assert.equal(progress.frozen, false);
  progress = evaluateVideoProgress(progress, { at: 3_200, framesDecoded: 101 });
  assert.equal(progress.stalledMs, 0);
  assert.equal(progress.frozen, false);
  progress = evaluateVideoProgress(progress, { at: 5_000, framesDecoded: 101 });
  assert.equal(progress.stalledMs, 1_800);
  assert.equal(progress.frozen, false);
});

test('framesDecoded가 없으면 bytesReceived로 진행을 판단한다', () => {
  const { videoProgressValue, evaluateVideoProgress } = loadRendererExports();
  assert.equal(videoProgressValue({ bytesReceived: 5_000 }), 5_000);
  assert.equal(videoProgressValue({ framesDecoded: 7, bytesReceived: 5_000 }), 7);
  let progress = evaluateVideoProgress(null, { at: 0, bytesReceived: 5_000 });
  progress = evaluateVideoProgress(progress, { at: 3_000, bytesReceived: 5_000 });
  assert.equal(progress.frozen, true);
});

test('통계를 전혀 읽지 못하는 환경은 프리즈로 단정하지 않는다', () => {
  const { evaluateVideoProgress } = loadRendererExports();
  let progress = evaluateVideoProgress(null, { at: 0 });
  assert.equal(progress.frozen, false);
  progress = evaluateVideoProgress(progress, { at: 9_000 });
  assert.equal(progress.frozen, false);
});

test('시계가 뒤로 가도 프리즈로 오판하지 않는다', () => {
  const { evaluateVideoProgress } = loadRendererExports();
  let progress = evaluateVideoProgress(null, { at: 10_000, framesDecoded: 50 });
  progress = evaluateVideoProgress(progress, { at: 4_000, framesDecoded: 50 });
  assert.equal(progress.stalledMs, 0);
  assert.equal(progress.frozen, false);
});

test('재구독은 서버 상태가 계속 비실습이고 스트림이 있을 때만 제한 횟수까지 시도한다', () => {
  const { shouldResubscribe, MAX_RESUBSCRIBE_ATTEMPTS, RESUBSCRIBE_BACKOFF_MS } = loadRendererExports();
  const active = { mode: 'lock', stream: { sessionId: 'sess-1', trackName: 'screen-1' } };
  assert.equal(MAX_RESUBSCRIBE_ATTEMPTS, 3);
  assert.equal(RESUBSCRIBE_BACKOFF_MS.length, 3);
  assert.equal(shouldResubscribe(active, 0), true);
  assert.equal(shouldResubscribe(active, 2), true);
  assert.equal(shouldResubscribe(active, 3), false);
});

test('비상 해제 뒤 내려오는 practice·stream:null 상태는 재구독을 막는다', () => {
  const { shouldResubscribe } = loadRendererExports();
  assert.equal(shouldResubscribe({ mode: 'practice', stream: null }, 0), false);
  assert.equal(shouldResubscribe({ mode: 'practice', stream: { sessionId: 'sess-1', trackName: 'screen-1' } }, 0), false);
  assert.equal(shouldResubscribe({ mode: 'lock', stream: null }, 0), false);
  assert.equal(shouldResubscribe({ mode: 'broadcast', stream: { sessionId: 'sess-1' } }, 0), false);
  assert.equal(shouldResubscribe(null, 0), false);
});

test('연결 수와 영상 수신 수를 따로 센다', () => {
  const { summarizeRoster } = loadRendererExports();
  const now = 1_000_000;
  const students = [
    { deviceId: 'student-01', lastSeen: now - 1_000, mediaReady: true },
    { deviceId: 'student-02', lastSeen: now - 14_999, mediaReady: true },
    { deviceId: 'student-03', lastSeen: now - 2_000, mediaReady: false },
    { deviceId: 'student-04', lastSeen: now - 2_000 },
    { deviceId: 'student-05', lastSeen: now - 15_001, mediaReady: true }
  ];
  const live = summarizeRoster(students, now);
  assert.equal(live.connected, 4);
  assert.equal(live.media, 2);
  assert.equal(summarizeRoster([], now).connected, 0);
  assert.equal(summarizeRoster([], now).media, 0);
  assert.equal(summarizeRoster(undefined, now).connected, 0);
  assert.equal(summarizeRoster(undefined, now).media, 0);
});

test('outbound 통계에서 해상도·fps·전송량·손실을 뽑는다', () => {
  const { outboundVideoSample, formatMediaLine } = loadRendererExports();
  const first = outboundVideoSample([
    { type: 'outbound-rtp', kind: 'video', remoteId: 'RI1', frameWidth: 1_280, frameHeight: 720, framesPerSecond: 14, bytesSent: 0, packetsSent: 0 },
    { type: 'outbound-rtp', kind: 'audio', bytesSent: 999 },
    { type: 'remote-inbound-rtp', id: 'RI1', kind: 'video', packetsLost: 0, fractionLost: 0 }
  ], 0);
  const second = outboundVideoSample([
    { type: 'outbound-rtp', kind: 'video', remoteId: 'RI1', frameWidth: 1_280, frameHeight: 720, framesPerSecond: 14, bytesSent: 225_000, packetsSent: 1_000 },
    { type: 'remote-inbound-rtp', id: 'RI1', kind: 'video', packetsLost: 1, fractionLost: 0.001 }
  ], 1_000);
  assert.equal(first.width, 1_280);
  assert.equal(second.bytesSent, 225_000);
  assert.equal(formatMediaLine(first, second, 'bytesSent'), '1280×720 · 14fps · 1.8Mbps · 손실 0.1%');
});

test('inbound 통계에서 해상도·fps·수신량을 뽑는다', () => {
  const { inboundVideoSample, formatMediaLine } = loadRendererExports();
  const stats = (bytes, at) => inboundVideoSample([
    { type: 'inbound-rtp', kind: 'video', frameWidth: 1_280, frameHeight: 720, framesPerSecond: 15, framesDecoded: 150, bytesReceived: bytes }
  ], at);
  assert.equal(formatMediaLine(stats(0, 0), stats(60_000, 1_000), 'bytesReceived'), '1280×720 · 15fps · 480kbps');
  assert.equal(formatMediaLine(null, stats(0, 0), 'bytesReceived'), '1280×720 · 15fps');
});

test('영상 통계가 없으면 표시 줄을 만들지 않는다', () => {
  const { outboundVideoSample, inboundVideoSample, formatMediaLine } = loadRendererExports();
  assert.equal(outboundVideoSample([{ type: 'outbound-rtp', kind: 'audio' }], 0), null);
  assert.equal(inboundVideoSample([], 0), null);
  assert.equal(formatMediaLine(null, null, 'bytesReceived'), '');
});

test('fractionLost가 없으면 packetsLost 증분으로 손실률을 계산한다', () => {
  const { lossPercent } = loadRendererExports();
  assert.equal(lossPercent({ packetsLost: 10, packetsSent: 1_000 }, { packetsLost: 20, packetsSent: 2_000 }), 1);
  assert.equal(lossPercent(null, { packetsLost: 20, packetsSent: 2_000 }), null);
  assert.equal(lossPercent({ packetsLost: 10, packetsSent: 1_000 }, { packetsLost: 20, packetsSent: 1_000 }), null);
});
