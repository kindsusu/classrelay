export type Role = "controller" | "agent";
export type Mode = "practice" | "broadcast" | "lock";
export interface Stream { sessionId: string; trackName: string }
export interface ClassroomSnapshot { revision: number; mode: Mode; leaseMs: number; stream: Stream | null; students: { deviceId: string; lastSeen: number }[] }

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
interface SocketAttachment extends Principal { connectionId: string; lastSeen: number }
const LEASE_MS = 15_000;
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
export function expireLease(snapshot: ClassroomSnapshot, leaseUntil: number, now = Date.now()): ClassroomSnapshot {
  if (snapshot.mode === "practice" || now < leaseUntil) return snapshot;
  return { ...snapshot, revision: snapshot.revision + 1, mode: "practice", stream: null };
}
export function ownsSession(owner: Principal | null, principal: Principal): boolean {
  return !!owner && owner.role === principal.role && owner.deviceId === principal.deviceId;
}
function json(data: unknown, status = 200): Response { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
function error(message: string, status = 400): Response { return json({ error: message }, status); }
async function body(request: Request): Promise<Record<string, unknown> | null> { try { const text = await request.text(); if (new TextEncoder().encode(text).byteLength > 100_000) return null; const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }
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
      if (mode !== "practice" && mode !== "broadcast" && mode !== "lock") return error("invalid mode");
      const stream = payload.stream;
      if ((mode === "broadcast" || mode === "lock") && !isStream(stream)) return error("broadcast and lock require a stream");
      if (stream && !isStream(stream)) return error("invalid stream");
      if (isStream(stream)) {
        const ownerResponse = await doCall(env, `/owner/${encodeURIComponent(stream.sessionId)}`);
        const owner = ownerResponse.ok ? await ownerResponse.json() as Principal : null;
        if (!ownsSession(owner, { role: "controller" })) return error("stream session is not owned by controller", 403);
        if (!(await doCall(env, `/published/${encodeURIComponent(stream.sessionId)}/${encodeURIComponent(stream.trackName)}`)).ok) return error("stream track was not published by controller", 403);
      }
      await doCall(env, "/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, stream: mode === "practice" ? null : stream }) });
      return json(await getState(env));
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
      return new Response(turn.body, { status: turn.status, headers: { "Content-Type": turn.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" } });
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
      return value as SocketAttachment;
    } catch { return null; }
  }
  private roster(): ClassroomSnapshot["students"] {
    return this.sockets().map((socket) => this.attachment(socket)).filter((a): a is SocketAttachment => !!a && a.role === "agent" && !!a.deviceId)
      .map((a) => ({ deviceId: a.deviceId!, lastSeen: a.lastSeen })).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
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
      const attachment: SocketAttachment = { role, ...(deviceId ? { deviceId } : {}), connectionId: crypto.randomUUID(), lastSeen: Date.now() };
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
    if (url.pathname === "/mode" && request.method === "POST") { const input = await body(request); if (!input || (input.mode !== "practice" && input.mode !== "broadcast" && input.mode !== "lock")) return error("invalid mode"); const snapshot = await this.snapshot(); snapshot.mode = input.mode; snapshot.stream = input.mode === "practice" ? null : input.stream as Stream; snapshot.revision++; snapshot.students = []; const leaseUntil = Date.now() + LEASE_MS; await this.state.storage.put("snapshot", snapshot); await this.state.storage.put("leaseUntil", input.mode === "practice" ? 0 : leaseUntil); if (input.mode !== "practice") await this.state.storage.setAlarm(leaseUntil); await this.fanout(); return json(await this.snapshot()); }
    return error("not found", 404);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(socket);
    if (!attachment) { socket.close(1008, "missing connection identity"); return; }
    const byteLength = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (byteLength > 1_024) { socket.close(1009, "message too large"); return; }
    let payload: unknown;
    try { payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { socket.close(1008, "invalid JSON"); return; }
    if (!payload || typeof payload !== "object" || (payload as { type?: unknown }).type !== "heartbeat" || Object.keys(payload).length !== 1) {
      socket.close(1008, "only heartbeat messages are accepted"); return;
    }
    attachment.lastSeen = Date.now();
    socket.serializeAttachment(attachment);
    await this.snapshot();
    if (attachment.role === "controller") {
      const active = await this.state.storage.get<string>("activeControllerConnectionId");
      if (active !== attachment.connectionId) { socket.close(1008, "controller connection is no longer active"); return; }
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
