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
    if (url.pathname === "/api/state" && request.method === "GET") {
      const state = await getState(env);
      return json(principal.role === "controller" ? state : { ...state, students: [] });
    }
    if (url.pathname === "/api/heartbeat" && request.method === "POST") {
      await doCall(env, "/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(principal) });
      const current = await getState(env);
      return json(principal.role === "controller" ? current : { ...current, students: [] });
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
  constructor(private state: DurableObjectState) {
    this.state.blockConcurrencyWhile(async () => { const saved = await this.state.storage.get<ClassroomSnapshot>("snapshot"); if (saved && saved.mode !== "practice") await this.state.storage.put("snapshot", { ...saved, revision: saved.revision + 1, mode: "practice", stream: null }); });
  }
  private async snapshot(): Promise<ClassroomSnapshot> {
    const saved = await this.state.storage.get<ClassroomSnapshot>("snapshot");
    const snapshot = saved || { revision: 0, mode: "practice", leaseMs: LEASE_MS, stream: null, students: [] };
    const leaseUntil = await this.state.storage.get<number>("leaseUntil") || 0;
    const expired = expireLease(snapshot, leaseUntil);
    if (expired !== snapshot) { await this.state.storage.put("snapshot", expired); }
    return expired;
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/state") return json(await this.snapshot());
    if (url.pathname.startsWith("/owner/")) { const owner = await this.state.storage.get<Principal>(`session:${decodeURIComponent(url.pathname.slice(7))}`); return owner ? json(owner) : error("unknown session", 404); }
    if (url.pathname.startsWith("/published/")) { const [, , sessionId, trackName] = url.pathname.split("/"); const exists = await this.state.storage.get<boolean>(`track:${decodeURIComponent(sessionId)}:${decodeURIComponent(trackName)}`); return exists ? json({ ok: true }) : error("unknown published track", 404); }
    if (url.pathname === "/published" && request.method === "POST") { const p = await body(request); if (!p || typeof p.sessionId !== "string" || typeof p.trackName !== "string") return error("invalid track"); await this.state.storage.put(`track:${p.sessionId}:${p.trackName}`, true); return json({ ok: true }); }
    if (url.pathname === "/session" && request.method === "POST") { const p = await body(request); if (!p || typeof p.sessionId !== "string" || (p.role !== "controller" && p.role !== "agent")) return error("invalid session"); await this.state.storage.put(`session:${p.sessionId}`, { role: p.role, deviceId: p.deviceId }); return json({ ok: true }); }
    if (url.pathname === "/heartbeat" && request.method === "POST") { const p = await body(request) as Principal | null; if (!p) return error("invalid heartbeat"); const snapshot = await this.snapshot(); if (p.role === "controller") await this.state.storage.put("leaseUntil", Date.now() + LEASE_MS); else if (p.deviceId) { const students = snapshot.students.filter((s) => s.deviceId !== p.deviceId); students.push({ deviceId: p.deviceId, lastSeen: Date.now() }); snapshot.students = students; await this.state.storage.put("snapshot", snapshot); } return json({ ok: true }); }
    if (url.pathname === "/mode" && request.method === "POST") { const input = await body(request); if (!input || (input.mode !== "practice" && input.mode !== "broadcast" && input.mode !== "lock")) return error("invalid mode"); const snapshot = await this.snapshot(); snapshot.mode = input.mode; snapshot.stream = input.mode === "practice" ? null : input.stream as Stream; snapshot.revision++; await this.state.storage.put("snapshot", snapshot); await this.state.storage.put("leaseUntil", Date.now() + LEASE_MS); return json(snapshot); }
    return error("not found", 404);
  }
}
