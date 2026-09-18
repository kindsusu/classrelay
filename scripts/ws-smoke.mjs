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
const DEVICE_IDS = Array.from({ length: 30 }, (_, i) => `smoke-${i}`);
// Registered but deliberately left unconnected until after the quit command, to prove it is not replayed.
const LATE_DEVICE = 'smoke-late';
const tokens = Object.fromEntries([...DEVICE_IDS, LATE_DEVICE].map((id) => [id, `synthetic-agent-${id}`]));
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
    const peer = { states: [], quits: [], errors: [], deviceId, mediaReady: false, closed: null };
    peer.ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/connect`, {
      headers: { Authorization: `Bearer ${deviceId ? tokens[deviceId] : 'synthetic-controller'}`, ...(deviceId ? { 'X-Device-Id': deviceId } : {}) },
    });
    peers.push(peer);
    // A quit frame is recorded, never acted on: this script must not terminate its own synthetic peers.
    peer.ws.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.type === 'state') peer.states.push(event.state); else if (event.type === 'quit') peer.quits.push(event); });
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
  const agents = await Promise.all(DEVICE_IDS.map((id) => connect(id)));
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
  // lecture is the second input-locking mode. It must fan out and expire exactly like lock.
  const lectureStarted = performance.now();
  const lecture = await mode('lecture');
  assert.ok(lecture.revision > practice.revision, 'revision must stay monotonic across a lecture command');
  await until(() => agents.every((p) => p.states.at(-1)?.revision === lecture.revision && p.states.at(-1)?.mode === 'lecture'), 'lecture not pushed to all 30 agents');
  const lectureFrames = agents.map((p) => p.states.filter((s) => s.revision === lecture.revision && s.mode === 'lecture'));
  assert.ok(lectureFrames.every((frames) => frames.length > 0 && frames[0].stream?.sessionId === stream.sessionId && frames[0].stream?.trackName === stream.trackName), 'lecture must carry the instructor stream to every agent');
  assert.ok(lectureFrames.every((frames) => frames[0].leaseMs > 0), 'lecture must report a live lease like lock');
  assert.ok(agents.every((p) => p.states.every((s) => s.students.length === 0)), 'student roster leaked during lecture');
  clearInterval(controller.timer);
  // Leave the socket open so this exercises the server lease alarm, not close handling.
  await until(() => agents.every((p) => p.states.at(-1)?.mode === 'practice'), 'silent controller did not release a lecture', 18000);
  const releasedLecture = await controllerState();
  assert.equal(releasedLecture.stream, null, 'a released lecture must clear the stream');
  assert.equal(releasedLecture.leaseMs, 0, 'a released lecture must hold no lease');
  assert.ok(releasedLecture.revision > lecture.revision, 'a lecture release must bump the revision');
  controller.ws.send(JSON.stringify({ type: 'heartbeat' }));
  await sleep(100);
  assert.ok(agents.every((p) => p.states.at(-1)?.mode === 'practice'), 'late heartbeat restored an expired lecture');
  controller.timer = setInterval(controller.heartbeat, 5000);
  controller.heartbeat();
  console.log(`PASS: lecture fans out to 30 agents with a stream and a live lease, then falls back to practice on lease expiry with a higher revision, exactly like lock (${Math.round(performance.now() - lectureStarted)} ms).`);
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

  // Agent shutdown command. Transient fanout only: no stored state, so nothing can be replayed.
  const quitController = await connect();
  async function quitAs(headers, payload = {}) {
    return fetch(`${origin}/api/agents/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  }
  const controllerAuth = { Authorization: 'Bearer synthetic-controller' };
  const student = await quitAs({ Authorization: `Bearer ${tokens[DEVICE_IDS[0]]}`, 'X-Device-Id': DEVICE_IDS[0] });
  assert.equal(student.status, 403, 'a student must not be able to shut the class down');
  const parameterised = await quitAs(controllerAuth, { mode: 'lock' });
  assert.equal(parameterised.status, 400, 'the quit route must never accept a payload');
  const asMode = await fetch(`${origin}/api/mode`, { method: 'POST', headers: { ...controllerAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'quit', stream }) });
  assert.equal(asMode.status, 400, 'quit must not be reachable as a class mode');
  await sleep(200);
  assert.ok(agents.every((p) => p.quits.length === 0), 'a rejected quit still reached the agents');
  const beforeQuit = await controllerState();
  const quit = await quitAs(controllerAuth);
  assert.equal(quit.status, 200, await quit.clone().text());
  assert.deepEqual(await quit.json(), { ok: true, notified: 30 }, 'quit must report exactly the agent sockets connected at that instant');
  await until(() => agents.every((p) => p.quits.length === 1), 'quit did not reach all 30 agents');
  assert.deepEqual(agents.flatMap((p) => p.quits), agents.map(() => ({ type: 'quit' })), 'the quit frame must carry nothing but its type');
  assert.equal(quitController.quits.length, 0, 'a controller socket must never receive a quit frame');
  const afterQuit = await controllerState();
  const classState = ({ revision, mode: value, leaseMs, stream: active }) => ({ revision, mode: value, leaseMs, stream: active });
  assert.deepEqual(classState(afterQuit), classState(beforeQuit), 'quit must not touch mode, revision, lease or stream');
  const lateJoiner = await connect(LATE_DEVICE);
  await sleep(500);
  assert.equal(lateJoiner.quits.length, 0, 'a student app that connected after the quit command must never receive it');
  assert.equal(lateJoiner.states[0].mode, 'practice', 'the late joiner did not get the current class state');
  assert.ok(lateJoiner.states.every((s) => s.students.length === 0), 'student roster leaked to the late joiner');
  const second = await quitAs(controllerAuth);
  assert.deepEqual(await second.json(), { ok: true, notified: 31 }, 'a second quit must count the sockets connected at that instant, including the late joiner');
  await until(() => lateJoiner.quits.length === 1 && agents.every((p) => p.quits.length === 2), 'the second quit did not reach every connected agent');
  assert.equal(quitController.quits.length, 0, 'a controller socket must never receive a quit frame');
  assert.deepEqual(classState(await controllerState()), classState(beforeQuit), 'a second quit must still not touch the class state');
  assert.ok(peers.every((p) => p.errors.length === 0), 'unexpected transport errors');
  console.log('PASS: quit reaches all 30 agents and no controller, reports the live socket count, leaves mode/revision/lease/stream untouched, is refused for a student (403) and as a class mode (400), and is never replayed to a device that connects afterwards. Nothing was actually terminated: synthetic peers only record the frame.');
} finally {
  for (const peer of peers) { clearInterval(peer.timer); peer.ws.terminate(); }
  await mf.dispose();
}
