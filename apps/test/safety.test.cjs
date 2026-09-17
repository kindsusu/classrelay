'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SafetyState } = require('../src/safety.cjs');

test('연결이 끊기면 15초 lease 뒤 practice로 해제한다', () => {
  let now = 1_000;
  const safety = new SafetyState(() => now);
  assert.equal(safety.accept({ revision: 4, mode: 'lock', leaseMs: 15_000 }), true);
  assert.equal(safety.effectiveMode(), 'lock');
  now = 16_000;
  assert.equal(safety.effectiveMode(), 'practice');
});

test('broadcast 전체화면도 lease 만료 시 해제한다', () => {
  let now = 0;
  const safety = new SafetyState(() => now);
  safety.accept({ revision: 2, mode: 'broadcast', leaseMs: 15_000 });
  now = 15_001;
  assert.equal(safety.effectiveMode(), 'practice');
});

test('과도한 서버 lease는 로컬에서 15초로 제한한다', () => {
  let now = 0;
  const safety = new SafetyState(() => now);
  safety.accept({ revision: 2, mode: 'lock', leaseMs: 60_000 });
  now = 15_001;
  assert.equal(safety.effectiveMode(), 'practice');
});

test('이벤트 루프 정지 뒤 같은 revision 응답으로 만료 잠금이 부활하지 않는다', () => {
  let now = 0;
  const safety = new SafetyState(() => now);
  safety.accept({ revision: 5, mode: 'lock', leaseMs: 15_000 });
  now = 20_000;
  safety.accept({ revision: 5, mode: 'lock', leaseMs: 15_000 });
  assert.equal(safety.effectiveMode(), 'practice');
});

test('비상 해제 latch는 같은 revision 재수신으로 잠기지 않는다', () => {
  const safety = new SafetyState(() => 100);
  safety.accept({ revision: 7, mode: 'lock', leaseMs: 15_000 });
  safety.emergencyUnlock();
  safety.accept({ revision: 7, mode: 'lock', leaseMs: 15_000 });
  assert.equal(safety.effectiveMode(), 'practice');
});

test('새 revision은 비상 해제 latch를 지운다', () => {
  const safety = new SafetyState(() => 100);
  safety.accept({ revision: 7, mode: 'lock', leaseMs: 15_000 });
  safety.emergencyUnlock();
  safety.accept({ revision: 8, mode: 'lock', leaseMs: 15_000 });
  assert.equal(safety.effectiveMode(), 'lock');
});

test('이전 revision과 잘못된 mode를 거부한다', () => {
  const safety = new SafetyState();
  assert.equal(safety.accept({ revision: 3, mode: 'practice', leaseMs: 0 }), true);
  assert.equal(safety.accept({ revision: 2, mode: 'lock', leaseMs: 15_000 }), false);
  assert.equal(safety.accept({ revision: 4, mode: 'unknown', leaseMs: 15_000 }), false);
  assert.equal(safety.effectiveMode(), 'practice');
});
