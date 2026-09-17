# ClassRelay PoC 통신 규격

[English](protocol.md)

운영에서는 HTTPS origin 하나를 사용한다. Controller와 각 Agent는 각자의 Bearer token으로 인증하며 Agent는 `X-Device-Id`도 보낸다. 영구 SFU 자격증명은 Worker만 보유한다. 예시에 실제 키를 넣어 커밋하지 않는다.

## 제어 WebSocket

`GET /api/connect`는 인증된 WebSocket으로 upgrade한다. upgrade할 때 REST와 같은 인증 header를 보낸다. Worker가 role과 Agent의 device ID를 인증한 뒤에만 연결을 받는다.

Durable Object는 연결 직후와 강사 명령·서버 안전 해제마다 현재 상태를 보낸다.

```json
{
  "type": "state",
  "state": {
    "revision": 12,
    "mode": "lock",
    "leaseMs": 15000,
    "stream": { "sessionId": "publisher-session", "trackName": "screen-1" },
    "students": [{ "deviceId": "student-01", "lastSeen": 1700000000000 }]
  }
}
```

Agent에는 `students` 배열을 비우거나 생략해 보낸다. 연결 중인 두 역할은 모두 5초마다 아래 메시지를 보낸다.

```json
{ "type": "heartbeat" }
```

Controller heartbeat는 15초 서버 lease를 갱신한다. Agent heartbeat는 presence를 갱신한다. Durable Object socket의 직렬화 attachment에는 `{ role, deviceId?, connectionId, lastSeen }`을 넣으며 Bearer token이나 SFU 비밀은 넣지 않는다. WebSocket hibernation은 이 attachment를 보존한다. 유효한 강사 lease는 만료·새 명령·새 강사 연결이 새 세션을 시작하기 전 활성 명령을 안전하게 해제하는 경우까지 유지되며, hibernation이 lease를 초기화하는 것은 아니다. 정상 동작에서 앱은 REST 상태·heartbeat 경로를 폴링하지 않는다.

`mode`는 `practice`, `broadcast`, `lock` 중 하나다. `broadcast`와 `lock`은 등록된 강사 세션의 성공한 영상 트랙을 필요로 한다. `practice`에서 `stream`은 null이다.

`revision`은 강사 명령 변경·서버 안전 해제 시 증가하고 heartbeat로는 증가하지 않는다. 학생의 비상 해제는 같은 revision에 적용되는 잠금 해제 상태로 유지한다. 재연결, 오래된 상태, lease 만료 뒤 응답으로 해제된 명령을 다시 잠그지 않고 더 높은 revision의 새 강사 명령을 기다린다.

## REST·RTC 경로

| 메서드·경로 | 역할 | 용도 |
|---|---|---|
| GET `/health` | 공개 | 서비스 생존 확인 |
| GET `/api/connect` | 강사·학생 | 인증된 제어 WebSocket으로 upgrade |
| GET `/api/state` | 강사·학생 | 기존 호환성·진단용 상태 조회 |
| POST `/api/heartbeat` | 강사·학생 | 기존 호환성·진단용 presence/lease 갱신 |
| POST `/api/mode` | 강사 | HTTPS 동작: `{mode, stream?}`으로 모드 변경 |
| GET `/api/ice` | 강사·학생 | STUN 및 선택적 단기 TURN 자격증명 |
| POST `/api/rtc/sessions` | 강사·학생 | SFU 세션 생성; 기본 body `{}` |
| POST `/api/rtc/sessions/:id/tracks` | 세션 소유자 | 강사는 local video publish, 학생은 active remote video subscribe |
| PUT `/api/rtc/sessions/:id/renegotiate` | 세션 소유자 | `{sessionDescription: {type, sdp}}` 전달 |

HTTPS mode·RTC endpoint는 동작 실행 API로 남고 결과 상태는 WebSocket으로 연결된 클라이언트에 전송한다. 영상은 WebSocket이나 HTTP 응답 body로 중계하지 않는다. SDP 협상 뒤 Controller→Cloudflare SFU→Agent WebRTC 경로로 전송한다.

SFU의 HTTP 성공 코드만 확인하지 않는다. 응답 전체와 개별 `tracks`의 `errorCode`도 실패로 처리한다. 학생의 원격 트랙 요청은 현재 상태의 `sessionId`·`trackName`과 일치해야 한다.
