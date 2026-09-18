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

// 실측: 빈 body({})는 400 decoding_error로 거절된다. 세션 생성 요청은 절대 SDP 없이 나가서는 안 된다.
test('세션 생성 요청은 항상 offer를 싣는다', () => {
  const { sessionCreationBody } = loadRendererExports();
  const body = sessionCreationBody({ type: 'offer', sdp: 'v=0 fake-offer', extra: 'ignored' });
  assert.deepEqual(Object.keys(body), ['sessionDescription']);
  assert.equal(body.sessionDescription.type, 'offer');
  assert.equal(body.sessionDescription.sdp, 'v=0 fake-offer');
  assert.equal('extra' in body.sessionDescription, false);
});

test('SDP가 없으면 세션 생성 요청을 만들지 않는다', () => {
  const { sessionCreationBody } = loadRendererExports();
  for (const input of [undefined, null, {}, { type: 'offer' }, { sdp: 'v=0' }, { type: 5, sdp: 'v=0' }]) {
    assert.throws(() => sessionCreationBody(input), /유효한 SDP를 만들지 못했습니다\./);
  }
});

// /tracks/new가 SDP를 추가로 요구하는지는 실기기 검증 전까지 확정되지 않았다. 최소 요청을 보낸다.
test('트랙 요청은 tracks만 담는다', () => {
  const { localTrackRequest, remoteTrackRequest } = loadRendererExports();
  const local = localTrackRequest('0', 'screen-controller-1');
  assert.deepEqual(Object.keys(local), ['tracks']);
  assert.equal(local.tracks.length, 1);
  assert.equal(local.tracks[0].location, 'local');
  assert.equal(local.tracks[0].kind, 'video');
  assert.equal(local.tracks[0].mid, '0');
  assert.equal(local.tracks[0].trackName, 'screen-controller-1');

  const remote = remoteTrackRequest({ sessionId: 'sess-1', trackName: 'screen-1', mode: 'lock' });
  assert.deepEqual(Object.keys(remote), ['tracks']);
  assert.deepEqual(Object.keys(remote.tracks[0]), ['location', 'sessionId', 'trackName']);
  assert.equal(remote.tracks[0].location, 'remote');
  assert.equal(remote.tracks[0].sessionId, 'sess-1');
  assert.equal(remote.tracks[0].trackName, 'screen-1');
});

test('세션 생성 응답의 answer는 로컬 offer가 걸린 상태에서만 적용한다', () => {
  const { negotiationStep } = loadRendererExports();
  const answer = { type: 'answer', sdp: 'v=0 fake-answer' };
  assert.equal(negotiationStep(answer, 'have-local-offer'), 'answer');
  // 이미 stable이면 중복 answer다. 적용하면 InvalidStateError로 송출 자체가 실패한다.
  assert.equal(negotiationStep(answer, 'stable'), 'none');
});

test('협상이 끝난 뒤 도착한 offer는 무시하지 않고 renegotiate로 답한다', () => {
  const { negotiationStep } = loadRendererExports();
  const offer = { type: 'offer', sdp: 'v=0 fake-offer' };
  assert.equal(negotiationStep(offer, 'stable'), 'renegotiate');
  assert.equal(negotiationStep(offer, 'have-local-offer'), 'renegotiate');
});

test('SDP가 없는 응답은 협상 단계를 만들지 않는다', () => {
  const { negotiationStep } = loadRendererExports();
  for (const input of [undefined, null, {}, { type: 'answer' }, { sdp: 'v=0' }, { type: 'pranswer', sdp: 'v=0' }]) {
    assert.equal(negotiationStep(input, 'have-local-offer'), 'none');
  }
});

test('plainDescription은 type과 sdp만 통과시킨다', () => {
  const { plainDescription } = loadRendererExports();
  const plain = plainDescription({ type: 'answer', sdp: 'v=0 fake', toJSON: () => ({}) });
  assert.deepEqual(Object.keys(plain), ['type', 'sdp']);
});
