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

These two frames are the only accepted client messages. A Controller that sends `mediaReady`, any extra or unknown key, or a non-boolean `mediaReady` is closed with 1008 `only heartbeat messages are accepted`. A frame larger than 1,024 bytes is closed with 1009 `message too large`.

A Controller heartbeat renews the 15-second server lease. An Agent heartbeat refreshes its presence. The socket's serialized Durable Object attachment contains `{ role, deviceId?, connectionId, lastSeen, mediaReady }`, never a bearer token or SFU secret. An attachment serialized before `mediaReady` existed is read as `false` rather than rejected, so a deploy does not drop live student connections. WebSocket hibernation preserves this attachment; a valid Controller lease continues until it expires, is replaced by a command, or a new Controller connection safely releases the active command before starting a new session. The applications do not poll REST state or heartbeat routes during normal operation.

## Student media readiness

Each roster entry reports `mediaReady` as a boolean. It is `false` from the moment a device connects until that device itself reports `true`, so the instructor can tell a control connection apart from actual video reception. A connection count alone never proves that 30 devices are receiving the screen.

`mediaReady` is a liveness and diagnostic signal about the student's own video reception only. It says whether that Agent currently has the instructor's video. It is not screen content, not a thumbnail, and not telemetry about the student's activity; nothing about the student's machine, files, or input is collected or transmitted. It is presence metadata and never influences `mode`, the Controller lease, or `revision`.

`mode` is one of `practice`, `broadcast`, or `lock`. `broadcast` and `lock` require a successful video track from a registered instructor session. In `practice`, `stream` is null.

`revision` increases on Controller command changes and server safety releases, never on heartbeat. A student's emergency release remains an unlocked state for the same revision. Reconnection, stale state, or a response after an expired lease must not re-lock a released command; wait for a new instructor command with a newer revision.

## REST and RTC routes

| Method and path | Role | Purpose |
|---|---|---|
| GET `/health` | Public | Service liveness check |
| GET `/api/connect` | Instructor and student | Upgrade to authenticated control WebSocket |
| GET `/api/state` | Instructor and student | Legacy compatibility and diagnostic state read |
| POST `/api/heartbeat` | Instructor and student | Legacy compatibility and diagnostic presence/lease update |
| POST `/api/mode` | Instructor | HTTPS action: change mode with `{mode, stream?}` |
| GET `/api/ice` | Instructor and student | STUN and optional short-lived TURN credentials |
| POST `/api/rtc/sessions` | Instructor and student | Create an SFU session; default body is `{}` |
| POST `/api/rtc/sessions/:id/tracks` | Session owner | Instructor publishes local video; student subscribes to active remote video |
| PUT `/api/rtc/sessions/:id/renegotiate` | Session owner | Forward `{sessionDescription: {type, sdp}}` |

The HTTPS mode and RTC endpoints remain the action API; the resulting state is pushed to connected clients over WebSocket. Video is not relayed in a WebSocket or HTTP response body. After SDP negotiation, it travels over WebRTC through Controller → Cloudflare SFU → Agent.

Do not rely only on an SFU HTTP success code. Treat errors in the complete response and each `tracks` `errorCode` as failures. A student's remote-track request must match the current state's `sessionId` and `trackName`.

`GET /api/ice` always returns `{ iceServers: [...] }` as an array — a single-object response from Cloudflare's TURN API is wrapped in one, never handed to the client as-is — so a client can pass the result straight into `RTCPeerConnection`. A rejected or misconfigured Worker-held TURN credential is a 502 server error, not a 401; a 401 from `/api/ice` always means the caller's own bearer token was rejected, never the Worker's TURN credentials.
