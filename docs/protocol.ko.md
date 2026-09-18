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

클라이언트 메시지로 허용하는 것은 이 두 frame뿐이다. Controller가 `mediaReady`를 보내거나, 다른 key가 하나라도 더 있거나, `mediaReady`가 boolean이 아니면 1008 `only heartbeat messages are accepted`로 닫는다. 1,024바이트를 넘는 frame은 1009 `message too large`로 닫는다. 서버가 보내는 frame은 `state`와 아래에 설명하는 `quit` 두 종류뿐이다. 둘 다 클라이언트→서버 대응 frame이 없으며, 클라이언트가 `{"type":"quit"}`을 보내면 다른 미지의 frame과 똑같이 닫힌다.

Controller heartbeat는 15초 서버 lease를 갱신한다. Agent heartbeat는 presence를 갱신한다. Durable Object socket의 직렬화 attachment에는 `{ role, deviceId?, connectionId, lastSeen, mediaReady }`를 넣으며 Bearer token이나 SFU 비밀은 넣지 않는다. `mediaReady` 도입 전에 직렬화된 attachment는 거부하지 않고 `false`로 읽어, 배포 때문에 살아 있는 학생 연결이 끊기지 않게 한다. WebSocket hibernation은 이 attachment를 보존한다. 유효한 강사 lease는 만료·새 명령·새 강사 연결이 새 세션을 시작하기 전 활성 명령을 안전하게 해제하는 경우까지 유지되며, hibernation이 lease를 초기화하는 것은 아니다. 정상 동작에서 앱은 REST 상태·heartbeat 경로를 폴링하지 않는다.

## 학생 영상 수신 표시

roster의 각 항목은 `mediaReady`를 boolean으로 보고한다. 기기가 연결된 순간부터 그 기기가 스스로 `true`를 보고하기 전까지는 `false`다. 강사는 이것으로 제어 연결과 실제 영상 수신을 구분한다. 연결 수만으로 30대가 화면을 받고 있다고 판단하지 않는다.

`mediaReady`는 학생 본인의 영상 수신에 대한 생존·진단 신호일 뿐이다. 그 Agent가 지금 강사 영상을 받고 있는지만 알린다. 화면 내용도 썸네일도 아니고 학생 활동에 대한 telemetry도 아니다. 학생 PC의 화면·파일·입력은 어떤 것도 수집하거나 전송하지 않는다. presence metadata이므로 `mode`·강사 lease·`revision`에 전혀 영향을 주지 않는다.

## 수업 모드

`mode`는 네 가지 wire 이름 중 하나다. 구분 기준은 두 가지뿐이다. 학생 기기에 강사 화면이 보이는지, 그리고 학생 입력을 잠그는지다.

| `mode` | 강사 화면 표시 | 학생 입력 잠금 | `stream` | 용도 |
|---|---|---|---|---|
| `practice` | 아니오 | 아니오 | null | 학생이 자유롭게 실습한다. 영상을 publish도 subscribe도 하지 않는다. |
| `broadcast` | 예 | 아니오 | 필수 | 학생이 강사 화면을 보면서 자기 기기에서 계속 작업한다. |
| `lecture` | 예 | 예 | 필수 | 보기 전용. 강사 화면을 보며 타이핑·클릭은 할 수 없다. |
| `lock` | 아니오 — 의도적으로 가린다 | 예 | 필수 | 입력을 잠그고 화면도 가려, 학생이 모니터가 아니라 교실의 강사를 보게 한다. |

입력을 잠그는 모드는 `lecture`와 `lock`이다. 백엔드는 모드 이름을 직접 비교하지 않고 `locksInput(mode)` 술어 하나로만 이를 판단한다. `broadcast`·`lecture`·`lock`은 모두 등록된 강사 세션의 성공한 영상 트랙을 필요로 한다. `stream`이 null인 모드는 `practice`뿐이며, 모든 해제가 되돌아가는 fail-safe 기본값이다.

`practice`가 아닌 모든 모드는 15초 강사 lease를 쥐고, 같은 방식으로 `practice`로 해제된다 — lease 만료, Durable Object alarm, 비상 해제, 강사 연결 종료, 새 강사 연결. `lecture`도 예외 없이 이를 그대로 물려받는다. lease보다 오래 살아남은 `lecture`는 `lock`과 똑같이 더 높은 revision과 비워진 stream을 가진 `practice`가 된다.

`revision`은 강사 명령 변경·서버 안전 해제 시 증가하고 heartbeat로는 증가하지 않는다. 학생의 비상 해제는 같은 revision에 적용되는 잠금 해제 상태로 유지한다. 재연결, 오래된 상태, lease 만료 뒤 응답으로 해제된 명령을 다시 잠그지 않고 더 높은 revision의 새 강사 명령을 기다린다.

## 학생 앱 종료 명령

`POST /api/agents/quit`은 빈 JSON body(`{}`)를 받는 강사 전용 경로다. Durable Object는 연결된 모든 **Agent** socket에 아래 frame을 보내고, Controller socket에는 보내지 않는다.

```json
{ "type": "quit" }
```

정확히 이 frame을 받은 Agent는 자기 앱을 종료한다. key가 하나라도 더 붙은 frame은 quit frame이 아니므로 무시한다. 그래서 나중에 서버가 필드를 추가해도 종료 명령으로 오인될 수 없다. 응답은 frame을 보낸 Agent socket 수를 알린다.

```json
{ "ok": true, "notified": 30 }
```

학생 토큰으로 이 경로를 호출하면 403 `controller role required`로 거부한다. key가 있는 body는 400으로 거부하므로, 이 경로에 암묵적 파라미터가 생길 수 없다.

**이 명령은 일회성이며 어디에도 저장하지 않는다** — snapshot에도, Durable Object storage에도, socket attachment에도 넣지 않는다. 그 순간 연결돼 있는 Agent socket에만 보내고 끝내는 fire-and-forget fanout이다. 명령이 나간 *뒤에* 접속한 학생 앱은 이 명령을 받지 않으며 종료되지 않는다. 따라서 `notified`는 그 순간 살아 있던 socket 수일 뿐이고, socket 구성이 달라진 뒤 다시 호출하면 다른 수가 나온다.

종료는 수업 모드가 아니며 `mode`·`revision`·`leaseMs`·`stream`·강사 lease를 건드리지 않는다. fail-safe 상태 기계와 직교하며, `/api/mode`에 `{"mode": "quit"}`을 보내면 400 `invalid mode`로 거부한다.

**강사가 학생 앱을 원격으로 다시 실행할 수는 없다.** 이 명령에는 대응되는 반대 명령이 없다. ClassRelay에는 학생 애플리케이션을 실행·재시작·기동하는 기능이 없고, 학생 기기에서 실행 명령을 기다리는 것도 없다. 학생 앱이 한 번 종료되면 그 기기에서 사람이 직접 다시 실행하거나, 조직이 설정한 자동 시작 정책에 따라 다음 Windows 로그인 때 다시 시작된다. 수업 중 일시적인 조치가 아니라 수업을 끝낼 때 쓴다.

## REST·RTC 경로

| 메서드·경로 | 역할 | 용도 |
|---|---|---|
| GET `/health` | 공개 | 서비스 생존 확인 |
| GET `/api/connect` | 강사·학생 | 인증된 제어 WebSocket으로 upgrade |
| GET `/api/state` | 강사·학생 | 기존 호환성·진단용 상태 조회 |
| POST `/api/heartbeat` | 강사·학생 | 기존 호환성·진단용 presence/lease 갱신 |
| POST `/api/mode` | 강사 | HTTPS 동작: `{mode, stream?}`으로 모드 변경 |
| POST `/api/agents/quit` | 강사 | HTTPS 동작: 빈 `{}` body; 연결된 학생 앱 전부에 종료를 요청하고 `{ok, notified}`를 반환 |
| GET `/api/ice` | 강사·학생 | STUN 및 선택적 단기 TURN 자격증명 |
| POST `/api/rtc/sessions` | 강사·학생 | SFU 세션 생성; body에 `{sessionDescription: {type: "offer", sdp}}`를 실어야 하고 응답이 answer를 돌려준다 |
| POST `/api/rtc/sessions/:id/tracks` | 세션 소유자 | 강사는 local video publish, 학생은 active remote video subscribe |
| PUT `/api/rtc/sessions/:id/renegotiate` | 세션 소유자 | `{sessionDescription: {type, sdp}}` 전달 |

HTTPS mode·RTC endpoint는 동작 실행 API로 남고 결과 상태는 WebSocket으로 연결된 클라이언트에 전송한다. 영상은 WebSocket이나 HTTP 응답 body로 중계하지 않는다. SDP 협상 뒤 Controller→Cloudflare SFU→Agent WebRTC 경로로 전송한다.

## RTC 협상 순서

양쪽 역할 모두 세션 생성 시점에 offer를 보낸다. Controller는 캡처한 화면을 실은 `sendonly` video 트랜시버를, Agent는 offer로 내보낼 것이 있어야 하므로 `recvonly` video 트랜시버를 추가한다. 이어서 offer를 만들어 로컬에 적용하고 ICE 수집을 기다린 뒤 세션 생성 body로 보낸다.

1. `POST /api/rtc/sessions`에 `{sessionDescription: {type: "offer", sdp}}` → `201 {sessionId, sessionDescription: {type: "answer", sdp}}`. 이 answer를 `setRemoteDescription`으로 적용한다.
2. `POST /api/rtc/sessions/:id/tracks`에는 `{tracks: [...]}`만 보낸다. offer는 1단계에서 이미 전달되고 응답까지 받았다.
3. 트랙 응답이 `sessionDescription`을 추가로 실어 오면 무시하지 않는다. `answer`는 로컬 offer가 아직 대기 중일 때만 적용하고, `offer`는 `PUT /api/rtc/sessions/:id/renegotiate`로 답한다. 1단계와 3단계 어디서도 remote description을 얻지 못하면 클라이언트는 성립할 수 없는 전송로를 기다리지 않고 한국어 오류로 실패시킨다.

이 순서는 2026-09-18에 실제 controller token으로 배포된 Worker와 라이브 Cloudflare SFU를 측정해 확정했다.

| 세션 생성 body | 라이브 결과 |
|---|---|
| `{}` | `400 {"errorCode":"decoding_error","errorDescription":"Body JSON validation error: sessionDescription"}` |
| `{sessionDescription: {type: "offer", sdp}}` | `201 {sessionId, sessionDescription}`, `sessionDescription.type === "answer"` |

**공개된 Cloudflare 스펙은 이와 다르며 낡았다.** `realtime-api-2024-05-21.yaml`과 Cloudflare 문서의 lifecycle 설명은 body 없는 `/sessions/new`와 `/tracks/new`로 나중에 보내는 offer를 적고 있다. 이 PoC가 원래 그대로 구현했고, 그래서 화면 송출이 매번 첫 호출에서 `서버 오류 400`만 남기고 실패했다. 위 측정을 공개 스펙보다 신뢰하고, 이 순서를 바꾸려면 먼저 다시 측정한다.

**`/tracks/new` 규약은 실제 피어로 검증되지 않았다.** 이를 확인하려던 탐색은 DTLS fingerprint와 ICE candidate가 쓸 수 없는 합성 SDP를 썼다. SFU가 끝내 성립하지 않는 전송로를 기다렸고 Worker의 10초 업스트림 timeout이 먼저 걸려 `502 {"error":"Realtime service unavailable"}`가 돌아왔다 — SFU의 거절이 아니라 호출 측 산물이다. 따라서 `/tracks/new`가 `sessionDescription`을 요구하거나 반환하는지는 알 수 없다. 클라이언트는 최소 형태인 `{tracks: [...]}`만 보내고 응답에 SDP가 있든 없든 견딘다. 실제 두 대 송출 실행이 이를 확정할 것이다.

SFU 오류 본문은 Worker 자신의 `error` 필드가 아니라 `errorCode`·`errorDescription`을 쓰며, Worker는 업스트림 RTC 실패의 상태 코드와 본문을 그대로 전달한다. `error`만 읽는 클라이언트는 실제 이유를 버리므로 `errorCode`·`errorDescription`을 함께 보여야 한다 — 길이를 제한하고, SDP나 자격증명처럼 보이는 문자열은 메시지·로그로 옮기지 않는다.

SFU의 HTTP 성공 코드만 확인하지 않는다. 응답 전체와 개별 `tracks`의 `errorCode`도 실패로 처리한다. 학생의 원격 트랙 요청은 현재 상태의 `sessionId`·`trackName`과 일치해야 한다.

`GET /api/ice`는 TURN 설정 여부와 관계없이 항상 `{ iceServers: [...] }` 배열을 반환한다 — Cloudflare TURN API가 돌려주는 단일 객체도 배열로 감싸며 그대로 내보내지 않는다 — 그래서 클라이언트는 응답을 그대로 `RTCPeerConnection`에 넘길 수 있다. Worker가 보유한 TURN 자격증명이 거부되거나 잘못 설정된 경우는 502 서버 오류이며 401이 아니다. `/api/ice`의 401은 항상 호출자 자신의 bearer token이 거부됐다는 뜻이며 Worker의 TURN 자격증명 문제가 아니다.
