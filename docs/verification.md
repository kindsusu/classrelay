# ClassRelay Verification Record

[한국어](verification.ko.md)

Performed in a Windows development environment on 2026-09-17.

## WebSocket control update

The desktop clients now use authenticated WebSockets for state push and five-second heartbeats. REST mode and RTC operations remain action-based. No live Cloudflare resources or paid subscriptions were changed.

- Local workerd integration (`node scripts/ws-smoke.mjs`) passed with one Controller and 30 simulated Agent WebSocket connections. Synthetic SFU ownership was seeded locally; no real video was sent.
- Verified lock/practice fanout, per-agent roster privacy, a silent Controller's 15-second lease expiry while Agents continue heartbeating, rejection of stale lock revival, and safe release on Controller replacement/disconnect.
- The final local practice fanout took approximately 10 ms. This is a development-machine observation, not an internet latency guarantee.
- Native helper rebuild and `--self-test` passed without enabling Windows input hooks.
- Backend tests: 21 passed; desktop tests: 15 passed. Backend type checking, desktop syntax checks, and Worker deployment dry-run passed. Production desktop dependency audit reported zero vulnerabilities.
- Desktop regression checks cover stale response timeouts, reconnects, safe shutdown, renderer heartbeat gating, and a practice-state response racing with a new screen publication.
- Portable packaging passed with `npm.cmd run dist --prefix apps -- --config.compression=store`, producing `apps/dist/ClassRelay 0.1.0.exe` (386,354,745 bytes). Five packaged JavaScript sources match the final source files, and `ws` 8.21.3 is included. Compression was disabled for the local verification build; the executable is unsigned and was not launched against live input controls.
- Actual Cloudflare streaming, physical Windows input suppression, startup after sign-in, and a 30-device/five-hour soak remain unverified.

## Initial PoC checks (historical)

The checks below describe the initial PoC. During repository preparation, the product/package metadata and window title were changed to ClassRelay, bilingual documentation and the supplied banner were added, and all 21 tests passed again. The historical executable was not rebuilt with the new branding and is not included in this repository.

| Item | Result | Scope |
|---|---|---|
| Backend tests | 14 passed | Authentication, roles, simulated execution of live route/DO code, publish → subscribe → lease expiry, student isolation, failed-track rejection |
| TypeScript check | Passed | `npm run typecheck` |
| Cloudflare deployment preflight | Passed | `wrangler deploy --dry-run`; not an actual deployment |
| Local Worker run | Passed | `/health` 200; unauthenticated `/api/state` 401 |
| Token provisioning tool | Syntax check passed | No production tokens were generated or deployed |
| Windows input-guard helper | Compilation and self-test passed | State update, emergency release, earlier-command rejection, expiry; no live input hook was run |
| App safety tests | 7 passed | Lock/broadcast expiry, 15-second limit, delayed responses, persistent emergency release, new and prior commands |
| App JavaScript check | Passed | Syntax checks for main, preload, renderer, and safety code |
| Windows portable package | Passed | Produced `apps/dist/Classroom Cloudflare 0.1.0.exe`; unsigned PoC artifact retained under its historic filename |
| Package-content comparison | Matched at the initial check | Four JavaScript files in unpacked `app.asar` matched the sources at that time; bundled InputGuard matched that build |

Backend SFU calls were replaced by test responses. No actual Cloudflare account keys, domain, or training equipment were available, so production video streaming, TURN relay, live Windows input suppression, automatic start after sign-in, and a concurrent 30-device/eight-hour operating test were not performed.

During integration review, a defect that treated an individual SFU track error inside an HTTP 200 response as a successful registration was fixed and covered by a regression test. The native input guard is checked only with `--self-test`, which does not suppress live input.

Before operation, follow the [physical device acceptance checklist](acceptance.md).
