# ClassRelay Windows 앱

[English](README.md)

ClassRelay는 강사용 Windows **Controller**와 학생 노트북용 Windows **Agent**를 제공합니다. 같은 Electron 앱이 로컬 설정의 역할에 따라 Controller 또는 Agent로 실행됩니다.

Controller는 강사가 선택한 화면을 Cloudflare Realtime SFU에 송출합니다. Agent는 인증된 원격 트랙을 구독하고 백엔드가 제공하는 교육실 모드를 따릅니다. 이 PoC는 회사 소유 교육 장비를 대상으로 하며, 원격 조작, 학생 화면 수집, 파일 수집, 키 입력 기록 기능을 포함하지 않습니다.

두 역할 모두 `/api/connect`에 인증된 WebSocket 연결 하나를 유지합니다. 백엔드는 최초 교육실 상태와 이후 변경을 밀어 보내고, 클라이언트는 HTTP로 상태를 반복 조회하는 대신 5초마다 작은 heartbeat를 보냅니다. 15초 동안 상태 응답이 없으면 연결을 폐기하고 제한된 지수 백오프로 재연결합니다. 자격증명은 Electron 메인 프로세스에만 두고 요청 헤더로 전송하며, 렌더러 코드나 URL에 넣지 않습니다.

## 요구 사항

- 패키지 앱 실행용 Windows 10 이상
- 로컬 개발용 Node.js 22 이상
- 배포된 ClassRelay 백엔드와 Controller 또는 Agent별 고유 자격증명
- 패키징 전에 빌드해야 하는 `../native-input/dist/InputGuard.exe` (입력 억제 설정과 관계없이 패키지에 포함)

## 로컬 개발

의존성을 설치하고 Controller 설정을 만듭니다.

```powershell
npm install
Copy-Item -LiteralPath .\config.controller.example.json -Destination .\config.controller.json
# config.controller.json의 backendUrl, token, deviceId를 수정
npm run start:controller
```

로컬 Agent 확인은 `config.agent.example.json`을 `config.agent.json`으로 복사하고 해당 장비의 자격증명을 넣은 후 실행합니다.

```powershell
npm run start:agent
```

각 Agent는 자체 `deviceId`에 묶인 고유 토큰을 사용해야 합니다. 실제 설정 파일과 토큰은 커밋하지 마세요.

개발 중 다른 설정 파일을 쓰려면 `CLASSROOM_CONFIG`에 절대 경로를 지정합니다.

```powershell
$env:CLASSROOM_CONFIG = 'C:\ClassRelay\config.json'
npm start
```

## 빌드와 검증

```powershell
npm test
npm run check
npm run dist
```

`npm run dist`는 portable Windows 파일 `ClassRelay 0.1.0.exe`를 생성합니다. `npm run dist:installer`는 NSIS 설치 프로그램을 생성합니다. 어느 형식이든 패키징 전에 네이티브 입력 도우미를 빌드해야 합니다.

## 설정 및 자동 실행

패키지 앱의 활성 설정은 `%APPDATA%\ClassRelay\config.json`에 저장됩니다. 자동 실행을 켤 때에도 이 위치를 사용합니다. 기존 `%APPDATA%\Classroom Cloudflare` 경로는 브랜드 변경 후 앱 데이터 위치가 아닙니다.

로컬 설정의 `autoLaunch: true` 또는 앱 UI에서 자동 실행을 켜면 현재 Windows 사용자의 로그인 시작 항목에 등록됩니다. ClassRelay는 Windows 서비스가 아닌 사용자 세션 앱이므로, 관리된 각 장비에서 실제 교육 계정으로 동작을 확인해야 합니다.

향후 패키지의 제품명은 **ClassRelay**입니다. 이 PoC에서는 기존 한글 앱 UI 문구를 유지하며, 저장소 문서는 영어를 기본으로 하고 이 한글 번역을 함께 제공합니다.

## 송출 품질 상한

선택 항목인 `video` 블록은 Controller가 내보내는 화질을 제한해 5시간 수업이 무료 플랜 대역폭 예산 안에 들어오게 합니다. 시작할 때 읽고 검증하며, 생략하면 기본값을 사용합니다.

```json
{
  "video": { "maxHeight": 720, "maxFps": 15, "maxBitrateKbps": 2000 }
}
```

| 항목 | 기본값 | 허용 범위 | 효과 |
|---|---|---|---|
| `maxHeight` | `720` | 360–1440 | 캡처 높이 상한. `getDisplayMedia`에 전달하고 캡처된 트랙에 다시 적용 |
| `maxFps` | `15` | 5–30 | 프레임레이트 상한. 트랙과 인코더에 적용 |
| `maxBitrateKbps` | `2000` | 300–8000 | 인코더 `maxBitrate` 상한(kbit/s) |

각 항목은 정수이며 하나만 지정해도 됩니다. 나머지는 기본값으로 채웁니다. 범위를 벗어난 값, 정수가 아닌 값, 알 수 없는 항목이 있으면 상한 없이 조용히 송출하는 대신 설정 오류로 시작을 중단합니다. 이 블록은 Controller의 송출 스트림에만 영향을 줍니다. Agent도 값을 검증하지만 영상을 송출하지 않습니다.

공유 화면은 대개 슬라이드나 문서이므로 Controller는 가독성을 우선하도록 인코더에 힌트를 주고(`contentHint = "text"`), 해상도를 낮추기보다 프레임을 버리도록 설정합니다(`degradationPreference = "maintain-resolution"`). 실행 환경이 이 제어를 지원하지 않으면 Controller 메시지 줄에 알리고 송출은 계속합니다.

## 실측 영상 지표

송출 중 Controller는 2초마다 `RTCPeerConnection.getStats()`를 조회해 실제 송신 상태를 표시합니다. 예: `송출 1280×720 · 14fps · 1.8Mbps · 손실 0.1%`. 수업 규모를 계산할 때 추정 비트레이트 대신 이 실측값을 사용하세요. Agent는 1초마다 수신 영상을 조회해 해상도, 프레임레이트, 수신 비트레이트를 표시합니다. 양쪽 모두 SDP 본문, 토큰, 자격증명을 기록하지 않습니다.

Controller는 제어 연결 수와 영상 수신 수를 따로 셉니다(`연결 학생`, `영상 N`). 두 값 모두 동일한 15초 `lastSeen` 기준을 씁니다. 제어 소켓이 붙어 있다는 사실이 그 장비가 영상을 받고 있다는 증거는 아니므로, 연결 수만으로 30대 영상 성공을 판단하면 안 됩니다.

## 입력 잠금과 fail-safe

입력 잠금은 교육 집중을 위한 기능이지 Windows 보안 경계가 아닙니다. `Ctrl+Alt+Delete` 같은 Windows 보안 키 조합을 차단할 수 없으며, 로컬 관리자를 막는 용도도 아닙니다.

`Ctrl+Shift+F12`를 누르면 교육 화면을 즉시 해제합니다. Agent는 백엔드 상태를 15초 동안 받지 못하거나 WebRTC 연결에 실패하거나 관련 프로세스가 종료되거나 lease가 만료되면 전체화면과 입력 억제를 해제합니다. 해제된 명령 revision은 재연결되어도 복원하지 않습니다.

멈춘 화면은 정상 잠금이 아니라 장애로 취급합니다. Agent는 `getStats()`로 디코딩 프레임의 신선도를 추적하며, 비실습 모드가 활성인 동안 `framesDecoded`(프레임 수를 읽을 수 없으면 `bytesReceived`)가 3초 동안 늘지 않으면 media-ready 플래그를 내려 메인 프로세스가 네이티브 잠금을 갱신하지 못하게 하고 장애를 보고합니다. 3초는 15fps 기준 약 45프레임이라 일시적 재전송이나 키프레임 대기로는 도달하지 않으면서, 15초 lease보다 훨씬 앞서 해제되어 학생이 죽은 화면 앞에서 오래 막히지 않습니다. 장애 보고는 해당 revision의 해제를 latch하므로, 더 높은 revision의 새 강사 명령만이 다시 잠글 수 있습니다.

구독 수립에 실패하면 1초·3초·6초 간격으로 최대 3회까지 재시도합니다. 서버가 마지막으로 보낸 상태가 여전히 비실습 모드이고 스트림 정보를 담고 있을 때만 시도하며, 비상 해제 뒤 내려오는 실습 상태는 대기 중인 재시도를 취소합니다. 따라서 영상 복구가 해제된 잠금을 되살리는 일은 없습니다.

제어 소켓이 끊기면서 송출이 중단된 경우, 재연결 후 Controller에 화면을 다시 선택해 송출하라는 안내가 계속 표시됩니다. 새 송출이나 실습 명령이 성공하면 사라집니다.

`nativeInputLock`을 켜면 `InputGuard.exe`가 메인 프로세스, 렌더러, 유효한 lock lease가 모두 활성인 동안에만 일반 키보드·마우스 입력을 막습니다. 이 도구는 독립 watchdog을 사용하며 장애 또는 시간 초과 시 해제합니다.
