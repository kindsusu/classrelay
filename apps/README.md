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

While broadcasting, the Controller polls `RTCPeerConnection.getStats()` every two seconds and shows the measured outbound video line, for example `송출 1280×720 · 14fps · 1.8Mbps · 손실 0.1%`. Use these figures in place of estimated bit rates when sizing a class. The Agent polls inbound video every second and shows the received resolution, frame rate, and bit rate. Neither side logs SDP bodies, tokens, or credentials.

The Controller counts control connections and video reception separately (`연결 학생` and `영상 N`), both using the same 15-second `lastSeen` cutoff. An attached control socket does not prove that device is receiving video, so the connection count alone must not be read as 30 successful video streams.

## Input lock and fail-safe behavior

Input lock is an instructional focus aid, not a Windows security boundary. It cannot block Windows secure-attention sequences such as `Ctrl+Alt+Delete`, nor is it intended to resist a local administrator.

Press `Ctrl+Shift+F12` to release the classroom view immediately. An Agent also releases fullscreen and input suppression if backend state is unavailable for 15 seconds, its WebRTC connection fails, the associated process exits, or its lease expires. A released command revision is not restored by reconnection.

A frozen picture counts as a failure, not as a working lock. The Agent tracks decoded-frame freshness through `getStats()`; if `framesDecoded` — or `bytesReceived` where frame counts are unavailable — does not advance for three seconds while a non-practice mode is active, the Agent clears its media-ready flag, which stops the main process from renewing the native lock, and reports the failure. Three seconds is about 45 frames at 15 fps, so an ordinary retransmission or key-frame wait does not reach it, while the release still lands far inside the 15-second lease rather than leaving a student blocked in front of a dead screen. Reporting the failure latches the release for that revision; only a new instructor command with a newer revision can lock again.

A subscription that fails to establish is retried up to three times with a 1/3/6-second backoff, and only while the server's most recent state still carries a non-practice mode and a stream descriptor. The practice state that follows an emergency release cancels any pending retry, so restoring video never restores a released lock.

If a control-socket reconnect dropped an active broadcast, the Controller shows a persistent prompt to select a screen and broadcast again. It clears once a new broadcast or practice command succeeds.

When `nativeInputLock` is enabled, `InputGuard.exe` blocks ordinary keyboard and mouse input only while the main process, renderer, and valid lock lease are all active. It has an independent watchdog and releases on failure or timeout.
