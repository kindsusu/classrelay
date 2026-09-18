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

test('an array of ICE servers passes through unchanged', () => {
  const { normalizeIceServers } = loadRendererExports();
  const servers = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
  assert.equal(normalizeIceServers(servers), servers);
  assert.equal(normalizeIceServers([]).length, 0);
});

test('a single TURN-configured object is wrapped in an array with credentials intact', () => {
  const { normalizeIceServers } = loadRendererExports();
  const single = {
    urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
    username: 'issued-username',
    credential: 'issued-credential'
  };
  const result = normalizeIceServers(single);
  // result is an array built by vm-sandboxed code (a different realm than this test's own Array), so compare
  // shape and contents rather than deepEqual the array wrapper itself.
  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 1);
  assert.equal(result[0], single);
  assert.equal(result[0].username, 'issued-username');
  assert.equal(result[0].credential, 'issued-credential');
});

test('missing or garbage input degrades to an empty array instead of throwing', () => {
  const { normalizeIceServers } = loadRendererExports();
  for (const input of [undefined, null, 'turn:not-an-object', 42, true]) {
    const result = normalizeIceServers(input);
    assert.equal(Array.isArray(result), true);
    assert.equal(result.length, 0);
  }
});
