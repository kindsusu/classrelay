'use strict';

const ALLOWED_MODES = new Set(['practice', 'broadcast', 'lock']);

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

module.exports = { SafetyState, ALLOWED_MODES };
