import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

afterEach(() => vi.unstubAllGlobals());

function iceEnv(overrides: Partial<Env> = {}): Env {
  return { CONTROLLER_TOKEN: "test-controller", AGENT_TOKENS_JSON: "{}", ...overrides } as unknown as Env;
}
function requestIce(env: Env) {
  return worker.fetch(new Request("https://classroom.example/api/ice", { headers: { Authorization: "Bearer test-controller" } }), env);
}

describe("GET /api/ice", () => {
  it("returns a STUN-only array when TURN secrets are not configured", async () => {
    const response = await requestIce(iceEnv());
    expect(response.status).toBe(200);
    const payload = await response.json() as { iceServers: unknown };
    expect(Array.isArray(payload.iceServers)).toBe(true);
    expect(payload.iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });

  it("wraps Cloudflare's single-object TURN response in an array and preserves the issued credentials", async () => {
    const issued = {
      urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
      username: "issued-username",
      credential: "issued-credential"
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ iceServers: issued }), { status: 201, headers: { "Content-Type": "application/json" } })));
    const response = await requestIce(iceEnv({ TURN_KEY_ID: "key-id", TURN_API_TOKEN: "turn-token" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { iceServers: unknown[] };
    expect(Array.isArray(payload.iceServers)).toBe(true);
    expect(payload.iceServers).toEqual([issued]);
  });

  it("passes an already-array upstream response through unchanged", async () => {
    const issued = [{ urls: ["stun:stun.cloudflare.com:3478"] }, { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ iceServers: issued }), { status: 201 })));
    const response = await requestIce(iceEnv({ TURN_KEY_ID: "key-id", TURN_API_TOKEN: "turn-token" }));
    expect(await response.json()).toEqual({ iceServers: issued });
  });

  it("returns a distinct server error instead of proxying an upstream auth failure as the caller's own 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid bearer token" }), { status: 401, headers: { "Content-Type": "application/json" } })));
    const response = await requestIce(iceEnv({ TURN_KEY_ID: "wrong-key-id", TURN_API_TOKEN: "wrong-worker-token" }));
    expect(response.status).toBe(502);
    const payload = await response.json() as { error: string };
    expect(payload.error).not.toMatch(/invalid bearer token/i);
    expect(payload.error).not.toContain("wrong-worker-token");
    expect(payload.error).not.toContain("wrong-key-id");
  });

  it("returns 502 rather than crashing when the TURN endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const response = await requestIce(iceEnv({ TURN_KEY_ID: "key-id", TURN_API_TOKEN: "turn-token" }));
    expect(response.status).toBe(502);
  });
});
