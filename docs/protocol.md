# ClassRelay PoC Protocol

[한국어](protocol.ko.md)

Production uses one HTTPS origin. The Controller and each Agent authenticate with their own Bearer token; an Agent also supplies `X-Device-Id`. Only the Worker holds permanent SFU credentials. Never commit actual keys in examples.

## Control WebSocket

`GET /api/connect` upgrades to an authenticated WebSocket. Send the same authentication headers used by REST during the upgrade. The connection is accepted only after the Worker authenticates the role and, for an Agent, its device ID.

The Durable Object sends the current state on connection and after each command or server safety release:

```json
{
  "type": "state",
  "state": {
    "revision": 12,
    "mode": "lock",
    "leaseMs": 15000,
    "stream": { "sessionId": "publisher-session", "trackName": "screen-1" },
    "students": [{ "deviceId": "student-01", "lastSeen": 1700000000000, "mediaReady": true }]
  }
}
```

The `students` array is omitted or empty for an Agent. Both roles send this client message every five seconds while connected:

```json
{ "type": "heartbeat" }
```

An Agent may send the same frame carrying its own video reception state instead:

```json
{ "type": "heartbeat", "mediaReady": true }
```

These two frames are the only accepted client messages. A Controller that sends `mediaReady`, any extra or unknown key, or a non-boolean `mediaReady` is closed with 1008 `only heartbeat messages are accepted`. A frame larger than 1,024 bytes is closed with 1009 `message too large`. The server sends exactly two frame types, `state` and the `quit` command described below; neither has a client→server counterpart, and a client that sends `{"type":"quit"}` is closed like any other unknown frame.

A Controller heartbeat renews the 15-second server lease. An Agent heartbeat refreshes its presence. The socket's serialized Durable Object attachment contains `{ role, deviceId?, connectionId, lastSeen, mediaReady }`, never a bearer token or SFU secret. An attachment serialized before `mediaReady` existed is read as `false` rather than rejected, so a deploy does not drop live student connections.

**The attachment is not rewritten on every heartbeat.** `mediaReady` is persisted the instant it changes and only then, so the instructor's media count is never stale. `lastSeen` is persisted on the first heartbeat at or after 7.5 seconds since the stored value — every second heartbeat at the 5-second cadence — so a reported `lastSeen` may lag real time by up to about 10 seconds. The lag is deliberate and bounded: it stays a full heartbeat period inside the 15-second liveness cutoff the instructor applies to `lastSeen`, so a healthy student never flickers out of the connected count, and it halves the Durable Object attachment writes. Read `lastSeen` as "seen within the last 10 seconds", not as the exact time of the last heartbeat. Neither the heartbeat cadence nor the Controller lease renewal changed: the lease deadline is still written on every Controller heartbeat, because a stored deadline that lagged the last heartbeat would expire a live lease early.

WebSocket hibernation preserves this attachment; a valid Controller lease continues until it expires, is replaced by a command, or a new Controller connection safely releases the active command before starting a new session. The applications do not poll REST state or heartbeat routes during normal operation.

## Student media readiness

Each roster entry reports `mediaReady` as a boolean. It is `false` from the moment a device connects until that device itself reports `true`, so the instructor can tell a control connection apart from actual video reception. A connection count alone never proves that 30 devices are receiving the screen.

`mediaReady` is a liveness and diagnostic signal about the student's own video reception only. It says whether that Agent currently has the instructor's video. It is not screen content, not a thumbnail, and not telemetry about the student's activity; nothing about the student's machine, files, or input is collected or transmitted. It is presence metadata and never influences `mode`, the Controller lease, or `revision`.

## Class modes

`mode` is one of four wire names. Only two properties distinguish them: whether the instructor's screen is visible on the student device, and whether student input is locked.

| `mode` | Instructor screen visible | Student input locked | `stream` | Purpose |
|---|---|---|---|---|
| `practice` | No | No | null | Students work freely. No video is published or subscribed. |
| `broadcast` | Yes | No | required | Students watch the instructor's screen and keep working on their own machine. |
| `lecture` | Yes | Yes | required | Watch-only. Students see the instructor's screen and cannot type or click. |
| `lock` | No — deliberately obscured | Yes | required | Input locked and the screen hidden, so students look at the instructor in the room instead of the display. |

`lecture` and `lock` are the input-locking modes; the backend expresses this as the single predicate `locksInput(mode)` rather than comparing mode names. `broadcast`, `lecture`, and `lock` each require a successful video track from a registered instructor session. `practice` is the only mode with a null `stream`, and it is the fail-safe default every release falls back to.

Every non-`practice` mode holds the 15-second Controller lease and is released to `practice` the same way: lease expiry, the Durable Object alarm, an emergency release, a Controller disconnect, or a new Controller connection. `lecture` inherits all of it with no exception — a `lecture` that outlives its lease becomes `practice` with a higher revision and a cleared stream, exactly as a `lock` does.

`revision` increases on Controller command changes and server safety releases, never on heartbeat. A student's emergency release remains an unlocked state for the same revision. Reconnection, stale state, or a response after an expired lease must not re-lock a released command; wait for a new instructor command with a newer revision.

## Agent shutdown command

`POST /api/agents/quit` with an empty JSON body (`{}`) is Controller-only. The Durable Object sends this frame to every connected **Agent** socket and to no Controller socket:

```json
{ "type": "quit" }
```

An Agent that receives exactly this frame shuts its own app down. A frame carrying any extra key is not a quit frame and is ignored, so a future server field can never be mistaken for a shutdown order. The response reports how many Agent sockets were messaged:

```json
{ "ok": true, "notified": 30 }
```

A student token on this route is rejected with 403 `controller role required`. A body with any key is rejected with 400, so the route can never grow an implicit parameter.

**The command is transient and is stored nowhere** — not in the snapshot, not in Durable Object storage, not in a socket attachment. It is a fire-and-forget fanout over the Agent sockets connected at that instant. A student app that connects *after* the command was issued does not receive it and does not quit. `notified` therefore counts live sockets at that moment and nothing else; a later call over a different set of sockets reports a different number.

Quitting is not a class mode and never touches `mode`, `revision`, `leaseMs`, `stream`, or the Controller lease. It is orthogonal to the fail-safe state machine, and `{"mode": "quit"}` on `/api/mode` is rejected with 400 `invalid mode`.

**The instructor cannot start a student app again remotely.** There is no counterpart to this command: nothing in ClassRelay launches, restarts, or wakes a student application, and nothing on the student machine waits for a start order. Once a student app has quit, someone at that device has to start it again — or it starts on the next Windows sign-in, by the organization's own auto-start configuration. Use this to end a session, not as a temporary measure during one.

## REST and RTC routes

| Method and path | Role | Purpose |
|---|---|---|
| GET `/health` | Public | Service liveness check |
| GET `/api/connect` | Instructor and student | Upgrade to authenticated control WebSocket |
| GET `/api/state` | Instructor and student | Legacy compatibility and diagnostic state read |
| POST `/api/heartbeat` | Instructor and student | Legacy compatibility and diagnostic presence/lease update |
| POST `/api/mode` | Instructor | HTTPS action: change mode with `{mode, stream?}` |
| POST `/api/agents/quit` | Instructor | HTTPS action: empty `{}` body; asks every connected student app to quit and returns `{ok, notified}` |
| GET `/api/ice` | Instructor and student | STUN and optional short-lived TURN credentials |
| POST `/api/rtc/sessions` | Instructor and student | Create an SFU session; the body must carry `{sessionDescription: {type: "offer", sdp}}` and the response returns the answer |
| POST `/api/rtc/sessions/:id/tracks` | Session owner | Instructor publishes local video; student subscribes to active remote video |
| PUT `/api/rtc/sessions/:id/renegotiate` | Session owner | Forward `{sessionDescription: {type, sdp}}` |

The HTTPS mode and RTC endpoints remain the action API; the resulting state is pushed to connected clients over WebSocket. Video is not relayed in a WebSocket or HTTP response body. After SDP negotiation, it travels over WebRTC through Controller → Cloudflare SFU → Agent.

## RTC negotiation order

Both roles offer at session creation. The Controller adds a `sendonly` video transceiver for the captured display; the Agent adds a `recvonly` video transceiver so it has something to offer. Each then creates the offer, sets it locally, waits for ICE gathering, and sends it as the session-creation body:

1. `POST /api/rtc/sessions` with `{sessionDescription: {type: "offer", sdp}}` → `201 {sessionId, sessionDescription: {type: "answer", sdp}}`. Apply that answer with `setRemoteDescription`.
2. `POST /api/rtc/sessions/:id/tracks` with `{tracks: [...]}` only. The offer was already delivered and answered in step 1.
3. If a track response carries a further `sessionDescription`, it is not ignored. An `answer` is applied only while the local offer is still pending, and an `offer` is answered through `PUT /api/rtc/sessions/:id/renegotiate`. If neither step 1 nor step 3 produced a remote description, the client fails the attempt in Korean rather than waiting on a transport that can never establish.

This order was established by measuring the live deployed Worker against the live Cloudflare SFU on 2026-09-18 with a real controller token:

| Session-creation body | Live result |
|---|---|
| `{}` | `400 {"errorCode":"decoding_error","errorDescription":"Body JSON validation error: sessionDescription"}` |
| `{sessionDescription: {type: "offer", sdp}}` | `201 {sessionId, sessionDescription}` with `sessionDescription.type === "answer"` |

**The published Cloudflare specification disagrees and is stale.** `realtime-api-2024-05-21.yaml` and the Cloudflare lifecycle documentation describe a body-less `/sessions/new` with the offer sent later to `/tracks/new`. That is what this PoC originally implemented, which is why screen broadcast failed at the first call every time with a bare `서버 오류 400`. Trust the measurements above over the published spec, and re-measure before changing this order.

**The `/tracks/new` contract is not verified against a real peer.** The probe that would have settled it used a synthetic SDP with an unusable DTLS fingerprint and ICE candidates, so the SFU waited on a transport that never established and the Worker's own 10-second upstream timeout returned `502 {"error":"Realtime service unavailable"}` — a client-side artifact, not an SFU rejection. Whether `/tracks/new` also requires or returns a `sessionDescription` is therefore unknown; the client sends the minimal `{tracks: [...]}` request and tolerates a response with or without one. A real two-machine broadcast run is what will settle it.

An SFU error body uses `errorCode` and `errorDescription`, not the Worker's own `error` field, and the Worker forwards an upstream RTC failure status and body unchanged. A client that reads only `error` discards the actual reason, so clients must surface `errorCode` and `errorDescription` — bounded in length, never carrying SDP or credential-shaped strings into a message or log.

Do not rely only on an SFU HTTP success code. Treat errors in the complete response and each `tracks` `errorCode` as failures. A student's remote-track request must match the current state's `sessionId` and `trackName`.

`GET /api/ice` always returns `{ iceServers: [...] }` as an array — a single-object response from Cloudflare's TURN API is wrapped in one, never handed to the client as-is — so a client can pass the result straight into `RTCPeerConnection`. A rejected or misconfigured Worker-held TURN credential is a 502 server error, not a 401; a 401 from `/api/ice` always means the caller's own bearer token was rejected, never the Worker's TURN credentials.
