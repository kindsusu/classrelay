# ClassRelay Physical Device Acceptance Checklist

[한국어](acceptance.ko.md)

Automated tests do not replace validation of actual streaming and Windows input locking. The following checks must be completed before operation; their default status is not run.

| Scale | Action | Pass criteria |
|---|---|---|
| 1 device | Instructor and student on different Wi-Fi networks | Student displays video after screen selection |
| 1 device | Full-screen broadcast → practice | Full-screen display releases on the next successful state poll |
| 1 device | Input lock → practice | Input recovers; no residual window or key suppression |
| 1 device | Disable student Wi-Fi | Releases within roughly 15 seconds of the last valid control state |
| 1 device | Force-close the instructor app | Student releases after the instructor lease expires |
| 1 device | Stop the student renderer | Native watchdog remains active and releases the lock |
| 1 device | Emergency shortcut | Releases immediately and does not re-lock on the same revision |
| 1 device | Wake a sleeping PC | Fetches fresh state without applying an earlier lock |
| 1 device | Sign out and sign in | Configured Agent starts automatically and connects |
| Authentication | Invalid token or another student's session access | 401/403 and no control-state change |
| 3 devices | Mixed Wi-Fi and mobile hotspot | A device failure does not affect other students |
| 10 devices | Repeated broadcast/practice for one hour | Stable recovery without stream or process growth |
| 30 devices | Eight hours with repeated releases and reconnections | No residual locks; record resource usage |
| Restricted network | UDP-restricted environment | Connection works after TURN is enabled |

Perform these checks on company-owned training devices after showing the on-site operator how to use emergency release. Before deploying to 30 devices, validate forced shutdown and network loss on at least one device.
