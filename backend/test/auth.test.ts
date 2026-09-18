import { describe, expect, it } from "vitest";
import worker, { authenticate, ClassroomState, expireLease, isMode, locksInput, MODES, ownsSession, requiresStream, type Mode } from "../src/index";

const env = { CONTROLLER_TOKEN: "controller", AGENT_TOKENS_JSON: '{"pc-01":"agent"}' };
describe("authentication", () => {
  it("accepts the controller token", () => expect(authenticate(new Request("https://x", { headers: { Authorization: "Bearer controller" } }), env)).toEqual({ role: "controller" }));
  it("requires both a registered device id and its token", () => expect(authenticate(new Request("https://x", { headers: { Authorization: "Bearer agent", "X-Device-Id": "pc-01" } }), env)).toEqual({ role: "agent", deviceId: "pc-01" }));
  it("rejects token reuse for another device", () => expect(authenticate(new Request("https://x", { headers: { Authorization: "Bearer agent", "X-Device-Id": "pc-02" } }), env)).toBeNull());
});

describe("classroom safety policy", () => {
  it("turns an expired lock into practice and discards its stream", () => {
    expect(expireLease({ revision: 8, mode: "lock", leaseMs: 15000, stream: { sessionId: "s", trackName: "screen" }, students: [] }, 10, 10)).toMatchObject({ revision: 9, mode: "practice", stream: null });
  });
  it("does not restore a stream after an expired controller lease", () => {
    const expired = expireLease({ revision: 1, mode: "broadcast", leaseMs: 15000, stream: { sessionId: "old", trackName: "screen" }, students: [] }, 0, 1);
    expect(expireLease(expired, 99_999, 2)).toEqual(expired);
  });
  it("does not let an agent claim a controller session", () => {
    expect(ownsSession({ role: "controller" }, { role: "agent", deviceId: "pc-01" })).toBe(false);
  });
});

describe("class modes", () => {
  it("enumerates exactly the four wire names", () => {
    expect([...MODES]).toEqual(["practice", "broadcast", "lecture", "lock"]);
    for (const mode of MODES) expect(isMode(mode)).toBe(true);
    // Shutting an app down must never be reachable through the mode state machine.
    for (const value of ["quit", "Lecture", "", "locked", null, 1, {}, ["lock"]]) expect(isMode(value)).toBe(false);
  });

  it("locks input for lecture and lock only", () => {
    expect(MODES.map(locksInput)).toEqual([false, false, true, true]);
    expect(locksInput("practice")).toBe(false);
    expect(locksInput("broadcast")).toBe(false);
    expect(locksInput("lecture")).toBe(true);
    expect(locksInput("lock")).toBe(true);
  });

  it("requires a stream for every mode except practice", () => {
    expect(MODES.map(requiresStream)).toEqual([false, true, true, true]);
  });

  it("expires a lecture lease exactly like a lock lease", () => {
    const streams = { sessionId: "s", trackName: "screen" };
    const outcomes = (["lecture", "lock"] as Mode[]).map((mode) =>
      expireLease({ revision: 8, mode, leaseMs: 15_000, stream: streams, students: [] }, 10, 10));
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toMatchObject({ revision: 9, mode: "practice", stream: null });
    expect(locksInput(outcomes[0].mode)).toBe(false);
  });

  it("never re-locks a released lecture from the same revision", () => {
    const expired = expireLease({ revision: 4, mode: "lecture", leaseMs: 15_000, stream: { sessionId: "s", trackName: "screen" }, students: [] }, 0, 1);
    expect(expired).toMatchObject({ revision: 5, mode: "practice", stream: null });
    expect(expireLease(expired, 99_999, 2)).toEqual(expired);
  });

  it("keeps an unexpired lecture lease intact", () => {
    const active = { revision: 2, mode: "lecture" as Mode, leaseMs: 15_000, stream: { sessionId: "s", trackName: "screen" }, students: [] };
    expect(expireLease(active, 100, 50)).toBe(active);
  });
});

describe("worker route boundary", () => {
  function classroomEnv() {
    const values = new Map<string, unknown>();
    const state = { storage: { get: async <T>(key: string) => values.get(key) as T | undefined, put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm: async () => {} }, blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(), getWebSockets: () => [] };
    const object = new ClassroomState(state as never);
    return { ...env, CLASSROOM: { idFromName: () => "training", get: () => ({ fetch: (request: Request) => object.fetch(request) }) } } as never;
  }
  const workerEnv = classroomEnv();
  it("exposes health without credentials", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/health"), workerEnv);
    expect(response.status).toBe(200);
  });
  it("rejects protected routes before any state access", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/api/state"), workerEnv);
    expect(response.status).toBe(401);
  });
  it("requires authentication and an Upgrade header for websocket connections", async () => {
    expect((await worker.fetch(new Request("https://classroom.example/api/connect"), workerEnv)).status).toBe(401);
    const response = await worker.fetch(new Request("https://classroom.example/api/connect", { headers: { Authorization: "Bearer controller" } }), workerEnv);
    expect(response.status).toBe(426);
  });
  it("rejects an agent attempting to change classroom mode", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/api/mode", { method: "POST", headers: { Authorization: "Bearer agent", "X-Device-Id": "pc-01" }, body: JSON.stringify({ mode: "practice" }) }), workerEnv);
    expect(response.status).toBe(403);
  });
  it("rejects a student asking the server to quit the student apps", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/api/agents/quit", { method: "POST", headers: { Authorization: "Bearer agent", "X-Device-Id": "pc-01" }, body: "{}" }), workerEnv);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "controller role required" });
  });
  it("rejects an unauthenticated quit and a quit carrying a payload", async () => {
    expect((await worker.fetch(new Request("https://classroom.example/api/agents/quit", { method: "POST", body: "{}" }), workerEnv)).status).toBe(401);
    for (const payload of ['{"mode":"lock"}', '{"deviceId":"pc-01"}', "[]", "true", "not json"]) {
      const response = await worker.fetch(new Request("https://classroom.example/api/agents/quit", { method: "POST", headers: { Authorization: "Bearer controller" }, body: payload }), workerEnv);
      expect([payload, response.status]).toEqual([payload, 400]);
    }
    // GET must not reach the fanout either.
    expect((await worker.fetch(new Request("https://classroom.example/api/agents/quit", { headers: { Authorization: "Bearer controller" } }), workerEnv)).status).toBe(404);
  });
  it("rejects primitive JSON before processing a controller command", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/api/mode", { method: "POST", headers: { Authorization: "Bearer controller" }, body: "true" }), workerEnv);
    expect(response.status).toBe(400);
  });
  it("enforces POST-only track and PUT-only renegotiation routes", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/api/rtc/sessions/x/tracks", { method: "PUT", headers: { Authorization: "Bearer controller" }, body: "{}" }), workerEnv);
    expect(response.status).toBe(405);
  });
  it("preserves an unexpired persisted lock when a Durable Object wakes from hibernation", async () => {
    const values = new Map<string, unknown>([["snapshot", { revision: 2, mode: "lock", leaseMs: 15000, stream: { sessionId: "s", trackName: "t" }, students: [] }]]);
    values.set("leaseUntil", Date.now() + 10_000);
    const state = { storage: { get: async <T>(key: string) => values.get(key) as T | undefined, put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm: async () => {} }, blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(), getWebSockets: () => [] };
    const object = new ClassroomState(state as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await object.fetch(new Request("https://state.internal/state"));
    expect(await response.json()).toMatchObject({ revision: 2, mode: "lock", stream: { sessionId: "s", trackName: "t" } });
  });
});
