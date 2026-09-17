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
    "students": [{ "deviceId": "student-01", "lastSeen": 1700000000000 }]
  }
}
```

The `students` array is omitted or empty for an Agent. Both roles send this client message every five seconds while connected:

```json
{ "type": "heartbeat" }
```

A Controller heartbeat renews the 15-second server lease. An Agent heartbeat refreshes its presence. The socket's serialized Durable Object attachment contains `{ role, deviceId?, connectionId, lastSeen }`, never a bearer token or SFU secret. WebSocket hibernation preserves this attachment; a valid Controller lease continues until it expires, is replaced by a command, or a new Controller connection safely releases the active command before starting a new session. The applications do not poll REST state or heartbeat routes during normal operation.

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
