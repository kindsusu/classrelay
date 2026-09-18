# ClassRelay Development

**English** | [한국어](AGENTS.ko.md)

## Working agreements

- Keep repository documentation English-first with matching Korean versions. Use the user's language for conversation and concise English task titles by default.
- Use Astra for planning, integration, and review; delegate routine execution to Terra and complex Windows/RTC work to Sol when those models and tools are available. Never claim unavailable capabilities. Assign distinct file ownership and preserve others' changes.
- This PoC is for company-owned Windows training devices. Do not add remote control, student screen collection, file collection, or keystroke recording.
- Read `docs/architecture.md` and the relevant module README before changes.
- Keep permanent SFU/TURN credentials in Worker secrets. Never commit or print actual device tokens or configuration files. This repository is public: no account ID, deployment hostname, app ID, key ID, token, or email address belongs in it. Use `https://classroom.example.com` as the placeholder origin.

## Invariants, learned the hard way

These are not style preferences. Each one is a rule because breaking it already produced a defect.

- **Every locking decision goes through `locksInput()` and nothing else.** It lives in `backend/src/index.ts` and `apps/src/safety.cjs`. Never write `mode === 'lock'` at a call site. Two modes lock input; a direct comparison silently fails to lock one of them, or — worse — misses a release path and leaves a student with no way out.
- **Never print the emergency-release shortcut on a student screen, in any mode.** The risk is disclosure, not obstruction: any student who can read the key combination can use it to break out of the lock. Hiding it behind an obscuring shield does not make it safe. Because no student-facing screen will ever teach it, briefing the on-site staff is a hard precondition of enabling `nativeInputLock`, not a rollout nicety.
- **Preserve fail-safe behavior.** Never restore an expired or emergency-released lock from the same revision. Keep the native helper's independent watchdog. A frozen picture is a failure, not a working lock.
- **The student-app shutdown command stays transient and one-way.** It is stored nowhere, so a device connecting later never receives it, and it never touches mode, revision, lease, or stream. Do not add a counterpart that starts or restarts a student app remotely.
- **When an external API's documented contract and its live behaviour disagree, the measurement wins.** Encode the measured shape in the test fixtures and record the date and method of the measurement next to it. The SFU negotiation order in `docs/protocol.md` is the worked example: the published Cloudflare spec describes a body-less `/sessions/new`, the live API rejects it, and implementing the spec meant screen broadcast failed at the first call every time.
- **A mock that does not match reality lets a fully green suite hide a product that cannot work.** Before trusting a mocked upstream, check it against a real response. Say plainly in the test which parts of the contract are measured and which are still assumed — `/tracks/new` is still assumed.
- **Distinguish what was measured from what was reasoned.** Capacity arithmetic is arithmetic. A single observation of a static slide is not a throughput measurement. Report live deployment and hardware checks as unverified unless actually performed.

## Validation

- `npm.cmd test --prefix backend` (61), `npm.cmd run typecheck --prefix backend`, `npm.cmd test --prefix apps` (128), `npm.cmd run check --prefix apps`, `node scripts/ws-smoke.mjs`.
- For native changes, run `powershell.exe -NoProfile -File native-input/build.ps1` and `InputGuard.exe --self-test`. Do not inadvertently activate input suppression on the development host. Distinguish simulated tests from actual hardware validation.
- Build the native helper before `npm.cmd run dist --prefix apps`. Validate the Worker from `backend/` with `npx.cmd wrangler deploy --dry-run`.
- CI runs all of the above on every push and must stay green. Record real results in `docs/verification.md`, keeping live-deployment measurements, real-hardware observations, and untested behavior in separate sections.
