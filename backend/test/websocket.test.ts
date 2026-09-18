import { describe, expect, it, vi } from "vitest";
import { ClassroomState, heartbeatFrame, locksInput, type ClassroomSnapshot, type Mode } from "../src/index";

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
/** `lecture` is the second input-locking mode; every fail-safe test below runs it against `lock`. */
const lecturing: ClassroomSnapshot = { ...locked, mode: "lecture" };
const LOCKING_MODES: Mode[] = ["lecture", "lock"];

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

  it("rejects an inbound quit frame instead of growing a new client message type", async () => {
    for (const frame of [{ type: "quit" }, { type: "quit", deviceId: "pc-01" }]) {
      const f = fixture();
      const agent = agentSocket("pc-01");
      f.sockets.push(agent);
      await f.durable.webSocketMessage(agent as never, JSON.stringify(frame));
      expect([JSON.stringify(frame), agent.closed]).toEqual([JSON.stringify(frame), [1008, "only heartbeat messages are accepted"]]);
    }
    expect(heartbeatFrame({ type: "quit" }, "agent")).toBeNull();
    expect(heartbeatFrame({ type: "quit" }, "controller")).toBeNull();
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

describe("lecture inherits every lock fail-safe", () => {
  it("fans out a lecture command, arms the lease alarm, and keeps the roster private", async () => {
    const f = fixture();
    const controller = new FakeSocket({ role: "controller", connectionId: "c", lastSeen: 1 });
    const agent = new FakeSocket({ role: "agent", deviceId: "pc-01", connectionId: "a", lastSeen: 2 });
    f.sockets.push(controller, agent);
    const response = await f.durable.fetch(new Request("https://state.internal/mode", { method: "POST", body: JSON.stringify({ mode: "lecture", stream: lecturing.stream }) }));
    expect(response.status).toBe(200);
    expect(JSON.parse(controller.sent.at(-1)!).state).toMatchObject({ mode: "lecture", stream: lecturing.stream, students: [{ deviceId: "pc-01" }] });
    expect(JSON.parse(agent.sent.at(-1)!).state).toMatchObject({ mode: "lecture", stream: lecturing.stream, students: [] });
    expect(JSON.parse(agent.sent.at(-1)!).state.leaseMs).toBeGreaterThan(0);
    expect(f.alarmAt).toBeGreaterThan(Date.now());
    expect(await f.values.get("leaseUntil")).toBeGreaterThan(Date.now());
  });

  it("rejects quit and every other unknown name as a class mode", async () => {
    const f = fixture();
    for (const mode of ["quit", "Lecture", "unlock"]) {
      const response = await f.durable.fetch(new Request("https://state.internal/mode", { method: "POST", body: JSON.stringify({ mode }) }));
      expect([mode, response.status]).toEqual([mode, 400]);
    }
    expect(f.values.get("snapshot")).toBeUndefined();
  });

  it("releases an expired lecture on an agent heartbeat exactly as it releases a lock", async () => {
    const outcomes: ClassroomSnapshot[] = [];
    for (const mode of LOCKING_MODES) {
      const f = fixture({ ...locked, mode }, Date.now() - 1);
      const agent = agentSocket("pc-01");
      f.sockets.push(agent);
      await f.durable.webSocketMessage(agent as never, JSON.stringify({ type: "heartbeat" }));
      const pushed = JSON.parse(agent.sent.at(-1)!).state as ClassroomSnapshot;
      expect(pushed).toMatchObject({ revision: 4, mode: "practice", leaseMs: 0, stream: null });
      expect(locksInput(pushed.mode)).toBe(false);
      expect(f.values.get("snapshot")).toMatchObject({ mode: "practice", stream: null });
      outcomes.push({ ...pushed, students: [] });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  });

  it("releases an expired lecture from the alarm path", async () => {
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    const f = fixture(lecturing, Date.now() - 1);
    const agent = agentSocket("pc-01");
    f.sockets.push(agent);
    await f.durable.alarm();
    expect(JSON.parse(agent.sent.at(-1)!).state).toMatchObject({ revision: 4, mode: "practice", leaseMs: 0, stream: null });
    vi.useRealTimers();
  });

  it("releases a lecture when the active controller socket closes or errors", async () => {
    for (const hangUp of ["webSocketClose", "webSocketError"] as const) {
      const f = fixture(lecturing, Date.now() + 10_000);
      f.values.set("activeControllerConnectionId", "live");
      const agent = agentSocket("pc-01");
      const controller = new FakeSocket({ role: "controller", connectionId: "live", lastSeen: 1 });
      f.sockets.push(agent, controller);
      await f.durable[hangUp](controller as never);
      expect([hangUp, JSON.parse(agent.sent.at(-1)!).state.mode]).toEqual([hangUp, "practice"]);
      expect(JSON.parse(agent.sent.at(-1)!).state).toMatchObject({ revision: 4, stream: null });
      expect(await f.values.get("leaseUntil")).toBe(0);
    }
  });

  it("keeps an unexpired lecture and only its remaining lease across hibernation", async () => {
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    const f = fixture(lecturing, Date.now() + 7_500);
    f.sockets.push(agentSocket("pc-01"));
    const state = await (await f.durable.fetch(new Request("https://state.internal/state"))).json() as ClassroomSnapshot;
    expect(state).toMatchObject({ revision: 3, mode: "lecture", leaseMs: 7_500, stream: lecturing.stream });
    expect(f.values.get("snapshot")).toEqual(lecturing);
    vi.useRealTimers();
  });

  it("keeps revision monotonic across a lecture command and its release", async () => {
    const f = fixture(lecturing, Date.now() + 10_000);
    await f.durable.fetch(new Request("https://state.internal/mode", { method: "POST", body: JSON.stringify({ mode: "lecture", stream: lecturing.stream }) }));
    expect((f.values.get("snapshot") as ClassroomSnapshot).revision).toBe(4);
    f.values.set("leaseUntil", Date.now() - 1);
    const released = await (await f.durable.fetch(new Request("https://state.internal/state"))).json() as ClassroomSnapshot;
    expect(released).toMatchObject({ revision: 5, mode: "practice" });
    expect(((await (await f.durable.fetch(new Request("https://state.internal/state"))).json()) as ClassroomSnapshot).revision).toBe(5);
  });
});

describe("agent quit fanout", () => {
  const quit = () => new Request("https://state.internal/agents/quit", { method: "POST" });

  it("messages every agent socket, never a controller, and reports the count", async () => {
    const f = fixture();
    const controller = new FakeSocket({ role: "controller", connectionId: "c", lastSeen: 1 });
    const agents = ["pc-01", "pc-02", "pc-03"].map((id) => agentSocket(id));
    f.sockets.push(controller, ...agents);
    const response = await f.durable.fetch(quit());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, notified: 3 });
    for (const agent of agents) expect(agent.sent.map((frame) => JSON.parse(frame))).toEqual([{ type: "quit" }]);
    expect(controller.sent).toEqual([]);
    expect(agents.every((a) => a.closed === null)).toBe(true);
  });

  it("reports zero when no agent is connected", async () => {
    const f = fixture();
    f.sockets.push(new FakeSocket({ role: "controller", connectionId: "c", lastSeen: 1 }));
    expect(await (await f.durable.fetch(quit())).json()).toEqual({ ok: true, notified: 0 });
  });

  it("does not count a socket it could not message or one without an identity", async () => {
    const f = fixture();
    const healthy = agentSocket("pc-01");
    const broken = agentSocket("pc-02");
    broken.send = () => { throw new Error("closing"); };
    const anonymous = new FakeSocket(null as never);
    f.sockets.push(healthy, broken, anonymous);
    expect(await (await f.durable.fetch(quit())).json()).toEqual({ ok: true, notified: 1 });
    expect(healthy.sent.map((frame) => JSON.parse(frame))).toEqual([{ type: "quit" }]);
  });

  it("writes nothing to storage and leaves mode, revision, lease and stream untouched", async () => {
    const leaseUntil = Date.now() + 10_000;
    const f = fixture(lecturing, leaseUntil);
    f.sockets.push(agentSocket("pc-01"));
    const before = await (await f.durable.fetch(new Request("https://state.internal/state"))).json() as ClassroomSnapshot;
    const storedBefore = JSON.stringify([...f.values.entries()]);
    await f.durable.fetch(quit());
    expect(JSON.stringify([...f.values.entries()])).toBe(storedBefore);
    expect(storedBefore.includes("quit")).toBe(false);
    const after = await (await f.durable.fetch(new Request("https://state.internal/state"))).json() as ClassroomSnapshot;
    expect({ ...after, leaseMs: 0 }).toEqual({ ...before, leaseMs: 0 });
    expect(after).toMatchObject({ revision: 3, mode: "lecture", stream: lecturing.stream });
    expect(after.leaseMs).toBeGreaterThan(0);
    expect(await f.values.get("leaseUntil")).toBe(leaseUntil);
  });

  it("never reaches an agent that attaches after the command, and is not replayed by a state push", async () => {
    const f = fixture(lecturing, Date.now() + 10_000);
    const present = agentSocket("pc-01");
    f.sockets.push(present);
    expect(await (await f.durable.fetch(quit())).json()).toEqual({ ok: true, notified: 1 });
    const late = agentSocket("pc-99");
    f.sockets.push(late);
    // Everything the Durable Object pushes from here on is state only; the command left no trace to replay.
    await f.durable.webSocketMessage(late as never, JSON.stringify({ type: "heartbeat", mediaReady: true }));
    await f.durable.fetch(new Request("https://state.internal/mode", { method: "POST", body: JSON.stringify({ mode: "lock", stream: locked.stream }) }));
    await f.durable.alarm();
    expect(late.sent.length).toBeGreaterThan(0);
    expect(late.sent.map((frame) => JSON.parse(frame).type as string)).toEqual(late.sent.map(() => "state"));
    expect(late.sent.some((frame) => frame.includes("quit"))).toBe(false);
    // A second command is a fresh fanout over the sockets connected at that instant.
    expect(await (await f.durable.fetch(quit())).json()).toEqual({ ok: true, notified: 2 });
    expect(late.sent.filter((frame) => JSON.parse(frame).type === "quit").length).toBe(1);
  });
});
