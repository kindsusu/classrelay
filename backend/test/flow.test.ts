import { afterEach, expect, it, vi } from 'vitest';
import worker, { ClassroomState, type Env } from '../src/index';

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const sockets: WebSocket[] = [];
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
  return { values, request, upstream, get alarmAt() { return alarmAt; } };
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
