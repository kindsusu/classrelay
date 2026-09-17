# ClassRelay PoC 통신 규격

[English](protocol.md)

운영에서는 HTTPS origin 하나를 사용한다. 각 요청에 `Authorization: Bearer <token>`을 넣고 학생은 `X-Device-Id`도 보낸다. SFU 자격증명은 Worker만 보유한다. 예시에 실제 키를 넣어 커밋하지 않는다.

| 메서드·경로 | 역할 | 용도 |
|---|---|---|
| GET `/health` | 공개 | 서비스 생존 확인 |
| GET `/api/state` | 강사·학생 | 현재 명령 및 stream 조회 |
| POST `/api/heartbeat` | 강사·학생 | 강사 lease 갱신 또는 학생 lastSeen 기록 |
| POST `/api/mode` | 강사 | `{mode, stream?}`으로 모드 변경 |
| GET `/api/ice` | 강사·학생 | STUN 및 선택적 단기 TURN 자격증명 |
| POST `/api/rtc/sessions` | 강사·학생 | SFU 세션 생성; 기본 body `{}` |
| POST `/api/rtc/sessions/:id/tracks` | 세션 소유자 | 강사 local video publish, 학생 active remote subscribe |
| PUT `/api/rtc/sessions/:id/renegotiate` | 세션 소유자 | `{sessionDescription: {type, sdp}}` 전달 |

상태 응답 예시:

```json
{
  "revision": 12,
  "mode": "lock",
  "leaseMs": 15000,
  "stream": { "sessionId": "publisher-session", "trackName": "screen-1" },
  "students": [{ "deviceId": "student-01", "lastSeen": 1700000000000 }]
}
```

`mode`는 `practice`, `broadcast`, `lock` 중 하나다. 학생 응답의 `students` 배열은 비워서 전달한다. `lastSeen`은 밀리초 Unix timestamp이며 현재 시각과 비교해야 한다. 배열에 있다는 사실만으로 현재 연결 중이라고 판단하지 않는다.

`broadcast`와 `lock`은 등록된 강사 세션의 성공한 영상 트랙을 필요로 한다. 학생 세션 ID나 실패한 트랙으로 모드를 바꿀 수 없다. `practice`에서 stream은 null로 바뀐다.

`revision`은 명령 변경·서버 안전 해제 시 증가한다. heartbeat로 증가하지 않는다. 학생의 비상 해제는 같은 revision에 적용되는 잠금 해제 상태로 유지한다. UI·네트워크 복구만으로 해제된 명령을 다시 잠그지 않고 새 강사 명령을 기다린다.

SFU의 HTTP 성공 코드만 확인하지 않는다. 응답 전체와 개별 `tracks`의 `errorCode`도 실패로 처리한다. 학생의 원격 트랙 요청은 현재 상태의 sessionId/trackName과 일치해야 한다.

영상은 이 API의 응답 body로 중계되지 않는다. SDP 협상 후 Controller→Cloudflare SFU→Agent WebRTC 경로로 전송된다.
