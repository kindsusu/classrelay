import { describe, expect, it, vi } from "vitest";
import { ClassroomState, heartbeatFrame, type ClassroomSnapshot } from "../src/index";

/** mediaReady is optional here on purpose: hibernation can hand back an attachment serialized before the field existed. */
interface Attachment { role: "controller" | "agent"; deviceId?: string; connectionId: string; lastSeen: number; mediaReady?: boolean }
class FakeSocket {
  sent: string[] = [];
  closed: [number, string] | null = null;
  constructor(public attachment: Attachment) {}
  deserializeAttachment() { return this.attachment; }
  serializeAttachment(value: Attachment) { this.attachment = structuredClone(value); }
  send(value: string) { this.sent.push(value); }
  close(code: number, reason: string) { this.closed = [code, reason]; }
}

function fixture(snapshot?: ClassroomSnapshot, leaseUntil = 0) {
  const values = new Map<string, unknown>();
  if (snapshot) values.set("snapshot", structuredClone(snapshot));
  values.set("leaseUntil", leaseUntil);
  const sockets: FakeSocket[] = [];
  let alarmAt: number | null = null;
  const durable = new ClassroomState({
    storage: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      setAlarm: async (value: number) => { alarmAt = value; }
    },
    getWebSockets: () => sockets
  } as never);
  return { durable, values, sockets, get alarmAt() { return alarmAt; } };
}

const locked: ClassroomSnapshot = { revision: 3, mode: "lock", leaseMs: 15_000, stream: { sessionId: "s", trackName: "screen" }, students: [] };

describe("Durable Object WebSocket control", () => {
  it("fans out a mode change immediately and redacts the agent roster", async () => {
    const f = fixture();
    const controller = new FakeSocket({ role: "controller", connectionId: "c", lastSeen: 1 });
    const agent = new FakeSocket({ role: "agent", deviceId: "pc-01", connectionId: "a", lastSeen: 2 });
    f.sockets.push(controller, agent);
    const response = await f.durable.fetch(new Request("https://state.internal/mode", { method: "POST", body: JSON.stringify({ mode: "lock", stream: locked.stream }) }));
    expect(response.status).toBe(200);
    expect(JSON.parse(controller.sent.at(-1)!).state).toMatchObject({ mode: "lock", students: [{ deviceId: "pc-01" }] });
    expect(JSON.parse(agent.sent.at(-1)!).state).toMatchObject({ mode: "lock", students: [] });
    expect(f.alarmAt).toBeGreaterThan(Date.now());
  });

  it("releases and broadcasts an expired lock when an agent heartbeats", async () => {
    const f = fixture(locked, Date.now() - 1);
    const controller = new FakeSocket({ role: "controller", connectionId: "c", lastSeen: 1 });
    const agent = new FakeSocket({ role: "agent", deviceId: "pc-01", connectionId: "a", lastSeen: 2 });
    f.sockets.push(controller, agent);
    await f.durable.webSocketMessage(agent as never, JSON.stringify({ type: "heartbeat" }));
    expect(await f.values.get("leaseUntil")).toBeLessThan(Date.now());
    expect(JSON.parse(controller.sent.at(-1)!).state).toMatchObject({ revision: 4, mode: "practice", leaseMs: 0, stream: null });
    expect(JSON.parse(agent.sent.at(-1)!).state).toMatchObject({ mode: "practice", leaseMs: 0 });
  });

  it("restores hibernated socket attachments and rejects agent commands", async () => {
    const f = fixture(undefined, 0);
    const agent = new FakeSocket({ role: "agent", deviceId: "pc-09", connectionId: "restored", lastSeen: 123 });
    f.sockets.push(agent);
    const state = await (await f.durable.fetch(new Request("https://state.internal/state"))).json() as ClassroomSnapshot;
    expect(state.students).toEqual([{ deviceId: "pc-09", lastSeen: 123, mediaReady: false }]);
    await f.durable.webSocketMessage(agent as never, JSON.stringify({ type: "mode", mode: "lock" }));
    expect(agent.closed).toEqual([1008, "only heartbeat messages are accepted"]);
  });

  it("preserves an active lock and reports only its remaining lease after hibernation", async () => {
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    const f = fixture(locked, Date.now() + 7_500);
    const restored = new FakeSocket({ role: "agent", deviceId: "pc-01", connectionId: "restored", lastSeen: Date.now() - 1_000 });
    f.sockets.push(restored);
    const state = await (await f.durable.fetch(new Request("https://state.internal/state"))).json() as ClassroomSnapshot;
    expect(state).toMatchObject({ revision: 3, mode: "lock", leaseMs: 7_500, stream: locked.stream });
    expect(state.leaseMs).toBeLessThanOrEqual(15_000);
    expect(f.values.get("snapshot")).toEqual(locked);
    vi.useRealTimers();
  });

  it("alarm releases an expired controller lease and pushes practice", async () => {
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    const f = fixture(locked, Date.now() - 1);
    const agent = new FakeSocket({ role: "agent", deviceId: "pc-01", connectionId: "a", lastSeen: 2 });
    f.sockets.push(agent);
    await f.durable.alarm();
    expect(JSON.parse(agent.sent.at(-1)!).state).toMatchObject({ revision: 4, mode: "practice", stream: null });
    vi.useRealTimers();
  });

  it("releases immediately when the active controller closes but ignores a superseded close", async () => {
    const f = fixture(locked, Date.now() + 10_000);
    f.values.set("activeControllerConnectionId", "new");
    const agent = new FakeSocket({ role: "agent", deviceId: "pc-01", connectionId: "a", lastSeen: 2 });
    const oldController = new FakeSocket({ role: "controller", connectionId: "old", lastSeen: 1 });
    const controller = new FakeSocket({ role: "controller", connectionId: "new", lastSeen: 1 });
    f.sockets.push(agent, oldController, controller);
    await f.durable.webSocketClose(oldController as never);
    expect((await f.durable.fetch(new Request("https://state.internal/state")).then((r) => r.json()) as ClassroomSnapshot).mode).toBe("lock");
    await f.durable.webSocketClose(controller as never);
    expect(JSON.parse(agent.sent.at(-1)!).state).toMatchObject({ revision: 4, mode: "practice", stream: null });
  });
});

function agentSocket(deviceId: string, attachment: Partial<Attachment> = {}) {
  return new FakeSocket({ role: "agent", deviceId, connectionId: `c-${deviceId}`, lastSeen: 1, mediaReady: false, ...attachment });
}

describe("student media readiness", () => {
  it("accepts both heartbeat frames from an agent without touching mode, lease, or revision", async () => {
    const leaseUntil = Date.now() + 10_000;
    const f = fixture(locked, leaseUntil);
    const reporting = agentSocket("pc-01");
    const bare = agentSocket("pc-02");
    f.sockets.push(reporting, bare);
    await f.durable.webSocketMessage(reporting as never, JSON.stringify({ type: "heartbeat", mediaReady: true }));
    await f.durable.webSocketMessage(bare as never, JSON.stringify({ type: "heartbeat" }));
    expect([reporting.closed, bare.closed]).toEqual([null, null]);
    const state = await (await f.durable.fetch(new Request("https://state.internal/state"))).json() as ClassroomSnapshot;
    expect(state.students).toEqual([
      { deviceId: "pc-01", lastSeen: expect.any(Number), mediaReady: true },
      { deviceId: "pc-02", lastSeen: expect.any(Number), mediaReady: false }
    ]);
    expect(state).toMatchObject({ revision: 3, mode: "lock", stream: locked.stream });
    expect(f.values.get("leaseUntil")).toBe(leaseUntil);
  });

  it("keeps a reported mediaReady across a later bare heartbeat", async () => {
    const f = fixture();
    const agent = agentSocket("pc-01");
    f.sockets.push(agent);
    await f.durable.webSocketMessage(agent as never, JSON.stringify({ type: "heartbeat", mediaReady: true }));
    await f.durable.webSocketMessage(agent as never, JSON.stringify({ type: "heartbeat" }));
    expect(agent.attachment.mediaReady).toBe(true);
    await f.durable.webSocketMessage(agent as never, JSON.stringify({ type: "heartbeat", mediaReady: false }));
    expect(agent.attachment.mediaReady).toBe(false);
  });

  it("closes a controller that reports mediaReady but accepts its bare heartbeat", async () => {
    const f = fixture();
    f.values.set("activeControllerConnectionId", "c");
    const reporting = new FakeSocket({ role: "controller", connectionId: "c", lastSeen: 1, mediaReady: false });
    f.sockets.push(reporting);
    await f.durable.webSocketMessage(reporting as never, JSON.stringify({ type: "heartbeat", mediaReady: true }));
    expect(reporting.closed).toEqual([1008, "only heartbeat messages are accepted"]);
    expect(f.values.get("leaseUntil")).toBe(0);
    const bare = new FakeSocket({ role: "controller", connectionId: "c", lastSeen: 1, mediaReady: false });
    f.sockets.push(bare);
    await f.durable.webSocketMessage(bare as never, JSON.stringify({ type: "heartbeat" }));
    expect(bare.closed).toBeNull();
    expect(f.values.get("leaseUntil")).toBeGreaterThan(Date.now());
  });

  it("closes an agent sending an unknown key, an extra key, or a non-boolean mediaReady", async () => {
    for (const frame of [
      { type: "heartbeat", mediaReady: "true" }, { type: "heartbeat", mediaReady: 1 }, { type: "heartbeat", mediaReady: null },
      { type: "heartbeat", mediaReady: true, extra: 1 }, { type: "heartbeat", ready: true }, { type: "heartbeat", mediaReady: true, deviceId: "pc-99" }
    ]) {
      const f = fixture();
      const agent = agentSocket("pc-01");
      f.sockets.push(agent);
      await f.durable.webSocketMessage(agent as never, JSON.stringify(frame));
      expect([JSON.stringify(frame), agent.closed]).toEqual([JSON.stringify(frame), [1008, "only heartbeat messages are accepted"]]);
      expect(agent.attachment.mediaReady).toBe(false);
    }
  });

  it("keeps the byte cap and its close code ahead of frame validation", async () => {
    const f = fixture();
    const agent = agentSocket("pc-01");
    f.sockets.push(agent);
    await f.durable.webSocketMessage(agent as never, JSON.stringify({ type: "heartbeat", mediaReady: true, pad: "x".repeat(1_100) }));
    expect(agent.closed).toEqual([1009, "message too large"]);
  });

  it("shows mediaReady to the controller and still hides the roster from every agent", async () => {
    const f = fixture();
    const controller = new FakeSocket({ role: "controller", connectionId: "c", lastSeen: 1, mediaReady: false });
    const reporting = agentSocket("pc-01");
    const bare = agentSocket("pc-02");
    f.sockets.push(controller, reporting, bare);
    await f.durable.webSocketMessage(reporting as never, JSON.stringify({ type: "heartbeat", mediaReady: true }));
    await f.durable.webSocketMessage(bare as never, JSON.stringify({ type: "heartbeat" }));
    await f.durable.fetch(new Request("https://state.internal/mode", { method: "POST", body: JSON.stringify({ mode: "lock", stream: locked.stream }) }));
    expect(JSON.parse(controller.sent.at(-1)!).state.students).toEqual([
      { deviceId: "pc-01", lastSeen: expect.any(Number), mediaReady: true },
      { deviceId: "pc-02", lastSeen: expect.any(Number), mediaReady: false }
    ]);
    for (const agent of [reporting, bare]) for (const frame of agent.sent) expect(JSON.parse(frame).state.students).toEqual([]);
  });

  it("defaults a pre-mediaReady hibernated attachment to false instead of dropping the socket", async () => {
    const f = fixture();
    const legacy = new FakeSocket({ role: "agent", deviceId: "pc-07", connectionId: "old", lastSeen: 42 } as Attachment);
    f.sockets.push(legacy);
    const state = await (await f.durable.fetch(new Request("https://state.internal/state"))).json() as ClassroomSnapshot;
    expect(state.students).toEqual([{ deviceId: "pc-07", lastSeen: 42, mediaReady: false }]);
    await f.durable.webSocketMessage(legacy as never, JSON.stringify({ type: "heartbeat", mediaReady: true }));
    expect(legacy.closed).toBeNull();
    expect(legacy.attachment.mediaReady).toBe(true);
  });

  it("validates the heartbeat frame contract per role", () => {
    expect(heartbeatFrame({ type: "heartbeat" }, "controller")).toEqual({});
    expect(heartbeatFrame({ type: "heartbeat" }, "agent")).toEqual({});
    expect(heartbeatFrame({ type: "heartbeat", mediaReady: false }, "agent")).toEqual({ mediaReady: false });
    expect(heartbeatFrame({ type: "heartbeat", mediaReady: true }, "controller")).toBeNull();
    expect(heartbeatFrame({ mediaReady: true }, "agent")).toBeNull();
    expect(heartbeatFrame({ type: "state" }, "agent")).toBeNull();
    expect(heartbeatFrame(null, "agent")).toBeNull();
    expect(heartbeatFrame("heartbeat", "agent")).toBeNull();
  });
});
