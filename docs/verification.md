# ClassRelay Verification Record

[한국어](verification.ko.md)

## What "verified" means here

This record separates three different things that are easy to blur together:

- **Measured against the live deployment** — a real request was sent to the deployed Worker and the response was read.
- **Observed on real hardware** — a person watched it happen on physical training machines.
- **Not verified** — everything else, including behavior that automated tests cover. A green test suite proves the code does what the test says; it does not prove the product works.

Automated test results are reported separately at the end, because they belong to none of the three.

## Measured against the live deployment

Performed on 2026-09-18 against the deployed Worker on its dedicated subdomain, using real credentials. No account IDs, hostnames, or tokens are recorded here.

**Authentication, roles, and the control socket — 9 checks.**

| Check | Result |
|---|---|
| `GET /health` unauthenticated | 200 |
| Any `/api/*` route with no credentials | 401 |
| A bad bearer token | 401 |
| `GET /api/state` as instructor and as student | 200 both, with the student roster hidden from the student |
| A student attempting a mode change | 403 |
| An agent token with no device ID header | 401 |
| An agent token presented with another student's device ID | 401 |
| `GET /api/connect` without an upgrade header | 426 |
| `GET /api/connect` as instructor and as student, with upgrade | 101, and the first frame on each socket was a state frame |

**ICE and TURN — 12 checks.** Covering STUN, all three TURN transports (UDP, TCP, and TLS), the response always arriving as an array, credentials differing between two consecutive requests, and the permanent TURN key never appearing in any response body.

**TLS.** Validates on the dedicated subdomain.

**SFU negotiation order.** The offer goes up with session creation and the answer comes back in that same response: `POST /sessions/new` with `{sessionDescription: {type: "offer", sdp}}` returned `201` with an answer, and a body without `sessionDescription` was rejected with `400 decoding_error`. The published Cloudflare specification describes the opposite order and is stale; implementing it is why screen broadcast failed at the first call every time. The measured shape is encoded in the backend test fixtures. The request/response table is in [the protocol document](protocol.md).

**The `/tracks/new` half is not verified.** The probe that would have settled it used a synthetic SDP whose DTLS fingerprint and ICE candidates were unusable, so the SFU waited on a transport that never established and the Worker's own 10-second timeout returned a 502 — a client-side artifact, not an SFU rejection. Whether `/tracks/new` also requires or returns a `sessionDescription` remains unknown.

## Observed on real hardware

**Screen broadcast from one instructor machine to one student machine works.** One instructor, one student, one direction.

**2026-09-22, one instructor laptop and one student laptop, current build.** Three defects surfaced and were fixed in the app; none touched the Worker.

- **The student quit command left a process behind once.** The student stopped streaming but `ClassRelay` stayed in Task Manager. The same command issued directly to the Worker reported `notified: 1`, the socket left the roster within a second, and the process then exited — so the server-to-app path works and the stall was in Electron's graceful quit. A three-second forced exit now follows `app.quit()`.
- **The instructor app went dead.** Mode buttons did nothing and the message line read "server connection closed". A four-minute `wrangler tail` showed 76 events, all WebSocket heartbeats from two healthy sockets, and **zero HTTP requests** — no reconnect, no mode command, not even `/api/ice`. Restarting the instructor app cured it. The only path that never settles before the first HTTP call is `getDisplayMedia`, so the busy guard that disables the buttons was holding them forever. The capture call and every button action are now bounded (10 s and 30 s), and a stale offline message is cleared on reconnect. The exact hung call was not captured; the bound is what prevents a repeat.
- **Four `ClassRelay` processes per machine is normal** — one Electron instance is main, GPU, renderer and utility. What was missing was a single-instance lock, so a second `run.bat` could start a second process with the same device identity; the apps now take the lock.

**30 student tokens against the live Worker, 180 seconds** (synthetic sockets, not devices): all 30 connected in 2.1 s; the instructor's roster showed 30/30 in every one of 11 samples with no unexpected disconnects; the persisted `lastSeen` lagged at most 9.1 s against the 10 s design bound; `mediaReady` matched exactly; the roster emptied 284 ms after the sockets closed. A second connection with the same device ID closed the first with `1012 superseded`. A `lecture` or `lock` request with a stream the Controller did not publish was refused with 403.

## Not verified

Stated plainly, because none of this has been exercised on a real device:

- **The Windows input lock has never engaged.** `nativeInputLock` is `false` on every device configuration, so no lock has ever actually run. Every locking check so far has been a display check.
- **The student-app shutdown has run on one real device only**, and the forced-exit fallback added afterwards has not yet been exercised on hardware.
- **Switching the shared screen has not been tried on real hardware.**
- **Real throughput is unknown.** The only figure observed so far — roughly 15 kbps at 1 fps — was a static slide. It says what an idle screen costs, not what a class costs, and it cannot be used for capacity planning. The capacity figures in the documentation remain arithmetic.
- **30 real devices, and the five-hour soak.** The 30-socket live soak above exercised the control plane only, not video, not input locking, and not thirty Wi-Fi networks.
- **Login auto-start.**
- **Whether the recent fix removed the reported student-screen flicker.** The change stopped the Agent from reapplying its window state on every five-second heartbeat, which is a plausible cause, but nobody has watched a student screen since.

Before operation, work through the [physical device acceptance checklist](acceptance.md).

## Automated tests and continuous integration

- Backend: 73 tests. Desktop apps: 143 tests. Backend type checking and the desktop syntax check pass.
- CI on the default branch is green. It runs the backend tests, the backend typecheck, the apps tests, the apps syntax check, a local 30-connection WebSocket smoke test, the native helper build, `InputGuard.exe --self-test`, and a Worker deployment dry-run.
- The native helper is exercised only with `--self-test`, which updates state without installing a live input hook. It has never suppressed real input.
- Backend SFU calls are mocked in tests. The mock now matches the measured live contract for session creation; the `/tracks/new` half of the mock is an assumption, and is marked as one in the test file. A mock that does not match reality lets a fully green suite hide a product that cannot work — that is exactly what happened with the session-creation order.

## Earlier local checks (historical)

Recorded in a Windows development environment on 2026-09-17, before the live deployment existed. Counts below are historical and have since increased.

- Local workerd integration (`node scripts/ws-smoke.mjs`) passed with one Controller and 30 simulated Agent WebSocket connections. Synthetic SFU ownership was seeded locally; no real video was sent.
- Verified lock/practice fanout, per-agent roster privacy, a silent Controller's 15-second lease expiry while Agents continued heartbeating, rejection of stale lock revival, and safe release on Controller replacement or disconnect.
- The final local practice fanout took roughly 10 ms. A development-machine observation, not an internet latency guarantee.
- Native helper rebuild and `--self-test` passed without enabling Windows input hooks.
- Portable packaging passed with `npm.cmd run dist --prefix apps -- --config.compression=store`. The packaged JavaScript sources matched the final source files. Compression was disabled for that local build; the executable is unsigned and was never launched against live input controls.
- During integration review, a defect that treated an individual SFU track error inside an HTTP 200 response as a successful registration was found and fixed, and covered by a regression test.
