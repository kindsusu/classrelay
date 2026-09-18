import { afterEach, expect, it, vi } from 'vitest';
import worker, { ClassroomState, type Env } from '../src/index';

afterEach(() => vi.unstubAllGlobals());

/** Minimal stand-in for a hibernation-capable socket so route tests can observe a real fanout. */
class FakeSocket {
  sent: string[] = [];
  constructor(public attachment: { role: 'controller' | 'agent'; deviceId?: string; connectionId: string; lastSeen: number; mediaReady: boolean }) {}
  deserializeAttachment() { return this.attachment; }
  serializeAttachment(value: FakeSocket['attachment']) { this.attachment = structuredClone(value); }
  send(value: string) { this.sent.push(value); }
  close() {}
  frames() { return this.sent.map((frame) => JSON.parse(frame) as { type: string }); }
}
function fakeAgent(deviceId: string) {
  return new FakeSocket({ role: 'agent', deviceId, connectionId: `c-${deviceId}`, lastSeen: Date.now(), mediaReady: false });
}

async function fixture() {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const sockets: FakeSocket[] = [];
  let ready: Promise<unknown> = Promise.resolve();
  const durable = new ClassroomState({
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      setAlarm: async (value: number) => { alarmAt = value; }
    },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => { ready = callback(); return ready; },
    getWebSockets: () => sockets
  } as never);
  await ready;
  const env = {
    CONTROLLER_TOKEN: 'test-controller', AGENT_TOKENS_JSON: '{"a":"test-a","b":"test-b"}',
    SFU_APP_ID: 'test-app', SFU_APP_TOKEN: 'test-server-secret',
    CLASSROOM: { idFromName: () => 'room', get: () => ({ fetch: (req: Request) => durable.fetch(req) }) }
  } as unknown as Env;
  const request = async (path: string, who = 'controller', method = 'GET', payload?: unknown) => worker.fetch(new Request(`https://test.invalid${path}`, {
    method, headers: { Authorization: `Bearer test-${who}`, ...(who !== 'controller' ? { 'X-Device-Id': who } : {}) },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
  }), env);
  let nextSession = 0;
  // Measured against the live Cloudflare SFU on 2026-09-18, not taken from realtime-api-2024-05-21.yaml,
  // which still documents a body-less /sessions/new and is stale: session creation requires the SDP offer
  // and answers in the same response. A body without sessionDescription is rejected with 400 decoding_error.
  // Whether /tracks/new returns a further sessionDescription is NOT verified against a real peer, so this
  // mock returns tracks only; the client tolerates either shape.
  const upstream = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string);
    if (_url.endsWith('/sessions/new')) {
      if (!payload?.sessionDescription) {
        return Response.json({ errorCode: 'decoding_error', errorDescription: 'Body JSON validation error: sessionDescription' }, { status: 400 });
      }
      return Response.json({ sessionId: `s${++nextSession}`, sessionDescription: { type: 'answer', sdp: 'mock-answer' } }, { status: 201 });
    }
    return Response.json({ tracks: payload.tracks || [] });
  });
  vi.stubGlobal('fetch', upstream);
  return { values, request, upstream, sockets, get alarmAt() { return alarmAt; } };
}

const OFFER = { sessionDescription: { type: 'offer', sdp: 'mock-offer' } };

it('publishes, authorizes only the active track, isolates students, and clears expired control', async () => {
  const { request, values, upstream } = await fixture();
  expect((await request('/api/rtc/sessions', 'a', 'POST', OFFER)).status).toBe(409);
  const created = await request('/api/rtc/sessions', 'controller', 'POST', OFFER);
  // The offer goes up with session creation and the answer comes back in that same response.
  expect(await created.json()).toMatchObject({ sessionId: 's1', sessionDescription: { type: 'answer', sdp: 'mock-answer' } });
  const stream = { sessionId: 's1', trackName: 'screen' };
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'lock', stream })).status).toBe(403);
  expect((await request('/api/rtc/sessions/s1/tracks', 'controller', 'POST', {
    tracks: [{ location: 'local', kind: 'video', mid: '0', trackName: 'screen' }]
  })).status).toBe(200);
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'lock', stream })).status).toBe(200);
  // The live SFU answers session creation with 201, and the Worker forwards the upstream status unchanged.
  expect((await request('/api/rtc/sessions', 'a', 'POST', OFFER)).status).toBe(201);
  const remote = { tracks: [{ location: 'remote', ...stream }] };
  expect((await request('/api/rtc/sessions/s2/tracks', 'a', 'POST', remote)).status).toBe(200);
  const before = upstream.mock.calls.length;
  expect((await request('/api/rtc/sessions/s2/tracks', 'b', 'POST', remote)).status).toBe(403);
  expect((await request('/api/rtc/sessions/s2/tracks', 'a', 'POST', { tracks: [{ location: 'remote', sessionId: 'foreign', trackName: 'screen' }] })).status).toBe(403);
  expect(upstream.mock.calls.length).toBe(before);
  expect((await request('/api/heartbeat', 'a', 'POST', {})).status).toBe(200);
  const privateState = await (await request('/api/state', 'a')).json() as { students: unknown[] };
  expect(privateState.students).toEqual([]);
  values.set('leaseUntil', Date.now() - 1);
  const state = await (await request('/api/heartbeat', 'controller', 'POST', {})).json();
  expect(state).toMatchObject({ mode: 'practice', stream: null });
  expect((await request('/api/rtc/sessions/s2/tracks', 'a', 'POST', remote)).status).toBe(403);
});

it('does not authorize a track whose SFU response contains a track-level error', async () => {
  const { request, upstream } = await fixture();
  await request('/api/rtc/sessions', 'controller', 'POST', OFFER);
  upstream.mockResolvedValueOnce(Response.json({ tracks: [{ trackName: 'broken', errorCode: 'TRACK_ERROR' }] }));
  await request('/api/rtc/sessions/s1/tracks', 'controller', 'POST', { tracks: [{ location: 'local', kind: 'video', mid: '0', trackName: 'broken' }] });
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'broadcast', stream: { sessionId: 's1', trackName: 'broken' } })).status).toBe(403);
});

// A session created without an offer is what shipped, and it can never succeed. The upstream reason must
// reach the caller intact: the client formats errorCode/errorDescription, so a bare status is a dead end.
it('forwards the upstream decoding error when session creation carries no offer', async () => {
  const { request } = await fixture();
  const rejected = await request('/api/rtc/sessions', 'controller', 'POST', {});
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ errorCode: 'decoding_error', errorDescription: 'Body JSON validation error: sessionDescription' });
});

it('registers session ownership from a creation response that also carries the answer', async () => {
  const { request, values } = await fixture();
  expect((await request('/api/rtc/sessions', 'controller', 'POST', OFFER)).status).toBe(201);
  // Ownership must still be recorded, otherwise the follow-up track request is rejected as unowned.
  expect(values.get('session:s1')).toMatchObject({ role: 'controller' });
  expect((await request('/api/rtc/sessions/s1/tracks', 'controller', 'POST', {
    tracks: [{ location: 'local', kind: 'video', mid: '0', trackName: 'screen' }]
  })).status).toBe(200);
});

type Request_ = Awaited<ReturnType<typeof fixture>>['request'];
async function publishedStream(request: Request_) {
  expect((await request('/api/rtc/sessions', 'controller', 'POST', OFFER)).status).toBe(201);
  expect((await request('/api/rtc/sessions/s1/tracks', 'controller', 'POST', {
    tracks: [{ location: 'local', kind: 'video', mid: '0', trackName: 'screen' }]
  })).status).toBe(200);
  return { sessionId: 's1', trackName: 'screen' };
}

it('accepts lecture only with a published instructor stream and releases it on lease expiry', async () => {
  const { request, values } = await fixture();
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'lecture' })).status).toBe(400);
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'lecture', stream: { sessionId: 'ghost', trackName: 'screen' } })).status).toBe(403);
  const stream = await publishedStream(request);
  const applied = await request('/api/mode', 'controller', 'POST', { mode: 'lecture', stream });
  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({ mode: 'lecture', stream });
  expect(values.get('leaseUntil') as number).toBeGreaterThan(Date.now());
  // A lecture that outlives its lease must fall back to practice exactly like a lock.
  values.set('leaseUntil', Date.now() - 1);
  expect(await (await request('/api/state')).json()).toMatchObject({ mode: 'practice', leaseMs: 0, stream: null });
  // And a student can no longer subscribe to the released stream.
  expect((await request('/api/rtc/sessions', 'a', 'POST', OFFER)).status).toBe(409);
});

it('rejects an unknown mode name, quit included, before touching the state machine', async () => {
  const { request, values } = await fixture();
  for (const mode of ['quit', 'Lecture', 'watch', '', null]) {
    expect([mode, (await request('/api/mode', 'controller', 'POST', { mode })).status]).toEqual([mode, 400]);
  }
  expect(values.get('snapshot')).toBeUndefined();
});

it('quits every connected agent, never the controller, and changes no class state', async () => {
  const { request, values, sockets } = await fixture();
  const stream = await publishedStream(request);
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'lecture', stream })).status).toBe(200);
  const controllerSocket = new FakeSocket({ role: 'controller', connectionId: 'c', lastSeen: Date.now(), mediaReady: false });
  const agents = ['a', 'b'].map(fakeAgent);
  sockets.push(controllerSocket, ...agents);
  const before = await (await request('/api/state')).json() as { revision: number; mode: string; stream: unknown; leaseMs: number };
  const quit = await request('/api/agents/quit', 'controller', 'POST', {});
  expect(quit.status).toBe(200);
  expect(await quit.json()).toEqual({ ok: true, notified: 2 });
  for (const agent of agents) expect(agent.frames()).toEqual([{ type: 'quit' }]);
  expect(controllerSocket.sent).toEqual([]);
  const after = await (await request('/api/state')).json() as typeof before;
  expect({ revision: after.revision, mode: after.mode, stream: after.stream }).toEqual({ revision: before.revision, mode: before.mode, stream: before.stream });
  expect(after.leaseMs).toBeGreaterThan(0);
  // Nothing about the command is persisted, so nothing can be replayed to a device that connects later.
  expect(JSON.stringify([...values.entries()]).includes('quit')).toBe(false);
});

it('lets only the controller ask the student apps to quit, and only with an empty body', async () => {
  const { request, sockets } = await fixture();
  const agent = fakeAgent('a');
  sockets.push(agent);
  expect((await request('/api/agents/quit', 'a', 'POST', {})).status).toBe(403);
  expect((await request('/api/agents/quit', 'b', 'POST', {})).status).toBe(403);
  expect((await request('/api/agents/quit', 'controller', 'POST', { mode: 'lock' })).status).toBe(400);
  expect(agent.sent).toEqual([]);
  expect((await request('/api/agents/quit', 'controller', 'POST', {})).status).toBe(200);
  expect(agent.frames()).toEqual([{ type: 'quit' }]);
});
