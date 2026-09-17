# ClassRelay 검증 기록

[English](verification.md)

2026-09-17, Windows 개발 환경에서 수행했다.

## WebSocket 제어 변경

앱은 인증된 WebSocket으로 상태를 수신하고 5초마다 heartbeat를 보낸다. REST mode·RTC 호출은 사용자 동작에 따라 수행한다. 실제 Cloudflare 리소스나 유료 구독은 변경하지 않았다.

- 로컬 workerd 통합 검사(`node scripts/ws-smoke.mjs`)에서 강사 1개와 학생 30개의 모의 WebSocket 연결이 통과했다. SFU 소유권만 로컬에 테스트용으로 등록했으며 실제 영상은 보내지 않았다.
- 잠금·실습 상태 일괄 전달, 학생 명단 비공개, 학생 heartbeat가 계속되는 동안 강사 무응답 15초 후 해제, 만료 잠금 복원 방지, 강사 연결 교체·종료 시 해제를 확인했다.
- 최종 로컬 실습 전환 전달 시간은 약 10ms였다. 개발 PC에서 관측한 값이며 인터넷 환경의 지연 보장이 아니다.
- 네이티브 helper 재빌드와 `--self-test`가 통과했다. 실제 Windows 입력 hook은 실행하지 않았다.
- 백엔드 테스트 21개, 앱 테스트 15개가 통과했다. 백엔드 타입 검사, 앱 구문 검사, Worker 배포 dry-run이 통과했으며 앱 프로덕션 의존성 감사 결과 취약점은 0건이었다.
- 앱 회귀 검사에는 응답 시간 초과, 재접속, 안전한 종료, 렌더러 상태에 따른 heartbeat 제한, 새 화면 송출 준비와 이전 실습 응답의 경합을 포함한다.
- `npm.cmd run dist --prefix apps -- --config.compression=store` 패키징에 성공해 `apps/dist/ClassRelay 0.1.0.exe`(386,354,745바이트)를 생성했다. 패키지 안 JavaScript 5개와 최종 소스가 일치하고 `ws` 8.21.3 포함을 확인했다. 로컬 검증 빌드는 압축을 끈 상태이며 실행 파일은 서명되지 않았다. 실제 입력 제어를 켜서 실행하지 않았다.
- 실제 Cloudflare 영상 송수신, Windows 입력 억제, 로그인 자동 시작, 실기기 30대·5시간 연속 운영은 아직 검증하지 않았다.

## 최초 PoC 검사 (과거 기록)

아래 기록은 최초 PoC 검증 결과다. 저장소 준비 과정에서 제품·패키지 메타데이터와 창 제목을 ClassRelay로 변경하고 영문·한글 문서와 제공된 배너를 추가했으며, 테스트 21개를 다시 통과했다. 기존 실행 파일은 새 브랜드로 재빌드하지 않았고 저장소에 포함하지 않는다.

| 항목 | 결과 | 범위 |
|---|---|---|
| 백엔드 테스트 | 14개 통과 | 인증, 역할, 실제 route/DO 코드의 모의 실행, publish→subscribe→lease 만료, 학생 간 격리, 실패 트랙 거부 |
| TypeScript 검사 | 통과 | `npm run typecheck` |
| Cloudflare 배포 사전 빌드 | 통과 | `wrangler deploy --dry-run`; 실제 배포 아님 |
| 로컬 Worker 실행 | 통과 | `/health` 200, 인증 없는 `/api/state` 401 |
| 토큰 생성 도구 | 문법 검사 통과 | 실제 운영 토큰은 생성·배포하지 않음 |
| Windows 입력 보호 helper | 컴파일·self-test 통과 | 상태 갱신, 비상 해제, 이전 명령 거부, 만료; 실제 입력 훅 실행 안 함 |
| 앱 안전장치 테스트 | 7개 통과 | 잠금·송출 만료, 15초 상한, 지연 응답, 비상 해제 유지, 새 명령 및 과거 명령 처리 |
| 앱 JavaScript 검사 | 통과 | main, preload, renderer, safety 문법 검사 |
| Windows portable 패키징 | 통과 | `apps/dist/Classroom Cloudflare 0.1.0.exe` 생성; 서명 없는 PoC |
| 패키징 내용 비교 | 일치 | unpacked app.asar의 4개 JS 파일과 현재 소스 일치, 포함된 InputGuard와 최신 빌드 hash 일치 |

백엔드 SFU 호출은 테스트 응답으로 대체했다. 실제 Cloudflare 계정 키, 도메인 및 교육 장비가 제공되지 않아 실서버 영상 송수신, TURN 릴레이, Windows 입력 억제 실사용, 로그인 자동 실행, 30대 동시/8시간 운영 시험은 수행하지 않았다.

통합 검토 중 HTTP 200 응답 안의 개별 SFU 트랙 오류를 등록 성공으로 취급하는 문제를 발견해 수정했고 회귀 테스트를 추가했다. 네이티브 입력 보호 도구는 실제 키 입력을 억제하지 않는 `--self-test`로만 검사한다.

운영 전 검증 항목은 [장비 검증표](acceptance.ko.md)를 따른다.
