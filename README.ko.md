![ClassRelay](docs/assets/classrelay-banner.png)

# ClassRelay

[English](README.md) | **한국어**

회사 Windows 교육용 노트북 30대를 위한 화면 송출·수업 입력 잠금 PoC. 강사는 화면을 선택해 송출하고, 학생 앱은 전체화면으로 표시한다. 실습 모드에서 해제하며 연결 장애 시 자동 해제한다.

> 실계정 배포·실제 영상 송수신·30대 8시간 실증은 아직 수행하지 않았다. 계정 키와 도메인 설정 후 아래 절차로 검증한다. 입력 잠금은 교육용 사용자 세션 제어이며 Windows 보안 화면을 차단하지 않는다.

## 구조

```text
apps/                 Electron Windows Controller / Agent, 안전장치 및 테스트
native-input/         Windows 입력 억제 helper와 독립 15초 watchdog
backend/              Cloudflare Worker + Durable Object, SFU/TURN API 중계
scripts/provision.mjs 강사 및 학생별 임의 토큰/설정 생성
docs/architecture.ko.md  설계 결정과 보안 경계
docs/acceptance.ko.md    1→3→10→30대 현장 검증표
```

먼저 [아키텍처와 보안 경계](docs/architecture.ko.md)를 읽는다. 제어는 3초 폴링이므로 실습 전환 반영에는 다음 조회까지 지연이 있다. 강사 연결이 15초 이상 끊기면 서버가 실습으로 바꾸고, 학생 앱은 별도의 watchdog을 통해 망 단절 시 해제한다.

앱과 백엔드 사이의 요청 형식은 [통신 규격](docs/protocol.ko.md)에 정리했다.

## 준비

데스크톱 앱 화면은 현재 한국어이며, 저장소 문서는 영문과 한글로 제공한다. GitHub에는 소스·문서만 포함하며 실행 파일과 의존성은 제외한다.

- Windows 10/11 교육 계정, Node.js 24 LTS 및 npm
- Cloudflare 계정, Realtime SFU App ID/Token
- 제한된 네트워크에서 사용할 TURN Key ID/API Token(선택)
- Cloudflare DNS로 관리 중인 기존 도메인의 서브도메인

## 로컬 개발

PowerShell에서 프로젝트 폴더를 열고 각 패키지 의존성을 설치한다.

```powershell
npm.cmd ci --prefix backend
npm.cmd ci --prefix apps
Copy-Item -LiteralPath backend/.dev.vars.example -Destination backend/.dev.vars
node scripts/provision.mjs http://127.0.0.1:8787 30
```

`provisioned/`에 강사 1개·학생 30개의 설정과 `backend-secrets.local.json`이 생성된다. 비밀 값은 화면에 출력하지 않는다. 기존 파일이 있으면 덮어쓰기를 거부한다. 이 폴더를 Git에 추가하거나 학생 전체에게 배포하지 않는다. Windows 파일 ACL로 관리자와 해당 사용자에게만 읽기를 허용한다.

`backend/.dev.vars`의 `CONTROLLER_TOKEN`과 `AGENT_TOKENS_JSON`에 생성된 backend secrets 값을 넣는다. SFU 키도 채운다. 키가 없어도 인증·상태 제어 개발은 가능하지만 실제 화면 송출은 실패한다. 로컬 Worker는 SFU를 에뮬레이션하지 않는다.

```powershell
npm.cmd run dev --prefix backend
```

별도 터미널에서 강사용 앱을 실행한다.

```powershell
$env:CLASSROOM_CONFIG = (Resolve-Path -LiteralPath provisioned/controller.local.json).Path
npm.cmd start --prefix apps
```

학생 PC에는 `apps/`와 **해당 학생의 설정 하나만** 배포한다. 학생 PC에서 백엔드 주소는 배포된 HTTPS 주소여야 한다. `127.0.0.1` 설정은 같은 개발 PC에서만 사용할 수 있다.

```powershell
$env:CLASSROOM_CONFIG = (Resolve-Path -LiteralPath provisioned/student-01.local.json).Path
npm.cmd start --prefix apps
```

같은 PC에서 시험할 경우 학생 전체화면이 강사 창을 가릴 수 있으므로 비상 해제 키 `Ctrl+Shift+F12`를 먼저 확인한다. 실제 잠금 시험은 별도 교육 장비에서 수행한다.

## Cloudflare 배포

1. Cloudflare Realtime에서 SFU 앱을 만들고 ID/Token을 확보한다. 필요하면 TURN 키도 만든다.
2. `backend/wrangler.jsonc`의 이름 및 `CLASSROOM_ID`를 확인한다. 교육실별로 독립 배포·토큰을 사용한다.
3. 생성한 등록 토큰은 파일에서 업로드하고, SFU/TURN 비밀은 프롬프트에 입력한다. 명령 인수나 로그에 값을 붙이지 않는다.

```powershell
Set-Location backend
npx.cmd wrangler login
# 앞서 생성한 강사/학생 토큰 두 항목을 파일에서 업로드
npx.cmd wrangler secret bulk ../provisioned/backend-secrets.local.json
npx.cmd wrangler secret put SFU_APP_ID
npx.cmd wrangler secret put SFU_APP_TOKEN
# TURN을 쓸 때만 실행
npx.cmd wrangler secret put TURN_KEY_ID
npx.cmd wrangler secret put TURN_API_TOKEN
npm.cmd run deploy
```

4. Worker의 Settings → Domains & Routes에서 `classroom.example.com` 같은 **본인 도메인**을 Custom Domain으로 추가한다. DNS/TLS 활성화를 확인한다. 예시 도메인을 그대로 쓰지 않는다.
5. 모든 앱 설정의 `backendUrl`을 해당 HTTPS origin으로 변경한다. `/health` 응답을 확인하고 강사/학생 1대부터 연결한다.
6. 교육 종료 시 Agent 자동 실행을 해제하고 토큰을 폐기한다. 더 쓰지 않을 Worker·SFU 앱·TURN 키를 정리한다.

Worker 배포는 본 작업에서 실행하지 않았다. Cloudflare 계정·실제 서브도메인·비밀 키가 필요하다.

## Windows 배포

```powershell
powershell.exe -NoProfile -File native-input/build.ps1
npm.cmd run dist --prefix apps
# 설치형 빌드가 필요하면
npm.cmd run dist:installer --prefix apps
```

생성물은 `apps/dist/`에 생긴다. 설정 파일을 실행 파일에 포함하지 않는다. 설정 경로·자동 시작·입력 잠금의 구체적인 사용법은 [앱 안내](apps/README.ko.md)를 따른다. 코드 서명 인증서는 포함하지 않으며 조직의 배포 정책에 따라 서명한다.

Agent 자동 시작은 **Windows 로그인 후** 실행된다. 로그인 전 화면 제어용 Windows 서비스가 아니다. 관리자 권한, UAC 우회 또는 보안 주의 화면 차단에 의존하지 않는다.

실제 키보드·마우스 입력 억제는 [Windows helper](native-input/README.ko.md)를 빌드하고 학생 설정의 `nativeInputLock`을 `true`로 켜서 사용한다. 기본값 `false`에서는 전체화면 키오스크와 앱 안의 입력 차단막만 사용한다. helper는 별도 프로세스에서 15초 watchdog과 비상 해제를 유지한다. 운영체제의 보안 화면을 차단하지 않는다.

## 테스트

```powershell
npm.cmd test --prefix backend
npm.cmd run typecheck --prefix backend
npm.cmd test --prefix apps
npm.cmd run check --prefix apps
```

실제 수행 결과는 [검증 기록](docs/verification.ko.md)에 남긴다. 운영 전 [장비 검증표](docs/acceptance.ko.md)를 실행한다. 특히 Wi-Fi 단절, 강사 종료, 학생 프로세스 장애, 비상 해제를 1대에서 통과시킨 뒤 30대로 확장한다.

## 범위와 제한

- 단일 강사·단일 교실 PoC다. 계정 관리 화면, 자동 등록 서버, 다중 강사 충돌 조정은 포함하지 않는다.
- 화면 영상만 전달한다. 학생 화면 수집, 원격 마우스·키보드 조작, 파일 전송 기능은 없다.
- 단순 상태 폴링이므로 순간적 명령 전달을 보장하지 않는다. 필요하면 WebSocket push로 발전시킬 수 있다.
- 무료 사용 여부를 보장하지 않는다. SFU·TURN·Worker·Durable Objects 사용량 및 과금 알림을 계정에서 확인한다.
- 강사 재시작 후 과거 잠금으로 복구하지 않는다. 다시 화면을 선택해 송출한다.
