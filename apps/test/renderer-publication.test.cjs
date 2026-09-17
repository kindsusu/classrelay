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
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    Promise,
    console
  };
  vm.runInNewContext(code, context, { filename: 'renderer.js' });
  return module.exports;
}

test('old practice heartbeat does not stop a publication while mode activation is pending', () => {
  const { shouldStopPublishingForState } = loadRendererExports();
  const pending = { activationRevision: null };
  assert.equal(shouldStopPublishingForState({ revision: 10, mode: 'practice' }, pending), false);

  pending.activationRevision = 11;
  assert.equal(shouldStopPublishingForState({ revision: 10, mode: 'practice' }, pending), false);
});

test('practice state at or after the activated command stops publication', () => {
  const { shouldStopPublishingForState } = loadRendererExports();
  const active = { activationRevision: 11 };
  assert.equal(shouldStopPublishingForState({ revision: 11, mode: 'practice' }, active), true);
  assert.equal(shouldStopPublishingForState({ revision: 12, mode: 'practice' }, active), true);
  assert.equal(shouldStopPublishingForState({ revision: 12, mode: 'broadcast' }, active), false);
});
