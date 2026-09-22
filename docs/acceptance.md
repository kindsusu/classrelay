# ClassRelay Physical Device Acceptance Checklist

[한국어](acceptance.ko.md)

Automated tests do not replace validation of actual streaming, WebSocket recovery, and Windows input locking. Every check below defaults to **not run**. Perform them on company-owned training devices.

## Preconditions

Complete these before the first check that involves a locking mode.

1. **Brief the on-site staff for that room on `Ctrl+Shift+F12`.** No student screen displays this shortcut in any mode, by design, so nobody in the room will learn it from the software. This is a hard precondition, not a nicety.
2. **Enable `nativeInputLock` deliberately, per device.** Generated configurations set it to `false`, and with it off the locking modes show their overlay but suppress nothing — a lock test on such a device proves nothing. Record which devices have it enabled.
3. **Give each device its own token bound to its own `deviceId`.** One token copied across devices invalidates the authentication checks below.
4. **Know how to end the session from the instructor side**, and know that the student-app shutdown is one-way: nothing restarts a student app remotely.

## Checks

| Scale | Action | Pass criteria |
|---|---|---|
| 1 device | Instructor and student on different Wi-Fi networks | Student displays video after screen selection |
| 1 device | Confirm authenticated WebSocket | State arrives immediately after connection; no normal REST state polling |
| 1 device | 화면 보여주기 (`broadcast`) | Instructor screen fullscreen, taskbar covered; student input is still free and Alt+Tab works — this is intended |
| 1 device | 이론 모드 (`lecture`) | Instructor screen fullscreen and completely unobscured; input locked; no status text, statistics, or key hint anywhere on the student screen |
| 1 device | 강사 주목 (`lock`) | Video deliberately obscured; input locked; the shield tells the student to look at the instructor and names no key combination |
| 1 device | Healthy screen stays silent | In `broadcast`, `lecture`, and `lock` with nothing broken, the student sees only the video — no overlay, no measured statistics |
| 1 device | Any locking mode → 실습 (`practice`) | Input recovers; no residual window, kiosk, or key suppression |
| 1 device | Switch the shared screen while broadcasting | Students keep watching without interruption; the green `송출 중` badge moves to the new screen; no mode change and no lock armed or released |
| 1 device | Failed switch (cancel the capture prompt) | The previous screen keeps broadcasting; the instructor sees the failure on the message line |
| 1 device | Freeze the instructor's video path while `lecture` or `lock` is active | Input releases within a few seconds; the student sees the frozen-video release line; the mode stays released until a newer instructor command |
| 1 device | Disable student Wi-Fi | Releases within roughly 15 seconds of the last valid control state |
| 1 device | Force-close the instructor app | Student releases after the Controller lease expires |
| 1 device | Stop the student renderer | Native watchdog remains active and releases the lock |
| 1 device | Emergency shortcut in each locking mode | Releases immediately and does not re-lock on the same revision |
| 1 device | Reconnect after network loss | Fresh state is applied; an expired or emergency-released revision does not re-lock |
| 1 device | Wake a sleeping PC | Connects and fetches fresh pushed state without applying an earlier lock |
| 1 device | Sign out and sign in | Configured Agent starts automatically and connects |
| 1 device | 학생 앱 종료 | The student app releases the input guard and kiosk, then exits cleanly; the reported `notified` count matches the connected devices; **no `ClassRelay` process remains in Task Manager three seconds later** |
| 1 device | Run `run.bat` twice on one student device | Exactly one instance keeps running; the instructor's roster shows that device once and never flickers |
| 1 device | Run `run.bat` twice on the instructor device | The existing window comes to the front; no second instructor connection is made |
| 1 device | Cancel or ignore the screen-capture prompt for more than 10 seconds | The message line reports the capture timeout, the mode buttons are usable again, and no mode was sent |
| 1 device | Start a student app *after* the shutdown was issued | That device connects normally and does **not** quit; confirm the instructor has no way to restart the others remotely |
| Authentication | Invalid token, missing device ID, or another student's device ID | 401/403 and no control-state change |
| Authentication | Student attempts a mode change or a shutdown | 403 and no control-state change |
| Restricted network | UDP-restricted environment | Connection works after TURN is enabled; `/api/ice` returns usable servers |
| 3 devices | Mixed Wi-Fi and mobile hotspot | A device failure does not affect other students |
| 10 devices | Repeated broadcast / lecture / lock / practice cycling for one hour | Immediate command delivery and stable recovery without stream or process growth |
| 30 devices | Five-hour soak with repeated releases and reconnections | No residual locks; record Realtime, Workers, and Durable Objects usage |
| Capacity | Read the Controller's measured send line during a real class | Record actual resolution, frame rate, and bit rate; use them to replace the arithmetic capacity estimate |

## Order and reporting

Validate forced shutdown, network loss, and emergency release on one device before scaling to three, then ten, then thirty. A locking check performed on a device with `nativeInputLock: false` is a display check, not a lock check — record it as such.

Write real results into the [verification record](verification.md), keeping live-deployment measurements, real-hardware observations, and untested behavior in separate sections.
