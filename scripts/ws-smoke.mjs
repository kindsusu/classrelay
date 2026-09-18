// Local workerd integration only: synthetic credentials, no SFU calls or input hooks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url));
const appRequire = createRequire(new URL('../apps/package.json', import.meta.url));
const { build } = backendRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = backendRequire('miniflare');
const WebSocket = appRequire('ws');
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../backend/src/index.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
const tokens = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`smoke-${i}`, `synthetic-agent-${i}`]));
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-17',
  durableObjects: { CLASSROOM: { className: 'ClassroomState', useSQLite: true } },
  bindings: { CONTROLLER_TOKEN: 'synthetic-controller', AGENT_TOKENS_JSON: JSON.stringify(tokens) },
}] }));
const peers = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 5000) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < end, message);
    await sleep(20);
  }
}
try {
  const origin = (await mf.ready).origin;
  async function connect(deviceId) {
    // mediaReady is a synthetic agent-side liveness flag only; no media is captured or produced anywhere in this script.
    const peer = { states: [], errors: [], deviceId, mediaReady: false, closed: null };
    peer.ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/connect`, {
      headers: { Authorization: `Bearer ${deviceId ? tokens[deviceId] : 'synthetic-controller'}`, ...(deviceId ? { 'X-Device-Id': deviceId } : {}) },
    });
    peers.push(peer);
    peer.ws.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'state') peer.states.push(event.state); });
    peer.ws.on('error', (err) => peer.errors.push(err.message));
    peer.ws.on('close', (code, reason) => { peer.closed = [code, reason.toString()]; });
    await until(() => peer.states.length > 0, 'initial state not delivered');
    peer.heartbeat = () => { if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(deviceId ? { type: 'heartbeat', mediaReady: peer.mediaReady } : { type: 'heartbeat' })); };
    peer.timer = setInterval(peer.heartbeat, 5000);
    return peer;
  }
  async function controllerState() {
    const result = await fetch(`${origin}/api/state`, { headers: { Authorization: 'Bearer synthetic-controller' } });
    assert.equal(result.status, 200, await result.clone().text());
    return result.json();
  }
  async function rosterWhen(predicate, message, timeout = 5000) {
    const end = performance.now() + timeout;
    for (;;) {
      const { students } = await controllerState();
      if (predicate(students)) return students;
      assert.ok(performance.now() < end, message);
      await sleep(50);
    }
  }
  const controller = await connect();
  const agents = await Promise.all(Object.keys(tokens).map(connect));
  const initial = await controllerState();
  assert.equal(initial.students.length, 30, 'controller did not see all 30 control connections');
  assert.ok(initial.students.every((s) => s.mediaReady === false), 'mediaReady must be false until the device itself reports true');
  for (const peer of agents.slice(0, 28)) peer.mediaReady = true;
  for (const peer of agents) peer.heartbeat();
  const mixed = await rosterWhen((s) => s.filter((x) => x.mediaReady).length === 28, 'controller did not observe 28 media-ready students');
  assert.equal(mixed.length, 30, 'control connection count and media-ready count must be reported separately');
  assert.deepEqual(mixed.filter((s) => !s.mediaReady).map((s) => s.deviceId).sort(), agents.slice(28).map((p) => p.deviceId).sort(), 'wrong devices reported as not receiving video');
  agents[0].mediaReady = false;
  agents[0].heartbeat();
  await rosterWhen((s) => s.filter((x) => x.mediaReady).length === 27, 'a device that stopped receiving video was not observed');
  console.log('PASS: 30 control connections report 28 then 27 media-ready students; connection count alone never implies video success.');
  const namespace = await mf.getDurableObjectNamespace('CLASSROOM');
  const room = namespace.get(namespace.idFromName('training'));
  const stream = { sessionId: 'synthetic-stream', trackName: 'screen' };
  // Seed only test SFU ownership, exercising real authenticated mode routes below.
  for (const [path, body] of [['/session', { sessionId: stream.sessionId, role: 'controller' }], ['/published', stream]]) {
    const result = await room.fetch(`https://state.internal${path}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(result.status, 200);
  }
  async function mode(value) {
    const result = await fetch(`${origin}/api/mode`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-controller', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: value, ...(value !== 'practice' ? { stream } : {}) }) });
    assert.equal(result.status, 200, await result.clone().text());
    return result.json();
  }
  const lock = await mode('lock');
  await until(() => agents.every((p) => p.states.at(-1)?.revision === lock.revision && p.states.at(-1)?.mode === 'lock'), 'lock not pushed to all 30 agents');
  assert.ok(agents.every((p) => p.states.every((s) => s.students.length === 0)), 'student roster leaked');
  const started = performance.now();
  const practice = await mode('practice');
  await until(() => agents.every((p) => p.states.at(-1)?.revision === practice.revision && p.states.at(-1)?.mode === 'practice'), 'practice not pushed to all agents');
  console.log(`PASS: authenticated local WebSockets; 30-agent lock/practice fanout (${Math.round(performance.now() - started)} ms); roster privacy.`);
  const silentLock = await mode('lock');
  await until(() => agents.every((p) => p.states.at(-1)?.revision === silentLock.revision && p.states.at(-1)?.mode === 'lock'), 'second lock not delivered');
  clearInterval(controller.timer);
  // Leave the socket open to exercise server lease alarm, not close handling.
  await until(() => agents.every((p) => p.states.at(-1)?.mode === 'practice'), 'silent controller did not release agents', 18000);
  console.log('PASS: silent controller lease expires with student heartbeats still active.');
  controller.ws.send(JSON.stringify({ type: 'heartbeat' }));
  await sleep(100);
  assert.ok(agents.every((p) => p.states.at(-1)?.mode === 'practice'), 'late heartbeat restored expired lock');
  const closeLock = await mode('lock');
  await until(() => agents.every((p) => p.states.at(-1)?.revision === closeLock.revision && p.states.at(-1)?.mode === 'lock'), 'third lock not delivered');
  const replacement = await connect();
  await until(() => agents.every((p) => p.states.at(-1)?.mode === 'practice'), 'controller replacement did not release prior lock');
  const finalLock = await mode('lock');
  await until(() => agents.every((p) => p.states.at(-1)?.revision === finalLock.revision && p.states.at(-1)?.mode === 'lock'), 'replacement controller lock not delivered');
  clearInterval(replacement.timer);
  replacement.ws.close();
  await until(() => agents.every((p) => p.states.at(-1)?.mode === 'practice'), 'controller close did not release agents', 18000);
  const strict = await connect();
  strict.ws.send(JSON.stringify({ type: 'heartbeat', mediaReady: true }));
  await until(() => strict.closed, 'controller mediaReady frame was not rejected');
  assert.deepEqual(strict.closed, [1008, 'only heartbeat messages are accepted'], 'a controller must never be allowed to report mediaReady');
  clearInterval(strict.timer);
  assert.ok(agents.every((p) => p.states.every((s) => s.students.length === 0)), 'student roster leaked to an agent');
  assert.ok(peers.every((p) => p.errors.length === 0), 'unexpected transport errors');
  console.log('PASS: late heartbeat cannot restore expired lock; controller replacement and disconnect release agents; controller mediaReady rejected; roster never reaches an agent. No media/hardware validation performed.');
} finally {
  for (const peer of peers) { clearInterval(peer.timer); peer.ws.terminate(); }
  await mf.dispose();
}
