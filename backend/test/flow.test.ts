import { afterEach, expect, it, vi } from 'vitest';
import worker, { ClassroomState, type Env } from '../src/index';

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const values = new Map<string, unknown>();
  let ready: Promise<unknown> = Promise.resolve();
  const durable = new ClassroomState({
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }
    },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => { ready = callback(); return ready; }
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
  const upstream = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string);
    if (_url.endsWith('/sessions/new')) return Response.json({ sessionId: `s${++nextSession}` });
    return Response.json({ tracks: payload.tracks || [], sessionDescription: { type: 'answer', sdp: 'mock' } });
  });
  vi.stubGlobal('fetch', upstream);
  return { values, request, upstream };
}

it('publishes, authorizes only the active track, isolates students, and clears expired control', async () => {
  const { request, values, upstream } = await fixture();
  expect((await request('/api/rtc/sessions', 'a', 'POST', {})).status).toBe(409);
  const created = await request('/api/rtc/sessions', 'controller', 'POST', {});
  expect(await created.json()).toMatchObject({ sessionId: 's1' });
  const stream = { sessionId: 's1', trackName: 'screen' };
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'lock', stream })).status).toBe(403);
  expect((await request('/api/rtc/sessions/s1/tracks', 'controller', 'POST', {
    tracks: [{ location: 'local', kind: 'video', mid: '0', trackName: 'screen' }], sessionDescription: { type: 'offer', sdp: 'mock' }
  })).status).toBe(200);
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'lock', stream })).status).toBe(200);
  expect((await request('/api/rtc/sessions', 'a', 'POST', {})).status).toBe(200);
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
  await request('/api/rtc/sessions', 'controller', 'POST', {});
  upstream.mockResolvedValueOnce(Response.json({ tracks: [{ trackName: 'broken', errorCode: 'TRACK_ERROR' }] }));
  await request('/api/rtc/sessions/s1/tracks', 'controller', 'POST', { tracks: [{ location: 'local', kind: 'video', mid: '0', trackName: 'broken' }] });
  expect((await request('/api/mode', 'controller', 'POST', { mode: 'broadcast', stream: { sessionId: 's1', trackName: 'broken' } })).status).toBe(403);
});
