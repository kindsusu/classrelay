# ClassRelay 개발 지침

[English](AGENTS.md) | **한국어**

## 작업 규칙

- 저장소 문서는 영문을 기본으로 하고 한글 버전을 함께 관리한다. 사용자에게는 한국어로 간결하게 결과를 먼저 설명하고, 작업 제목은 별도 요청이 없으면 영어로 쓴다.
- 설계·통합·검수는 Astra, 일반 구현은 Terra, 복잡한 Windows/RTC 구현은 Sol에 위임한다. 실제 제공되는 모델·기능만 사용한다. 같은 파일을 동시에 수정하지 않는다.
- 이 저장소는 회사 소유 Windows 교육 장비용 PoC다. 원격 조작, 학생 화면 수집, 파일 수집, 키 입력 기록 기능을 추가하지 않는다.
- 수정 전 `docs/architecture.md`와 담당 모듈의 README를 읽는다.
- SFU/TURN 영구 키는 Worker secrets에만 둔다. 실제 장비 토큰이나 설정 파일을 Git에 추가하거나 출력하지 않는다. 이 저장소는 공개다. 계정 ID, 배포 호스트명, app ID, key ID, 토큰, 이메일 주소를 넣지 않는다. 예시 origin은 `https://classroom.example.com`을 쓴다.

## 대가를 치르고 얻은 불변 규칙

취향이 아니다. 각 항목은 이미 실제 결함을 만들어 냈기 때문에 규칙이 되었다.

- **잠금 판정은 오직 `locksInput()`만 거친다.** 이 함수는 `backend/src/index.ts`와 `apps/src/safety.cjs`에 있다. 호출처에서 `mode === 'lock'`을 직접 비교하지 않는다. 잠그는 모드는 둘이므로, 직접 비교하면 한쪽이 조용히 잠기지 않거나 — 더 나쁘게 — 해제 경로를 놓쳐 학생이 빠져나올 수 없는 상태가 된다.
- **어떤 모드에서도 학생 화면에 비상 해제 단축키를 표시하지 않는다.** 위험은 가림이 아니라 노출이다. 키 조합을 읽을 수 있는 학생은 그것으로 잠금을 빠져나갈 수 있다. 가림막 뒤에 두어도 안전해지지 않는다. 학생 화면이 이를 절대 알려주지 않으므로, 현장 담당자 안내는 `nativeInputLock`을 켜기 위한 필수 전제이지 배포상의 배려가 아니다.
- **fail-safe를 약화하지 않는다.** 만료되었거나 비상 해제된 잠금을 같은 revision으로 복원하지 않는다. 네이티브 helper의 독립 watchdog을 보존한다. 멈춘 화면은 정상 잠금이 아니라 장애다.
- **학생 앱 종료 명령은 일회성·단방향으로 유지한다.** 어디에도 저장하지 않으므로 나중에 접속한 장비는 받지 못하며, mode·revision·lease·stream 어느 것도 건드리지 않는다. 학생 앱을 원격으로 켜거나 재시작하는 반대 명령을 추가하지 않는다.
- **외부 API의 문서와 실제 동작이 어긋나면 실측이 이긴다.** 실측한 형태를 테스트 fixture에 encode하고, 측정 일자와 방법을 그 옆에 남긴다. `docs/protocol.md`의 SFU 협상 순서가 실제 사례다. 공개된 Cloudflare 스펙은 body 없는 `/sessions/new`를 기술하지만 라이브 API는 이를 거절하며, 스펙대로 구현한 결과 화면 송출이 매번 첫 호출에서 실패했다.
- **현실과 다른 mock은 전부 통과한 테스트 뒤에 동작할 수 없는 제품을 숨긴다.** mock한 upstream을 믿기 전에 실제 응답과 대조한다. 계약 중 어디까지가 실측이고 어디부터가 가정인지 테스트에 분명히 적는다 — `/tracks/new`는 아직 가정이다.
- **실측한 것과 추론한 것을 구분한다.** 용량 계산은 계산일 뿐이다. 정지된 슬라이드 한 번의 관측은 대역폭 실측이 아니다. 실제로 수행하지 않은 실배포·실장비 검사는 미검증으로 보고한다.

## 검증

- `npm.cmd test --prefix backend`(73개), `npm.cmd run typecheck --prefix backend`, `npm.cmd test --prefix apps`(143개), `npm.cmd run check --prefix apps`, `node scripts/ws-smoke.mjs`.
- 네이티브 변경은 `powershell.exe -NoProfile -File native-input/build.ps1`과 `InputGuard.exe --self-test`로 확인한다. 개발 호스트의 입력을 무심코 잠그지 않는다. 모의 테스트와 실장비 검증 결과를 구분한다.
- 패키징은 native helper 빌드 후 `npm.cmd run dist --prefix apps`. Worker 사전 검증은 backend에서 `npx.cmd wrangler deploy --dry-run`.
- CI가 위 전부를 모든 push에서 돌리며 통과 상태를 유지해야 한다. 실제 결과는 `docs/verification.ko.md`에 남기되 실배포 실측·실장비 관측·미검증 항목을 각각 다른 절에 적는다.
