import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassroomState, heartbeatPolicy, persistsAttachment, type ClassroomSnapshot } from "../src/index";

// Read through the accessor: workerd rejects a bare numeric export from the Worker entry module.
const { heartbeatMs: HEARTBEAT_MS, rosterCutoffMs: ROSTER_CUTOFF_MS, stalenessBoundMs: LAST_SEEN_STALENESS_BOUND_MS, persistAfterMs: LAST_SEEN_PERSIST_AFTER_MS } = heartbeatPolicy();

/**
 * Durable Object SQLite row writes are the one free-plan resource this PoC projects over: 31 devices
 * heartbeating every 5 s for eight hours wrote the socket attachment 178,560 times against a
 * 100,000/day budget. These tests count the writes rather than trusting that they went down.
 */
interface Attachment { role: "controller" | "agent"; deviceId?: string; connectionId: string; lastSeen: number; mediaReady: boolean }
class CountingSocket {
  sent: string[] = [];
  /** Every `serializeAttachment` call — the quantity the whole policy exists to bound. */
  writes = 0;
  closed: [number, string] | null = null;
  constructor(public attachment: Attachment) {}
  // A clone, as hibernation hands back: a skipped write must be a real skip, not a mutation that leaked through.
  deserializeAttachment() { return structuredClone(this.attachment); }
  serializeAttachment(value: Attachment) { this.attachment = structuredClone(value); this.writes += 1; }
  send(value: string) { this.sent.push(value); }
  close(code: number, reason: string) { this.closed = [code, reason]; }
}

function fixture(snapshot?: ClassroomSnapshot, leaseUntil = 0) {
  const values = new Map<string, unknown>();
  if (snapshot) values.set("snapshot", structuredClone(snapshot));
  values.set("leaseUntil", leaseUntil);
  const sockets: CountingSocket[] = [];
  let alarmAt: number | null = null;
  let alarms = 0;
  const durable = new ClassroomState({
    storage: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      setAlarm: async (value: number) => { alarmAt = value; alarms += 1; }
    },
    getWebSockets: () => sockets
  } as never);
  return { durable, values, sockets, get alarmAt() { return alarmAt; }, get alarms() { return alarms; } };
}

type Fixture = ReturnType<typeof fixture>;
function agentSocket(deviceId: string, lastSeen: number, mediaReady = false) {
  return new CountingSocket({ role: "agent", deviceId, connectionId: `c-${deviceId}`, lastSeen, mediaReady });
}
async function heartbeat(f: Fixture, socket: CountingSocket, mediaReady?: boolean) {
  await f.durable.webSocketMessage(socket as never, JSON.stringify(mediaReady === undefined ? { type: "heartbeat" } : { type: "heartbeat", mediaReady }));
}
async function roster(f: Fixture) {
  return ((await (await f.durable.fetch(new Request("https://state.internal/state"))).json()) as ClassroomSnapshot).students;
}

/** One realistic session: 30 student devices plus the instructor, eight hours, five hours of it broadcasting. */
const SESSION_MS = 8 * 60 * 60 * 1_000;
const DEVICES = 31;
const HEARTBEATS_PER_DEVICE = SESSION_MS / HEARTBEAT_MS;
const START = Date.parse("2026-09-19T01:00:00Z");

afterEach(() => vi.useRealTimers());

describe("attachment write volume", () => {
  it("halves the writes across an eight-hour session whose mediaReady never changes", async () => {
    vi.setSystemTime(START);
    const f = fixture();
    const agent = agentSocket("pc-01", START, true);
    f.sockets.push(agent);
    for (let i = 1; i <= HEARTBEATS_PER_DEVICE; i += 1) {
      vi.setSystemTime(START + i * HEARTBEAT_MS);
      await heartbeat(f, agent, true);
    }
    expect(HEARTBEATS_PER_DEVICE).toBe(5_760);
    // One write per heartbeat was the old cost; the policy writes on every second one.
    expect(agent.writes).toBe(HEARTBEATS_PER_DEVICE / 2);
    expect(agent.writes).toBe(2_880);
    // The projection this change exists for, stated as arithmetic rather than as a claim.
    expect(HEARTBEATS_PER_DEVICE * DEVICES).toBe(178_560);
    expect(agent.writes * DEVICES).toBe(89_280);
    // Still a live student at the end, not one the roster has aged out.
    expect(agent.attachment).toMatchObject({ deviceId: "pc-01", mediaReady: true, lastSeen: START + SESSION_MS });
  });

  it("keeps the controller's own heartbeat writes down without touching when its lease expires", async () => {
    vi.setSystemTime(START);
    const f = fixture();
    f.values.set("activeControllerConnectionId", "live");
    const controller = new CountingSocket({ role: "controller", connectionId: "live", lastSeen: START, mediaReady: false });
    f.sockets.push(controller);
    const rounds = 8;
    for (let i = 1; i <= rounds; i += 1) {
      vi.setSystemTime(START + i * HEARTBEAT_MS);
      await heartbeat(f, controller);
      // The lease deadline and its alarm are renewed by *every* heartbeat, skipped attachment write or not.
      expect([i, f.values.get("leaseUntil")]).toEqual([i, START + i * HEARTBEAT_MS + 15_000]);
      expect([i, f.alarmAt]).toEqual([i, START + i * HEARTBEAT_MS + 15_000]);
      expect([i, f.alarms]).toEqual([i, i]);
    }
    expect(controller.closed).toBeNull();
    expect(controller.writes).toBe(rounds / 2);
  });
});

describe("lastSeen staleness bound", () => {
  it("never lets the roster's persisted lastSeen reach the cutoff, including between heartbeats", async () => {
    vi.setSystemTime(START);
    const f = fixture();
    const agent = agentSocket("pc-01", START);
    f.sockets.push(agent);
    let worst = 0;
    for (let i = 1; i <= 240; i += 1) {
      const at = START + i * HEARTBEAT_MS;
      vi.setSystemTime(at);
      await heartbeat(f, agent, false);
      // Sample at the instant just before the next heartbeat, where the persisted value is at its stalest.
      for (const now of [at, at + HEARTBEAT_MS - 1]) {
        vi.setSystemTime(now);
        const staleness = now - (await roster(f))[0].lastSeen;
        worst = Math.max(worst, staleness);
        expect([i, staleness <= LAST_SEEN_STALENESS_BOUND_MS]).toEqual([i, true]);
      }
    }
    // Tight: the bound is reached, so the test would notice a policy that drifted past it.
    expect(worst).toBe(LAST_SEEN_STALENESS_BOUND_MS - 1);
    expect(worst).toBeLessThan(ROSTER_CUTOFF_MS);
    // The margin the bound is chosen for: a full heartbeat period of slack against the roster cutoff.
    expect(LAST_SEEN_STALENESS_BOUND_MS + HEARTBEAT_MS).toBeLessThanOrEqual(ROSTER_CUTOFF_MS);
  });

  it("still writes on the second heartbeat when the cadence jitters, and keeps the device in the roster", async () => {
    vi.setSystemTime(START);
    const f = fixture();
    const agent = agentSocket("pc-01", START);
    f.sockets.push(agent);
    // ±10% jitter on the 5 s cadence. A threshold of exactly two periods would let the negative side
    // defer the write to the third heartbeat — 15 s, the cutoff itself. 1.5 periods cannot.
    const jitter = [-500, 320, -480, 150, -420, 500, -260, 90];
    let at = START;
    let worst = 0;
    for (let i = 1; i <= 240; i += 1) {
      at += HEARTBEAT_MS + jitter[i % jitter.length];
      vi.setSystemTime(at);
      await heartbeat(f, agent, false);
      const staleness = at - (await roster(f))[0].lastSeen;
      worst = Math.max(worst, staleness);
      // A write on every second heartbeat exactly, never a third.
      expect([i, agent.writes]).toEqual([i, Math.floor(i / 2)]);
    }
    expect(worst).toBeLessThan(ROSTER_CUTOFF_MS - HEARTBEAT_MS);
  });

  it("rewrites a timestamp that is ahead of now rather than trusting it", () => {
    const persisted = { lastSeen: START + 60_000, mediaReady: false };
    expect(persistsAttachment(persisted, { lastSeen: START, mediaReady: false })).toBe(true);
  });

  it("writes at 1.5 heartbeat periods, so jitter cannot defer it past a second heartbeat", () => {
    const persisted = { lastSeen: 0, mediaReady: false };
    const after = (lastSeen: number) => persistsAttachment(persisted, { lastSeen, mediaReady: false });
    expect(LAST_SEEN_PERSIST_AFTER_MS).toBe(7_500);
    // A punctual first heartbeat waits; the second writes even when it runs a full 10% early.
    expect([after(HEARTBEAT_MS), after(LAST_SEEN_PERSIST_AFTER_MS - 1), after(LAST_SEEN_PERSIST_AFTER_MS), after(LAST_SEEN_STALENESS_BOUND_MS - 500)])
      .toEqual([false, false, true, true]);
  });
});

describe("mediaReady persists the moment it changes", () => {
  it("writes a flip immediately however recently the last write happened", async () => {
    vi.setSystemTime(START);
    const f = fixture();
    const agent = agentSocket("pc-01", START);
    f.sockets.push(agent);
    // Inside the lastSeen window, so only the flip itself can be the reason for a write.
    vi.setSystemTime(START + 1);
    await heartbeat(f, agent, true);
    expect(agent.writes).toBe(1);
    expect(await roster(f)).toEqual([{ deviceId: "pc-01", lastSeen: START + 1, mediaReady: true }]);
    vi.setSystemTime(START + 2);
    await heartbeat(f, agent, false);
    expect(agent.writes).toBe(2);
    expect(await roster(f)).toEqual([{ deviceId: "pc-01", lastSeen: START + 2, mediaReady: false }]);
    // An unchanged mediaReady is never a reason to write.
    vi.setSystemTime(START + 3);
    await heartbeat(f, agent, false);
    expect(agent.writes).toBe(2);
  });

  it("writes every heartbeat while a device flaps, and stops as soon as it settles", async () => {
    vi.setSystemTime(START);
    const f = fixture();
    const agent = agentSocket("pc-01", START);
    f.sockets.push(agent);
    for (let i = 1; i <= 6; i += 1) {
      vi.setSystemTime(START + i * 100);
      await heartbeat(f, agent, i % 2 === 1);
      expect([i, agent.writes]).toEqual([i, i]);
    }
    vi.setSystemTime(START + 700);
    await heartbeat(f, agent, false);
    expect(agent.writes).toBe(6);
  });

  it("shows the instructor 28 of 30 receiving video with no delay, as the smoke run asserts", async () => {
    vi.setSystemTime(START);
    const f = fixture();
    const agents = Array.from({ length: 30 }, (_, i) => agentSocket(`smoke-${String(i).padStart(2, "0")}`, START));
    f.sockets.push(...agents);
    vi.setSystemTime(START + 5);
    for (const [index, agent] of agents.entries()) await heartbeat(f, agent, index < 28);
    const students = await roster(f);
    expect(students.filter((s) => s.mediaReady).length).toBe(28);
    expect(students.length).toBe(30);
    // Only the 28 flips were written; the two that stayed false wrote nothing.
    expect(agents.reduce((total, a) => total + a.writes, 0)).toBe(28);
    vi.setSystemTime(START + 10);
    await heartbeat(f, agents[0], false);
    expect((await roster(f)).filter((s) => s.mediaReady).length).toBe(27);
  });
});

describe("the bound is coupled to the roster cutoff", () => {
  it("mirrors ROSTER_CUTOFF_MS from the renderer that actually applies it", () => {
    const renderer = readFileSync(new URL("../../apps/src/renderer.js", import.meta.url), "utf8");
    const declared = renderer.match(/const ROSTER_CUTOFF_MS = ([\d_]+);/)?.[1];
    expect(declared, "apps/src/renderer.js must still declare ROSTER_CUTOFF_MS; the backend mirrors it to derive LAST_SEEN_STALENESS_BOUND_MS").toBeDefined();
    expect(Number(declared!.replace(/_/g, "")), "ROSTER_CUTOFF_MS changed in apps/src/renderer.js: update ROSTER_CUTOFF_MS and LAST_SEEN_STALENESS_BOUND_MS in backend/src/index.ts to match").toBe(ROSTER_CUTOFF_MS);
  });

  it("keeps a full heartbeat period between the staleness bound and the cutoff", () => {
    expect(LAST_SEEN_STALENESS_BOUND_MS).toBeLessThan(ROSTER_CUTOFF_MS);
    expect(LAST_SEEN_STALENESS_BOUND_MS + HEARTBEAT_MS).toBeLessThanOrEqual(ROSTER_CUTOFF_MS);
  });

  /**
   * Measured 2026-09-19 against miniflare's workerd: exporting these timings as bare numbers made the
   * runtime refuse to start with "Incorrect type for map entry 'HEARTBEAT_MS': the provided value is not
   * of type 'function or ExportedHandler'". `tsc` and the bundle were both clean, so only a boot caught
   * it. They are reached through heartbeatPolicy() for that reason, and this holds the line.
   */
  it("exports no bare number from the Worker entry module, which workerd refuses to boot", async () => {
    const module = await import("../src/index") as Record<string, unknown>;
    const numeric = Object.entries(module).filter(([, value]) => typeof value === "number").map(([name]) => name);
    expect(numeric).toEqual([]);
    expect(typeof heartbeatPolicy).toBe("function");
  });
});
