export type Role = "controller" | "agent";
/**
 * The four wire mode names, in one place so no other site enumerates them.
 * `practice` students free, no stream. `broadcast` instructor screen visible, input free.
 * `lecture` instructor screen visible and input locked. `lock` input locked and the screen
 * deliberately obscured so students look at the instructor instead. `practice` is the fail-safe
 * default every release falls back to; the other three are instructor commands that hold the lease.
 */
export const MODES = ["practice", "broadcast", "lecture", "lock"] as const;
export type Mode = (typeof MODES)[number];
export interface Stream { sessionId: string; trackName: string }
/** `mediaReady` is the student's own report that it is receiving video. It is presence diagnostics only, never screen content or device telemetry. */
export interface ClassroomSnapshot { revision: number; mode: Mode; leaseMs: number; stream: Stream | null; students: { deviceId: string; lastSeen: number; mediaReady: boolean }[] }

export interface Env {
  CLASSROOM: DurableObjectNamespace;
  CONTROLLER_TOKEN: string;
  AGENT_TOKENS_JSON: string;
  CLASSROOM_ID?: string;
  SFU_APP_ID?: string;
  SFU_APP_TOKEN?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}
interface Principal { role: Role; deviceId?: string }
interface SocketAttachment extends Principal { connectionId: string; lastSeen: number; mediaReady: boolean }
const LEASE_MS = 15_000;
/**
 * The cadence at which the Controller and every Agent send `{type:"heartbeat"}` (`docs/protocol.md`).
 * The server never enforces it — it is mirrored here only to derive the attachment write policy below.
 * It is deliberately three times shorter than LEASE_MS so an expiry needs three consecutive losses;
 * at 10 s a single lost packet would release the whole class into practice mid-lecture.
 */
const HEARTBEAT_MS = 5_000;
/**
 * The instructor's roster drops a student whose `lastSeen` is older than this — `ROSTER_CUTOFF_MS` in
 * `apps/src/renderer.js`, applied to `student.lastSeen` in `summarizeRoster()`. The client stays the
 * site that enforces it; this mirror exists so the persistence bound below is derived from it rather
 * than guessed, and `backend/test/heartbeat-writes.test.ts` fails if the two ever drift apart.
 */
const ROSTER_CUTOFF_MS = 15_000;
/**
 * How stale a *persisted* `lastSeen` may ever be.
 *
 * A heartbeat no longer writes the socket attachment every time. At the 5 s cadence, 31 devices for
 * eight hours was 178,560 attachment writes against a 100,000/day free-plan budget for Durable Object
 * SQLite row writes. The roster only needs `lastSeen` fresh enough to stay inside ROSTER_CUTOFF_MS, so
 * the persisted value is allowed to lag — but **never by as much as the cutoff**, or a perfectly healthy
 * student starts flickering in and out of the instructor's connected count. This bound is two thirds of
 * the cutoff, leaving a full heartbeat period spare, which also absorbs the skew between the Durable
 * Object's clock (which stamps `lastSeen`) and the instructor PC's clock (which applies the cutoff).
 *
 * **The invariant is `LAST_SEEN_STALENESS_BOUND_MS + HEARTBEAT_MS <= ROSTER_CUTOFF_MS`.** If the cutoff
 * in the renderer changes, this has to change with it, and that test file holds the coupling.
 */
const LAST_SEEN_STALENESS_BOUND_MS = 2 * HEARTBEAT_MS;
/**
 * Persist `lastSeen` on the first heartbeat at or after this much time since the persisted value, which
 * at the 5 s cadence is every second heartbeat: half the writes, and a persisted value refreshed every
 * ~10 s, i.e. never staler than LAST_SEEN_STALENESS_BOUND_MS. It sits at 1.5 heartbeat periods rather
 * than exactly 2 on purpose — an exact multiple would let a few milliseconds of heartbeat jitter defer
 * the write to the *third* heartbeat, ~15 s, the cutoff itself. This leaves 2.5 s of slack for jitter.
 */
const LAST_SEEN_PERSIST_AFTER_MS = 1.5 * HEARTBEAT_MS;
/**
 * The timings above, for the tests that hold them against `ROSTER_CUTOFF_MS` in `apps/src/renderer.js`.
 *
 * A function, not four exported numbers. workerd treats every named export of the entry module as a
 * service entrypoint and rejects a bare number — `Incorrect type for map entry 'HEARTBEAT_MS': the
 * provided value is not of type 'function or ExportedHandler'` — which kills the Worker at *startup*,
 * not at build time, so neither `tsc` nor a bundle check would have caught it. Measured on 2026-09-19
 * against miniflare's workerd via `scripts/ws-smoke.mjs`, which failed to boot until these went private.
 */
export function heartbeatPolicy() {
  return { heartbeatMs: HEARTBEAT_MS, rosterCutoffMs: ROSTER_CUTOFF_MS, stalenessBoundMs: LAST_SEEN_STALENESS_BOUND_MS, persistAfterMs: LAST_SEEN_PERSIST_AFTER_MS } as const;
}
const RTC_BASE = "https://rtc.live.cloudflare.com/v1/apps";

export function authenticate(request: Request, env: Pick<Env, "CONTROLLER_TOKEN" | "AGENT_TOKENS_JSON">): Principal | null {
  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  if (token === env.CONTROLLER_TOKEN) return { role: "controller" };
  const deviceId = request.headers.get("X-Device-Id");
  if (!deviceId) return null;
  try {
    const devices = JSON.parse(env.AGENT_TOKENS_JSON) as Record<string, string>;
    return devices[deviceId] === token ? { role: "agent", deviceId } : null;
  } catch { return null; }
}
/** Pure policy helpers keep the critical fail-safe and session boundary testable. */
export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}
/**
 * The only modes that suppress student input: `lecture` (watch the instructor's screen) and `lock`
 * (screen obscured, look at the instructor). Every backend decision about locking goes through this
 * predicate so adding a locking mode can never leave a stray `mode === "lock"` behind.
 */
export function locksInput(mode: Mode): boolean {
  return mode === "lecture" || mode === "lock";
}
/**
 * Every commanded mode needs a published instructor track and holds the controller lease.
 * `practice` is the only mode that clears the stream and holds no lease.
 */
export function requiresStream(mode: Mode): boolean {
  return mode !== "practice";
}
/** Releases any commanded mode — `broadcast`, `lecture` and `lock` alike — once its lease is gone. */
export function expireLease(snapshot: ClassroomSnapshot, leaseUntil: number, now = Date.now()): ClassroomSnapshot {
  if (snapshot.mode === "practice" || now < leaseUntil) return snapshot;
  return { ...snapshot, revision: snapshot.revision + 1, mode: "practice", stream: null };
}
export function ownsSession(owner: Principal | null, principal: Principal): boolean {
  return !!owner && owner.role === principal.role && owner.deviceId === principal.deviceId;
}
/** Accepts only `{type:"heartbeat"}` and an agent's `{type:"heartbeat", mediaReady:<boolean>}`. Returns null for anything else. */
export function heartbeatFrame(payload: unknown, role: Role): { mediaReady?: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const frame = payload as { type?: unknown; mediaReady?: unknown };
  if (frame.type !== "heartbeat") return null;
  const keys = Object.keys(payload);
  if (keys.length === 1) return {};
  // A controller receives no video, so accepting mediaReady from it would be a silent protocol hole.
  if (keys.length !== 2 || !keys.includes("mediaReady") || typeof frame.mediaReady !== "boolean" || role !== "agent") return null;
  return { mediaReady: frame.mediaReady };
}
/**
 * Whether a heartbeat has to be written back to the socket attachment. Both fields it carries are
 * presence metadata, but they have different urgency:
 *
 * - `mediaReady` persists the instant it changes, and only then. It drives the instructor's
 *   `연결 N · 영상 M` line — the one signal separating "a control socket is attached" from "this student
 *   is actually receiving video" — so a stale value there actively misleads during a class. An unchanged
 *   `mediaReady` is never a reason to write.
 * - `lastSeen` only has to stay inside LAST_SEEN_STALENESS_BOUND_MS, so it is written on the first
 *   heartbeat at or after LAST_SEEN_PERSIST_AFTER_MS and skipped in between.
 *
 * A persisted timestamp somehow ahead of `now` is rewritten rather than trusted, so a clock that jumped
 * backwards cannot stall the refresh indefinitely and strand a live student behind the roster cutoff.
 */
export function persistsAttachment(persisted: { lastSeen: number; mediaReady: boolean }, next: { lastSeen: number; mediaReady: boolean }): boolean {
  if (persisted.mediaReady !== next.mediaReady) return true;
  const elapsed = next.lastSeen - persisted.lastSeen;
  return elapsed >= LAST_SEEN_PERSIST_AFTER_MS || elapsed < 0;
}
function json(data: unknown, status = 200): Response { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
function error(message: string, status = 400): Response { return json({ error: message }, status); }
async function body(request: Request): Promise<Record<string, unknown> | null> { try { const text = await request.text(); if (new TextEncoder().encode(text).byteLength > 100_000) return null; const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }
/** An absent body or `{}` and nothing else, so a parameterless command can never grow an implicit parameter. */
async function emptyBody(request: Request): Promise<boolean> {
  try {
    const text = (await request.text()).trim();
    if (text === "") return true;
    const value = JSON.parse(text);
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
}
function isStream(value: unknown): value is Stream { return !!value && typeof value === "object" && typeof (value as Stream).sessionId === "string" && typeof (value as Stream).trackName === "string"; }

async function stateStub(env: Env): Promise<DurableObjectStub> {
  return env.CLASSROOM.get(env.CLASSROOM.idFromName(env.CLASSROOM_ID || "training"));
}
async function doCall(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return (await stateStub(env)).fetch(new Request(`https://state.internal${path}`, init));
}
async function getState(env: Env): Promise<ClassroomSnapshot> { return await (await doCall(env, "/state")).json() as ClassroomSnapshot; }
function redact(snapshot: ClassroomSnapshot, principal: Principal): ClassroomSnapshot {
  return principal.role === "controller" ? snapshot : { ...snapshot, students: [] };
}

async function sfu(env: Env, path: string, method: string, payload: unknown): Promise<Response> {
  if (!env.SFU_APP_ID || !env.SFU_APP_TOKEN) return error("SFU_APP_ID and SFU_APP_TOKEN are required for live RTC", 503);
  let upstream: Response;
  try { upstream = await fetch(`${RTC_BASE}/${env.SFU_APP_ID}${path}`, { method, headers: { Authorization: `Bearer ${env.SFU_APP_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) }); } catch { return error("Realtime service unavailable", 502); }
  return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" } });
}
function validSessionDescription(value: unknown): boolean { return !!value && typeof value === "object" && ((value as { type?: unknown }).type === "offer" || (value as { type?: unknown }).type === "answer") && typeof (value as { sdp?: unknown }).sdp === "string"; }
function sessionPayload(payload: Record<string, unknown>): boolean { return Object.keys(payload).length === 0 || (Object.keys(payload).length === 1 && validSessionDescription(payload.sessionDescription)); }
function sdpOnly(payload: Record<string, unknown>): boolean { return Object.keys(payload).length === 1 && validSessionDescription(payload.sessionDescription); }
function tracksPayload(payload: Record<string, unknown>): boolean { return Object.keys(payload).every((key) => key === "tracks" || key === "sessionDescription") && Array.isArray(payload.tracks); }
function localVideoOnly(payload: Record<string, unknown>): boolean {
  const tracks = payload.tracks;
  return tracksPayload(payload) && Array.isArray(tracks) && tracks.length > 0 && tracks.every((t) => typeof t === "object" && t !== null && (t as Record<string, unknown>).location === "local" && (t as Record<string, unknown>).kind === "video" && typeof (t as Record<string, unknown>).trackName === "string");
}
function onlyActiveRemote(payload: Record<string, unknown>, stream: Stream): boolean {
  const tracks = payload.tracks;
  return tracksPayload(payload) && Array.isArray(tracks) && tracks.length === 1 && typeof tracks[0] === "object" && tracks[0] !== null && (tracks[0] as Record<string, unknown>).location === "remote" && (tracks[0] as Record<string, unknown>).sessionId === stream.sessionId && (tracks[0] as Record<string, unknown>).trackName === stream.trackName;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
    const principal = authenticate(request, env);
    if (!principal) return error("unauthorized", 401);
    if (url.pathname === "/api/connect" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("websocket upgrade required", 426);
      return doCall(env, "/connect", { headers: {
        Upgrade: "websocket",
        "X-ClassRelay-Role": principal.role,
        ...(principal.deviceId ? { "X-ClassRelay-Device-Id": principal.deviceId } : {})
      } });
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      const state = await getState(env);
      return json(redact(state, principal));
    }
    if (url.pathname === "/api/heartbeat" && request.method === "POST") {
      await doCall(env, "/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(principal) });
      const current = await getState(env);
      return json(redact(current, principal));
    }
    if (url.pathname === "/api/mode" && request.method === "POST") {
      if (principal.role !== "controller") return error("controller role required", 403);
      const payload = await body(request);
      if (!payload) return error("invalid JSON");
      const mode = payload?.mode;
      // Only the four wire names reach the state machine; shutting an app down is not a mode.
      if (!isMode(mode)) return error("invalid mode");
      const stream = payload.stream;
      if (requiresStream(mode) && !isStream(stream)) return error("broadcast, lecture and lock require a stream");
      if (stream && !isStream(stream)) return error("invalid stream");
      if (isStream(stream)) {
        const ownerResponse = await doCall(env, `/owner/${encodeURIComponent(stream.sessionId)}`);
        const owner = ownerResponse.ok ? await ownerResponse.json() as Principal : null;
        if (!ownsSession(owner, { role: "controller" })) return error("stream session is not owned by controller", 403);
        if (!(await doCall(env, `/published/${encodeURIComponent(stream.sessionId)}/${encodeURIComponent(stream.trackName)}`)).ok) return error("stream track was not published by controller", 403);
      }
      await doCall(env, "/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, stream: requiresStream(mode) ? stream : null }) });
      return json(await getState(env));
    }
    if (url.pathname === "/api/agents/quit" && request.method === "POST") {
      if (principal.role !== "controller") return error("controller role required", 403);
      if (!(await emptyBody(request))) return error("quit takes an empty JSON body");
      // Transient fanout to the Agent sockets connected right now. It carries no state and changes none.
      return doCall(env, "/agents/quit", { method: "POST" });
    }
    if (url.pathname === "/api/rtc/sessions" && request.method === "POST") {
      const current = await getState(env);
      if (principal.role === "agent" && !current.stream) return error("no active stream to subscribe to", 409);
      const payload = await body(request); if (!payload || !sessionPayload(payload)) return error("session requires an empty object or valid sessionDescription");
      const result = await sfu(env, "/sessions/new", "POST", payload); if (!result.ok) return result;
      const clone = result.clone(); const response = await clone.json() as { sessionId?: string };
      if (!response.sessionId) return error("SFU response did not include sessionId", 502);
      await doCall(env, "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: response.sessionId, ...principal }) });
      return result;
    }
    const match = url.pathname.match(/^\/api\/rtc\/sessions\/([^/]+)(\/tracks|\/renegotiate)$/);
    if (match && (request.method === "POST" || request.method === "PUT")) {
      const sessionId = decodeURIComponent(match[1]); const action = match[2];
      if ((action === "/tracks" && request.method !== "POST") || (action === "/renegotiate" && request.method !== "PUT")) return error("method not allowed", 405);
      const owner = await (await doCall(env, `/owner/${encodeURIComponent(sessionId)}`)).json() as Principal | null;
      if (!ownsSession(owner, principal)) return error("session is not owned by this principal", 403);
      const payload = await body(request); if (!payload || (action === "/renegotiate" && !sdpOnly(payload))) return error(action === "/renegotiate" ? "renegotiate requires only sessionDescription" : "invalid JSON");
      if (action === "/tracks") {
        const current = await getState(env);
        if (principal.role === "controller" ? !localVideoOnly(payload) : !current.stream || !onlyActiveRemote(payload, current.stream)) return error("track operation is not permitted", 403);
        const result = await sfu(env, `/sessions/${encodeURIComponent(sessionId)}/tracks/new`, "POST", payload);
        if (result.ok && principal.role === "controller") {
          const copy = result.clone(); const parsed = await copy.json() as { tracks?: { trackName?: string; errorCode?: string }[] };
          const errorCode = (parsed as { errorCode?: unknown }).errorCode;
          if (!errorCode) for (const track of parsed.tracks || []) if (track.trackName && !track.errorCode) await doCall(env, "/published", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, trackName: track.trackName }) });
        }
        return result;
      }
      return sfu(env, `/sessions/${encodeURIComponent(sessionId)}/renegotiate`, "PUT", payload);
    }
    if (url.pathname === "/api/ice" && request.method === "GET") {
      if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return json({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] });
      // Cloudflare TURN credentials are supplied as secrets; clients receive only short-lived ICE credentials.
      let turn: Response; try { turn = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, { method: "POST", headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 3600 }), signal: AbortSignal.timeout(10_000) }); } catch { return error("TURN service unavailable", 502); }
      // A rejected Worker-held TURN credential is a server misconfiguration, not the caller's own 401; never proxy the upstream status or body verbatim.
      if (!turn.ok) return error("Worker TURN credentials were rejected upstream", 502);
      let payload: { iceServers?: unknown } | null; try { payload = await turn.json(); } catch { return error("TURN service returned an invalid response", 502); }
      const iceServers = payload?.iceServers;
      // Cloudflare returns one { urls, username, credential } object, not an array; always hand the client an array.
      return json({ iceServers: Array.isArray(iceServers) ? iceServers : iceServers && typeof iceServers === "object" ? [iceServers] : [] });
    }
    return error("not found", 404);
  }
} satisfies ExportedHandler<Env>;

export class ClassroomState implements DurableObject {
  constructor(private state: DurableObjectState) {}
  private sockets(): WebSocket[] { return this.state.getWebSockets?.() || []; }
  private attachment(socket: WebSocket): SocketAttachment | null {
    try {
      const value = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (!value || (value.role !== "controller" && value.role !== "agent") || typeof value.connectionId !== "string" || typeof value.lastSeen !== "number") return null;
      if (value.role === "agent" && typeof value.deviceId !== "string") return null;
      // An attachment serialized before mediaReady existed must keep its live socket across a deploy, not be dropped.
      return { ...value, mediaReady: value.mediaReady === true } as SocketAttachment;
    } catch { return null; }
  }
  private roster(): ClassroomSnapshot["students"] {
    return this.sockets().map((socket) => this.attachment(socket)).filter((a): a is SocketAttachment => !!a && a.role === "agent" && !!a.deviceId)
      .map((a) => ({ deviceId: a.deviceId!, lastSeen: a.lastSeen, mediaReady: a.mediaReady })).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }
  private async storedSnapshot(): Promise<ClassroomSnapshot> {
    const saved = await this.state.storage.get<ClassroomSnapshot>("snapshot");
    return saved ? { ...saved, students: [] } : { revision: 0, mode: "practice", leaseMs: 0, stream: null, students: [] };
  }
  private async releaseExpired(now = Date.now()): Promise<{ snapshot: ClassroomSnapshot; changed: boolean }> {
    const snapshot = await this.storedSnapshot();
    const leaseUntil = await this.state.storage.get<number>("leaseUntil") || 0;
    const expired = expireLease(snapshot, leaseUntil, now);
    if (expired !== snapshot) {
      await this.state.storage.put("snapshot", { ...expired, leaseMs: 0, students: [] });
      return { snapshot: expired, changed: true };
    }
    return { snapshot, changed: false };
  }
  private async snapshot(now = Date.now()): Promise<ClassroomSnapshot> {
    const { snapshot, changed } = await this.releaseExpired(now);
    const leaseUntil = await this.state.storage.get<number>("leaseUntil") || 0;
    const result = { ...snapshot, leaseMs: snapshot.mode === "practice" ? 0 : Math.max(0, leaseUntil - now), students: this.roster() };
    if (changed) for (const socket of this.sockets()) this.send(socket, result);
    return result;
  }
  private send(socket: WebSocket, snapshot: ClassroomSnapshot): void {
    const principal = this.attachment(socket);
    if (!principal) return;
    try { socket.send(JSON.stringify({ type: "state", state: redact(snapshot, principal) })); } catch { /* closing socket */ }
  }
  private async fanout(): Promise<void> {
    const snapshot = await this.snapshot();
    for (const socket of this.sockets()) this.send(socket, snapshot);
  }
  /**
   * Fire-and-forget shutdown fanout to the Agent sockets connected at this instant.
   *
   * The command is deliberately stored nowhere — not in the snapshot, not in Durable Object storage,
   * not in a socket attachment — so an Agent that connects after it was issued never learns of it and
   * never quits. It also never touches mode, revision, leaseMs, stream, or the controller lease:
   * shutting an app down is orthogonal to the fail-safe state machine. A controller socket is never
   * a target, and the instructor cannot start a student app again remotely afterwards.
   */
  private quitAgents(): number {
    const frame = JSON.stringify({ type: "quit" });
    let notified = 0;
    for (const socket of this.sockets()) {
      if (this.attachment(socket)?.role !== "agent") continue;
      try { socket.send(frame); notified += 1; } catch { /* closing socket */ }
    }
    return notified;
  }
  private async releaseController(connectionId?: string): Promise<void> {
    if (connectionId && await this.state.storage.get<string>("activeControllerConnectionId") !== connectionId) return;
    const current = await this.storedSnapshot();
    if (current.mode === "practice") return;
    const released = { ...current, revision: current.revision + 1, mode: "practice" as const, leaseMs: 0, stream: null, students: [] };
    await this.state.storage.put("snapshot", released);
    await this.state.storage.put("leaseUntil", 0);
    await this.fanout();
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("websocket upgrade required", 426);
      const role = request.headers.get("X-ClassRelay-Role");
      const deviceId = request.headers.get("X-ClassRelay-Device-Id") || undefined;
      if (role !== "controller" && role !== "agent") return error("invalid websocket principal", 403);
      if (role === "agent" && !deviceId) return error("agent device id required", 403);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      const attachment: SocketAttachment = { role, ...(deviceId ? { deviceId } : {}), connectionId: crypto.randomUUID(), lastSeen: Date.now(), mediaReady: false };
      if (role === "controller") {
        // A reconnect starts a fresh control epoch. Never carry a previous lock or stream into it.
        await this.releaseController();
        await this.state.storage.put("activeControllerConnectionId", attachment.connectionId);
        for (const socket of this.sockets()) if (this.attachment(socket)?.role === "controller") {
          try { socket.close(1012, "superseded by a newer controller connection"); } catch { /* already closing */ }
        }
      } else {
        for (const socket of this.sockets()) if (this.attachment(socket)?.deviceId === deviceId) {
          try { socket.close(1012, "superseded by a newer device connection"); } catch { /* already closing */ }
        }
      }
      server.serializeAttachment(attachment);
      this.state.acceptWebSocket(server, [role, ...(deviceId ? [`device:${deviceId}`] : [])]);
      this.send(server, await this.snapshot());
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/state") return json(await this.snapshot());
    if (url.pathname.startsWith("/owner/")) { const owner = await this.state.storage.get<Principal>(`session:${decodeURIComponent(url.pathname.slice(7))}`); return owner ? json(owner) : error("unknown session", 404); }
    if (url.pathname.startsWith("/published/")) { const [, , sessionId, trackName] = url.pathname.split("/"); const exists = await this.state.storage.get<boolean>(`track:${decodeURIComponent(sessionId)}:${decodeURIComponent(trackName)}`); return exists ? json({ ok: true }) : error("unknown published track", 404); }
    if (url.pathname === "/published" && request.method === "POST") { const p = await body(request); if (!p || typeof p.sessionId !== "string" || typeof p.trackName !== "string") return error("invalid track"); await this.state.storage.put(`track:${p.sessionId}:${p.trackName}`, true); return json({ ok: true }); }
    if (url.pathname === "/session" && request.method === "POST") { const p = await body(request); if (!p || typeof p.sessionId !== "string" || (p.role !== "controller" && p.role !== "agent")) return error("invalid session"); await this.state.storage.put(`session:${p.sessionId}`, { role: p.role, deviceId: p.deviceId }); return json({ ok: true }); }
    if (url.pathname === "/heartbeat" && request.method === "POST") { const p = await body(request) as Principal | null; if (!p || (p.role !== "controller" && p.role !== "agent")) return error("invalid heartbeat"); await this.snapshot(); if (p.role === "controller") { const leaseUntil = Date.now() + LEASE_MS; await this.state.storage.put("leaseUntil", leaseUntil); await this.state.storage.setAlarm(leaseUntil); } return json({ ok: true }); }
    if (url.pathname === "/mode" && request.method === "POST") { const input = await body(request); const mode = input?.mode; if (!input || !isMode(mode)) return error("invalid mode"); const snapshot = await this.snapshot(); snapshot.mode = mode; snapshot.stream = requiresStream(mode) ? input.stream as Stream : null; snapshot.revision++; snapshot.students = []; const leaseUntil = Date.now() + LEASE_MS; await this.state.storage.put("snapshot", snapshot); await this.state.storage.put("leaseUntil", requiresStream(mode) ? leaseUntil : 0); if (requiresStream(mode)) await this.state.storage.setAlarm(leaseUntil); await this.fanout(); return json(await this.snapshot()); }
    if (url.pathname === "/agents/quit" && request.method === "POST") return json({ ok: true, notified: this.quitAgents() });
    return error("not found", 404);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(socket);
    if (!attachment) { socket.close(1008, "missing connection identity"); return; }
    const byteLength = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (byteLength > 1_024) { socket.close(1009, "message too large"); return; }
    let payload: unknown;
    try { payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { socket.close(1008, "invalid JSON"); return; }
    const frame = heartbeatFrame(payload, attachment.role);
    if (!frame) { socket.close(1008, "only heartbeat messages are accepted"); return; }
    // Presence metadata only: neither field touches mode, lease, or revision.
    const next: SocketAttachment = { ...attachment, lastSeen: Date.now(), mediaReady: frame.mediaReady ?? attachment.mediaReady };
    // Not every heartbeat is written back; persistsAttachment() states which ones must be and why.
    if (persistsAttachment(attachment, next)) socket.serializeAttachment(next);
    await this.snapshot();
    if (attachment.role === "controller") {
      const active = await this.state.storage.get<string>("activeControllerConnectionId");
      if (active !== attachment.connectionId) { socket.close(1008, "controller connection is no longer active"); return; }
      // Written on *every* controller heartbeat, deliberately. Skipping one would leave a stored deadline
      // that lags the last heartbeat, expiring a live lease early and eating the three-loss margin the
      // 5 s cadence buys against the 15 s lease. One device's lease writes are a rounding error; the
      // moment a lease expires is not something to trade for them.
      const leaseUntil = Date.now() + LEASE_MS;
      await this.state.storage.put("leaseUntil", leaseUntil);
      await this.state.storage.setAlarm(leaseUntil);
    }
    this.send(socket, await this.snapshot());
  }
  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = this.attachment(socket);
    if (attachment?.role === "controller") await this.releaseController(attachment.connectionId);
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = this.attachment(socket);
    if (attachment?.role === "controller") await this.releaseController(attachment.connectionId);
  }
  async alarm(): Promise<void> {
    // snapshot() broadcasts if this alarm is the first observer of lease expiry.
    await this.snapshot();
  }
}
