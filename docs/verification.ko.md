# ClassRelay 검증 기록

[English](verification.md)

2026-09-17, Windows 개발 환경에서 수행했다.

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
