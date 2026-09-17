import { describe, expect, it } from "vitest";
import worker, { authenticate, ClassroomState, expireLease, ownsSession } from "../src/index";

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

describe("worker route boundary", () => {
  function classroomEnv() {
    const values = new Map<string, unknown>();
    const state = { storage: { get: async <T>(key: string) => values.get(key) as T | undefined, put: async (key: string, value: unknown) => { values.set(key, value); } }, blockConcurrencyWhile: async (callback: () => Promise<void>) => callback() };
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
  it("rejects an agent attempting to change classroom mode", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/api/mode", { method: "POST", headers: { Authorization: "Bearer agent", "X-Device-Id": "pc-01" }, body: JSON.stringify({ mode: "practice" }) }), workerEnv);
    expect(response.status).toBe(403);
  });
  it("rejects primitive JSON before processing a controller command", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/api/mode", { method: "POST", headers: { Authorization: "Bearer controller" }, body: "true" }), workerEnv);
    expect(response.status).toBe(400);
  });
  it("enforces POST-only track and PUT-only renegotiation routes", async () => {
    const response = await worker.fetch(new Request("https://classroom.example/api/rtc/sessions/x/tracks", { method: "PUT", headers: { Authorization: "Bearer controller" }, body: "{}" }), workerEnv);
    expect(response.status).toBe(405);
  });
  it("resets a persisted lock to practice when a Durable Object starts", async () => {
    const values = new Map<string, unknown>([["snapshot", { revision: 2, mode: "lock", leaseMs: 15000, stream: { sessionId: "s", trackName: "t" }, students: [] }]]);
    const state = { storage: { get: async <T>(key: string) => values.get(key) as T | undefined, put: async (key: string, value: unknown) => { values.set(key, value); } }, blockConcurrencyWhile: async (callback: () => Promise<void>) => callback() };
    const object = new ClassroomState(state as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await object.fetch(new Request("https://state.internal/state"));
    expect(await response.json()).toMatchObject({ revision: 3, mode: "practice", stream: null });
  });
});
