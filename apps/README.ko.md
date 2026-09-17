# ClassRelay Windows 앱

[English](README.md)

ClassRelay는 강사용 Windows **Controller**와 학생 노트북용 Windows **Agent**를 제공합니다. 같은 Electron 앱이 로컬 설정의 역할에 따라 Controller 또는 Agent로 실행됩니다.

Controller는 강사가 선택한 화면을 Cloudflare Realtime SFU에 송출합니다. Agent는 인증된 원격 트랙을 구독하고 백엔드가 제공하는 교육실 모드를 따릅니다. 이 PoC는 회사 소유 교육 장비를 대상으로 하며, 원격 조작, 학생 화면 수집, 파일 수집, 키 입력 기록 기능을 포함하지 않습니다.

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

## 입력 잠금과 fail-safe

입력 잠금은 교육 집중을 위한 기능이지 Windows 보안 경계가 아닙니다. `Ctrl+Alt+Delete` 같은 Windows 보안 키 조합을 차단할 수 없으며, 로컬 관리자를 막는 용도도 아닙니다.

`Ctrl+Shift+F12`를 누르면 교육 화면을 즉시 해제합니다. Agent는 백엔드 상태를 15초 동안 받지 못하거나 WebRTC 연결에 실패하거나 관련 프로세스가 종료되거나 lease가 만료되면 전체화면과 입력 억제를 해제합니다. 해제된 명령 revision은 재연결되어도 복원하지 않습니다.

`nativeInputLock`을 켜면 `InputGuard.exe`가 메인 프로세스, 렌더러, 유효한 lock lease가 모두 활성인 동안에만 일반 키보드·마우스 입력을 막습니다. 이 도구는 독립 watchdog을 사용하며 장애 또는 시간 초과 시 해제합니다.
