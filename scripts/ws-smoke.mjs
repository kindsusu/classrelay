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
    const peer = { states: [], errors: [] };
    peer.ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/connect`, {
      headers: { Authorization: `Bearer ${deviceId ? tokens[deviceId] : 'synthetic-controller'}`, ...(deviceId ? { 'X-Device-Id': deviceId } : {}) },
    });
    peers.push(peer);
    peer.ws.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'state') peer.states.push(event.state); });
    peer.ws.on('error', (err) => peer.errors.push(err.message));
    await until(() => peer.states.length > 0, 'initial state not delivered');
    peer.timer = setInterval(() => { if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify({ type: 'heartbeat' })); }, 5000);
    return peer;
  }
  const controller = await connect();
  const agents = await Promise.all(Object.keys(tokens).map(connect));
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
  assert.ok(peers.every((p) => p.errors.length === 0), 'unexpected transport errors');
  console.log('PASS: late heartbeat cannot restore expired lock; controller replacement and disconnect release agents. No media/hardware validation performed.');
} finally {
  for (const peer of peers) { clearInterval(peer.timer); peer.ws.terminate(); }
  await mf.dispose();
}
