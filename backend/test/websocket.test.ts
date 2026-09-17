import { describe, expect, it, vi } from "vitest";
import { ClassroomState, type ClassroomSnapshot } from "../src/index";

interface Attachment { role: "controller" | "agent"; deviceId?: string; connectionId: string; lastSeen: number }
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
    expect(state.students).toEqual([{ deviceId: "pc-09", lastSeen: 123 }]);
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
