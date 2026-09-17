# ClassRelay 개발 지침

[English](AGENTS.md) | **한국어**

- 저장소 문서는 영문을 기본으로 하고 한글 버전을 함께 관리한다.
- 사용자에게 한국어로 간결하게 결과를 먼저 설명한다. 작업 제목은 별도 요청이 없으면 영어로 작성한다.
- 설계·통합·검수는 Astra, 일반 구현은 Terra, 복잡한 Windows/RTC 구현은 Sol에 위임한다. 실제 제공되는 모델·기능만 사용한다. 같은 파일을 동시에 수정하지 않는다.
- 이 저장소는 회사 소유 Windows 교육 장비용 PoC다. 원격 조작, 학생 화면 수집, 파일 수집, 키 입력 기록 기능을 추가하지 않는다.
- 수정 전 `docs/architecture.md`와 담당 모듈의 README를 읽는다.
- fail-safe를 약화하지 않는다. 만료·프로세스 장애·비상 해제 후 이전 revision의 입력 잠금을 복원하지 않는다. 네이티브 helper의 독립 watchdog을 보존한다.
- SFU/TURN 영구 키는 Worker secrets에만 둔다. 실제 토큰 파일을 Git에 추가하거나 출력하지 않는다.
- 테스트: `npm.cmd test --prefix backend`, `npm.cmd run typecheck --prefix backend`, `npm.cmd test --prefix apps`, `npm.cmd run check --prefix apps`.
- 네이티브 변경은 `powershell.exe -NoProfile -File native-input/build.ps1`과 `InputGuard.exe --self-test`로 확인한다. 호스트 입력을 잠그는 테스트를 무심코 실행하지 않는다. 실제 장비 시험 결과와 모의 테스트 결과를 구분한다.
- 패키징은 native helper 빌드 후 `npm.cmd run dist --prefix apps`. Worker 사전 검증은 backend에서 `npx.cmd wrangler deploy --dry-run`.
- 실제 배포·실장비 장시간 시험을 실행하지 않았다면 완료 보고에 분명히 남긴다.
