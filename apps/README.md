# ClassRelay Windows Apps

[한국어](README.ko.md)

ClassRelay provides a Windows **Controller** for instructors and a Windows **Agent** for student laptops. The same Electron application runs in either role according to its local configuration.

The Controller publishes an instructor-selected display to Cloudflare Realtime SFU. The Agent subscribes to the authorized remote track and follows the classroom mode supplied by the backend. This PoC is designed for organization-owned training devices. It does not include remote control, student-screen collection, file collection, or keystroke logging.

Both roles keep one authenticated WebSocket connection to `/api/connect`. The backend pushes the initial classroom state and subsequent changes; clients send a small heartbeat every five seconds instead of repeatedly polling state over HTTP. A connection that receives no state response for 15 seconds is discarded and reconnected with bounded exponential backoff. Credentials stay in the Electron main process and are sent as request headers, never in renderer code or the URL.

## Requirements

- Windows 10 or later for the packaged application
- Node.js 22 or later for local development
- A deployed ClassRelay backend and unique controller or agent credentials
- The native input helper built at `../native-input/dist/InputGuard.exe` before packaging (bundled even when input suppression is disabled)

## Local development

Install dependencies and create a Controller configuration:

```powershell
npm install
Copy-Item -LiteralPath .\config.controller.example.json -Destination .\config.controller.json
# Update backendUrl, token, and deviceId in config.controller.json
npm run start:controller
```

For a local Agent check, copy `config.agent.example.json` to `config.agent.json`, supply that device's credentials, then run:

```powershell
npm run start:agent
```

Each Agent must have a distinct token bound to its own `deviceId`. Do not commit real configuration files or tokens.

Use `CLASSROOM_CONFIG` to point a development run to an absolute configuration-file path:

```powershell
$env:CLASSROOM_CONFIG = 'C:\ClassRelay\config.json'
npm start
```

## Build and validation

```powershell
npm test
npm run check
npm run dist
```

`npm run dist` produces the portable Windows artifact `ClassRelay 0.1.0.exe`. `npm run dist:installer` produces an NSIS installer. Build the native input helper before either packaging command.

## Configuration and automatic launch

The packaged application stores its active configuration at `%APPDATA%\ClassRelay\config.json`. This is also the destination used when automatic launch is enabled. The legacy `%APPDATA%\Classroom Cloudflare` location is no longer the branded application data location.

Set `autoLaunch: true` in a local configuration or enable the option from the app UI. ClassRelay then registers itself for the current Windows user's sign-in. This is a user-session application, not a Windows service; validate the behavior in the training account used on each managed device.

The product name in future packages is **ClassRelay**. Existing Korean app UI text is retained for this PoC; repository documentation is maintained in English with this Korean translation.

## Send-quality caps

The optional `video` block bounds what the Controller publishes so a five-hour class stays inside the free-tier bandwidth budget. It is read and validated at startup. Omit it to accept the defaults.

```json
{
  "video": { "maxHeight": 720, "maxFps": 15, "maxBitrateKbps": 2000 }
}
```

| Key | Default | Accepted range | Effect |
|---|---|---|---|
| `maxHeight` | `720` | 360–1440 | Capture height ceiling, applied to `getDisplayMedia` and re-applied to the captured track |
| `maxFps` | `15` | 5–30 | Frame-rate ceiling, applied to the track and to the encoder |
| `maxBitrateKbps` | `2000` | 300–8000 | Encoder `maxBitrate` ceiling in kbit/s |

Each key is an integer and may be supplied on its own; the rest fall back to the defaults. A value outside its range, a non-integer, or an unknown key aborts startup with a configuration error instead of silently broadcasting uncapped. The block only shapes the Controller's outgoing stream. An Agent validates it but publishes no video.

Because a shared screen is usually slides or text, the Controller hints the encoder toward legibility (`contentHint = "text"`) and prefers dropping frames over dropping resolution (`degradationPreference = "maintain-resolution"`). Where a runtime does not support one of these controls, the Controller reports it in the message line and keeps broadcasting rather than failing.

## Live media measurement

While broadcasting, the Controller polls `RTCPeerConnection.getStats()` every two seconds and shows the measured outbound video line, for example `송출 1280×720 · 14fps · 1.8Mbps · 손실 0.1%`. Use these figures in place of estimated bit rates when sizing a class. The Agent still polls inbound video every second, but that poll now only feeds frozen-video detection; the measured line is no longer drawn on the student screen. Neither side logs SDP bodies, tokens, or credentials.

The Controller counts control connections and video reception separately (`연결 학생` and `영상 N`), both using the same 15-second `lastSeen` cutoff. An attached control socket does not prove that device is receiving video, so the connection count alone must not be read as 30 successful video streams.

## Class modes

The instructor picks one of four modes. The wire value is what the backend stores; the Korean label is what both apps show.

| Wire | Korean label | Student screen | Student input |
|---|---|---|---|
| `practice` | 실습 | Agent window hidden | Free |
| `broadcast` | 화면 보여주기 | Instructor screen, fullscreen | Free |
| `lecture` | 이론 모드 | Instructor screen, fullscreen and unobscured | Locked |
| `lock` | 강사 주목 | Deliberately obscured | Locked |

Every non-practice mode puts the Agent window into kiosk fullscreen, so the Windows taskbar and all window chrome are gone and the student sees nothing but the instructor's screen, like PowerPoint presentation mode.

**Kiosk is not an input lock.** It hides chrome; it does not stop keystrokes. In `broadcast` the student's input is deliberately left free, so a determined student can still press Alt+Tab or Win+Tab and leave the classroom view. Only `lecture` and `lock` ask the native helper to suppress input, and only on a device where `nativeInputLock` is enabled. With that option off — which is the default — both locking modes show their overlay but suppress nothing.

`lecture` and `lock` differ only in what the student sees. `lecture` leaves the instructor's video completely unobstructed — no strip, no status text, no statistics. `lock` covers the video with the obscuring shield and tells the student to look at the instructor in the room. Neither overlay is what makes a lock safe: the overlay is presentation only, while the actual suppression and every release path live in the main process and the native helper.

Pressing 실습 시작 also minimises the instructor window, so the instructor can use their own PC immediately. The other three modes leave the window up, because the instructor still has to drive the class. The window is minimised and never hidden, so the taskbar always leads back to it.

## What the student screen shows

A healthy non-practice mode shows the instructor's video and nothing else. The student overlay is empty and hidden, so the screen reads as presentation mode rather than as an application window with a status bar. It speaks only when something is actually broken, because the student and the on-site staff then have to know what happened and what is about to happen.

| Condition | What the student sees |
|---|---|
| Control connection lost or reconnecting | the current locking mode, then `서버 재연결 중 · 15초 후 자동 해제` |
| Subscription retry | the current locking mode, then `영상 재연결 시도 N/3` |
| Subscription gave up | the current locking mode, then `영상 연결 실패 · 강사에게 알려주세요` |
| Frozen-video safe release | `강사 화면 신호가 3초 이상 멈춰 입력 차단을 해제했습니다.` |
| Emergency release, native-guard failure, or a quit request | the notice text sent by the main process |

The first three name the mode, so staff can see that input is still locked while the video is missing. The two release lines do not, because the lock is already gone by then and a `입력 차단 중` prefix would tell the student something untrue. A release line outranks the others and stays for the revision it was raised in; only an instructor command with a newer revision clears it, which is the same rule that keeps a released revision from being re-locked.

`#agent-empty` (`강사 화면을 기다리는 중`) is unchanged. It is the pre-stream placeholder, not a status overlay, and it still appears whenever no track is attached.

**`lecture` no longer prints the `Ctrl+Shift+F12` hint on screen.** The shortcut itself works in every mode and is registered globally by the main process; only the on-screen reminder is gone, because a permanent text overlay is what the instructor asked us to remove. The `lock` shield still prints it, since that shield deliberately covers the video and the text obstructs nothing. Brief the on-site staff on the shortcut before the session, as the rollout plan requires — a student locked in `lecture` cannot read it off their own screen.

## Switching the shared screen mid-class

Clicking a different screen while broadcasting swaps the outgoing video track in place with `RTCRtpSender.replaceTrack()`. There is no renegotiation, no new SFU session, and no mode command, so the class revision does not change: switching screens cannot arm a lock, cannot release one, and cannot resurrect a revision that was already released. The publication's identity — its SFU session, track name, and activation revision — is untouched, so the students keep watching the same subscription throughout.

The screen list marks two different things. A blue border is the screen the instructor has *selected*. A green border with the `송출 중` badge is the screen *actually going out right now*. They diverge while a switch is in flight and after a failed one, which is the point: the instructor can see whether the change landed instead of guessing. The four-button action grid is unchanged, and the Controller reports both success and failure on its message line.

A failed switch leaves the previous screen broadcasting. If the capture request is refused, if the selected window has no video track, or if `replaceTrack` throws, the newly captured stream is stopped and the sender keeps the old track — the publication is never left with a sender that has no track at all. A control-socket reconnect that lands during a switch cancels it and stops the new capture rather than reviving the stale publication.

The `ended` watcher that drops the class to practice when the instructor stops sharing from the OS share UI moves with the track. It is detached from the old track *before* that track is stopped and re-attached to the replacement first, so stopping the old capture during a switch is not mistaken for the instructor ending the share. Getting that order wrong would silently drop the whole class to practice on every screen change.

The `video` block's capture caps and the `contentHint = "text"` legibility hint are applied to the replacement track as well, so a switch cannot slip past the bandwidth budget. Encoder parameters live on the sender rather than the track and survive the swap.

## Shutting down the student apps

학생 앱 종료 asks every connected Agent to quit. It requires an in-app confirmation first, because one click stops every connected machine at once, and it reports the backend's `notified` count so the instructor sees how many devices were actually reached rather than assuming all of them were.

**This is not recoverable from the instructor side.** Once the student apps quit, the Controller cannot restart them remotely. Each student has to start the app again on their own PC, or sign in again where automatic launch is enabled.

An Agent that receives the quit request releases everything before it exits: the native input guard is sent `UNLOCK`, kiosk and always-on-top come off, and the app then quits through the same teardown path an ordinary exit uses. The exit is marked as an intentional stop, so it is not mistaken for a crash that would report an emergency release.

## Input lock and fail-safe behavior

Input lock is an instructional focus aid, not a Windows security boundary. It cannot block Windows secure-attention sequences such as `Ctrl+Alt+Delete`, nor is it intended to resist a local administrator.

Two of the four modes lock input, so one predicate decides it: `locksInput(mode)` in `src/safety.cjs`, true for `lecture` and `lock` and nothing else. The native-guard-unavailable check, the renderer-liveness check, and the 250 ms `LOCK` renewal all route through it, so `lecture` inherits every release path `lock` has — the per-revision emergency-release latch, the 15-second lease, `render-process-gone`, the renderer pulse gate, and frozen-video detection. No call site compares the mode string directly.

Press `Ctrl+Shift+F12` to release the classroom view immediately. An Agent also releases fullscreen and input suppression if backend state is unavailable for 15 seconds, its WebRTC connection fails, the associated process exits, or its lease expires. A released command revision is not restored by reconnection.

A frozen picture counts as a failure, not as a working lock. The Agent tracks decoded-frame freshness through `getStats()`; if `framesDecoded` — or `bytesReceived` where frame counts are unavailable — does not advance for three seconds while a non-practice mode is active, the Agent clears its media-ready flag, which stops the main process from renewing the native lock, and reports the failure. Three seconds is about 45 frames at 15 fps, so an ordinary retransmission or key-frame wait does not reach it, while the release still lands far inside the 15-second lease rather than leaving a student blocked in front of a dead screen. Reporting the failure latches the release for that revision; only a new instructor command with a newer revision can lock again.

A subscription that fails to establish is retried up to three times with a 1/3/6-second backoff, and only while the server's most recent state still carries a non-practice mode and a stream descriptor. The practice state that follows an emergency release cancels any pending retry, so restoring video never restores a released lock.

If a control-socket reconnect dropped an active broadcast, the Controller shows a persistent prompt to select a screen and broadcast again. It clears once a new broadcast or practice command succeeds.

When `nativeInputLock` is enabled, `InputGuard.exe` blocks ordinary keyboard and mouse input in `lecture` and `lock`, and only while the main process, renderer, and a valid lease are all active. It has an independent watchdog and releases on failure or timeout. The option stays opt-in per device and off by default; adding `lecture` did not change that.
