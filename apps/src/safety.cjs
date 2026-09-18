'use strict';

const ALLOWED_MODES = new Set(['practice', 'broadcast', 'lecture', 'lock']);
const INPUT_LOCK_MODES = new Set(['lecture', 'lock']);

// 입력 잠금 여부를 판정하는 유일한 함수. 두 모드가 잠그게 된 뒤로 호출처에서 mode === 'lock'을
// 직접 비교하면 한쪽은 잠기지 않고(이론 모드가 조용히 실패) 다른 한쪽은 해제 경로를 놓쳐
// 학생이 빠져나올 수 없는 상태가 된다. 잠금 관련 분기는 전부 이 함수만 거친다.
function locksInput(mode) {
  return INPUT_LOCK_MODES.has(mode);
}

class SafetyState {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.revision = -1;
    this.mode = 'practice';
    this.leaseDeadline = 0;
    this.emergencyRevision = null;
  }

  accept(state) {
    if (!state || !Number.isSafeInteger(state.revision) || !ALLOWED_MODES.has(state.mode)) return false;
    if (state.revision < this.revision) return false;
    if (state.revision === this.revision && this.mode !== 'practice' && this.now() >= this.leaseDeadline) {
      this.emergencyRevision = this.revision;
    }
    if (state.revision > this.revision) this.emergencyRevision = null;
    this.revision = state.revision;
    this.mode = state.mode;
    const leaseMs = Math.min(Math.max(Number(state.leaseMs) || 0, 0), 15_000);
    this.leaseDeadline = state.mode !== 'practice' ? this.now() + leaseMs : 0;
    return true;
  }

  emergencyUnlock() {
    this.emergencyRevision = this.revision;
    this.mode = 'practice';
    this.leaseDeadline = 0;
  }

  effectiveMode() {
    if (this.emergencyRevision === this.revision) return 'practice';
    if (this.mode !== 'practice' && this.now() >= this.leaseDeadline) return 'practice';
    return this.mode;
  }
}

module.exports = { SafetyState, ALLOWED_MODES, INPUT_LOCK_MODES, locksInput };
