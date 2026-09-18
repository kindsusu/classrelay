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
    "students": [{ "deviceId": "student-01", "lastSeen": 1700000000000, "mediaReady": true }]
  }
}
```

Agent에는 `students` 배열을 비우거나 생략해 보낸다. 연결 중인 두 역할은 모두 5초마다 아래 메시지를 보낸다.

```json
{ "type": "heartbeat" }
```

Agent는 자신의 영상 수신 상태를 실어 같은 frame을 보낼 수 있다.

```json
{ "type": "heartbeat", "mediaReady": true }
```

클라이언트 메시지로 허용하는 것은 이 두 frame뿐이다. Controller가 `mediaReady`를 보내거나, 다른 key가 하나라도 더 있거나, `mediaReady`가 boolean이 아니면 1008 `only heartbeat messages are accepted`로 닫는다. 1,024바이트를 넘는 frame은 1009 `message too large`로 닫는다.

Controller heartbeat는 15초 서버 lease를 갱신한다. Agent heartbeat는 presence를 갱신한다. Durable Object socket의 직렬화 attachment에는 `{ role, deviceId?, connectionId, lastSeen, mediaReady }`를 넣으며 Bearer token이나 SFU 비밀은 넣지 않는다. `mediaReady` 도입 전에 직렬화된 attachment는 거부하지 않고 `false`로 읽어, 배포 때문에 살아 있는 학생 연결이 끊기지 않게 한다. WebSocket hibernation은 이 attachment를 보존한다. 유효한 강사 lease는 만료·새 명령·새 강사 연결이 새 세션을 시작하기 전 활성 명령을 안전하게 해제하는 경우까지 유지되며, hibernation이 lease를 초기화하는 것은 아니다. 정상 동작에서 앱은 REST 상태·heartbeat 경로를 폴링하지 않는다.

## 학생 영상 수신 표시

roster의 각 항목은 `mediaReady`를 boolean으로 보고한다. 기기가 연결된 순간부터 그 기기가 스스로 `true`를 보고하기 전까지는 `false`다. 강사는 이것으로 제어 연결과 실제 영상 수신을 구분한다. 연결 수만으로 30대가 화면을 받고 있다고 판단하지 않는다.

`mediaReady`는 학생 본인의 영상 수신에 대한 생존·진단 신호일 뿐이다. 그 Agent가 지금 강사 영상을 받고 있는지만 알린다. 화면 내용도 썸네일도 아니고 학생 활동에 대한 telemetry도 아니다. 학생 PC의 화면·파일·입력은 어떤 것도 수집하거나 전송하지 않는다. presence metadata이므로 `mode`·강사 lease·`revision`에 전혀 영향을 주지 않는다.

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

`GET /api/ice`는 TURN 설정 여부와 관계없이 항상 `{ iceServers: [...] }` 배열을 반환한다 — Cloudflare TURN API가 돌려주는 단일 객체도 배열로 감싸며 그대로 내보내지 않는다 — 그래서 클라이언트는 응답을 그대로 `RTCPeerConnection`에 넘길 수 있다. Worker가 보유한 TURN 자격증명이 거부되거나 잘못 설정된 경우는 502 서버 오류이며 401이 아니다. `/api/ice`의 401은 항상 호출자 자신의 bearer token이 거부됐다는 뜻이며 Worker의 TURN 자격증명 문제가 아니다.
