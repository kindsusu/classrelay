# ClassRelay Development

**English** | [한국어](AGENTS.ko.md)

- Keep repository documentation English-first with matching Korean versions. Use the user's language for conversation and concise English task titles by default.
- Use Astra for planning, integration, and review; delegate routine execution to Terra and complex Windows/RTC work to Sol when those models and tools are available. Never claim unavailable capabilities. Assign distinct file ownership and preserve others' changes.
- This PoC is for company-owned Windows training devices. Do not add remote control, student screen collection, file collection, or keystroke recording.
- Read `docs/architecture.md` and the relevant module README before changes.
- Preserve fail-safe behavior. Never restore an expired or emergency-released lock from the same revision. Keep the native helper's independent watchdog.
- Keep permanent SFU/TURN credentials in Worker secrets. Never commit or print actual device tokens or configuration files.
- Validate with `npm.cmd test --prefix backend`, `npm.cmd run typecheck --prefix backend`, `npm.cmd test --prefix apps`, and `npm.cmd run check --prefix apps`.
- For native changes, run `powershell.exe -NoProfile -File native-input/build.ps1` and `InputGuard.exe --self-test`. Do not inadvertently activate input suppression on the development host. Distinguish simulated tests from actual hardware validation.
- Build the native helper before `npm.cmd run dist --prefix apps`. Validate the Worker from `backend/` with `npx.cmd wrangler deploy --dry-run`.
- Report live deployment and hardware checks as unverified unless actually performed.
