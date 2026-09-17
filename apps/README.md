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

## Input lock and fail-safe behavior

Input lock is an instructional focus aid, not a Windows security boundary. It cannot block Windows secure-attention sequences such as `Ctrl+Alt+Delete`, nor is it intended to resist a local administrator.

Press `Ctrl+Shift+F12` to release the classroom view immediately. An Agent also releases fullscreen and input suppression if backend state is unavailable for 15 seconds, its WebRTC connection fails, the associated process exits, or its lease expires. A released command revision is not restored by reconnection.

When `nativeInputLock` is enabled, `InputGuard.exe` blocks ordinary keyboard and mouse input only while the main process, renderer, and valid lock lease are all active. It has an independent watchdog and releases on failure or timeout.
