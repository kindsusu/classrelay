# ClassRelay PoC Protocol

[한국어](protocol.ko.md)

Production uses a single HTTPS origin. Every request includes `Authorization: Bearer <token>`; student requests also include `X-Device-Id`. Only the Worker holds SFU credentials. Never commit actual keys in examples.

| Method and path | Role | Purpose |
|---|---|---|
| GET `/health` | Public | Service liveness check |
| GET `/api/state` | Instructor and student | Read the current command and stream |
| POST `/api/heartbeat` | Instructor and student | Renew the instructor lease or record student `lastSeen` |
| POST `/api/mode` | Instructor | Change mode with `{mode, stream?}` |
| GET `/api/ice` | Instructor and student | STUN and optional short-lived TURN credentials |
| POST `/api/rtc/sessions` | Instructor and student | Create an SFU session; default body is `{}` |
| POST `/api/rtc/sessions/:id/tracks` | Session owner | Instructor publishes local video; student subscribes to active remote video |
| PUT `/api/rtc/sessions/:id/renegotiate` | Session owner | Forward `{sessionDescription: {type, sdp}}` |

Example state response:

```json
{
  "revision": 12,
  "mode": "lock",
  "leaseMs": 15000,
  "stream": { "sessionId": "publisher-session", "trackName": "screen-1" },
  "students": [{ "deviceId": "student-01", "lastSeen": 1700000000000 }]
}
```

`mode` is one of `practice`, `broadcast`, or `lock`. The `students` array is empty in a student response. `lastSeen` is a Unix timestamp in milliseconds and must be compared to the current time. Its presence in the array alone does not mean a device is currently connected.

`broadcast` and `lock` require a successful video track from a registered instructor session. A student session ID or failed track cannot change the mode. In `practice`, `stream` becomes null.

`revision` increases on command changes and server safety releases, never on heartbeat. A student's emergency release remains an unlocked state for the same revision. A UI or network recovery must not re-lock a released command; wait for a new instructor command.

Do not rely only on an SFU HTTP success code. Treat errors in the complete response and each `tracks` `errorCode` as failures. A student's remote-track request must match the current state's `sessionId` and `trackName`.

Video is not relayed in this API's response body. After SDP negotiation, it travels over WebRTC through Controller → Cloudflare SFU → Agent.
