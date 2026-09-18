'use strict';

const api = window.classroom;
const $ = (id) => document.getElementById(id);

const DEFAULT_VIDEO = { maxHeight: 720, maxFps: 15, maxBitrateKbps: 2_000 };
const PUBLISH_STATS_MS = 2_000;
const INBOUND_STATS_MS = 1_000;
// 프리즈 판정 임계값. reportMediaFailure()는 main의 emergencyUnlock()을 거쳐 해당 revision의
// 잠금을 영구 해제(latch)하므로 폴링 한 번의 결함으로 발동하면 안 된다. 1초 폴링에서 3초는
// 연속 3회 무진행이고 15fps 기준 약 45프레임 분량이라 일시적 재전송·키프레임 대기로는 차지 않는다.
// 동시에 서버 lease fail-safe(15초)보다 훨씬 짧아 학생이 죽은 화면 앞에서 오래 막히지 않는다.
const FREEZE_MS = 3_000;
const RESUBSCRIBE_BACKOFF_MS = [1_000, 3_000, 6_000];
const MAX_RESUBSCRIBE_ATTEMPTS = RESUBSCRIBE_BACKOFF_MS.length;
const ROSTER_CUTOFF_MS = 15_000;
const SWITCH_CANCELLED = '서버 연결이 바뀌어 화면 교체를 취소했습니다. 송출 상태를 확인하고 다시 시도하세요.';

let config;
let sources = [];
let selectedSourceId = null;
let sourceSwitching = false;
let publishing = null;
let subscribing = null;
let lastStreamKey = null;
let pendingStreamKey = null;
let subscriptionPromise = null;
let subscriptionGeneration = 0;
let agentMediaReady = false;
let controllerOnline = false;
let controllerConnectionGeneration = 0;
let latestControllerState = null;
let rebroadcastRequired = false;
let publishStatsTimer = null;
let publishSample = null;
let inboundStatsTimer = null;
let inboundProgress = null;
let mediaFrozen = false;
let agentState = null;
let agentStreamKey = null;
let resubscribeTimer = null;
let resubscribeAttempts = 0;

function shouldStopPublishingForState(state, publication) {
  return state?.mode === 'practice'
    && Number.isSafeInteger(state.revision)
    && Number.isSafeInteger(publication?.activationRevision)
    && state.revision >= publication.activationRevision;
}

function summarizeRoster(students, now, cutoffMs = ROSTER_CUTOFF_MS) {
  if (!Array.isArray(students)) return { connected: 0, media: 0 };
  const live = students.filter((student) => Number(student?.lastSeen) >= now - cutoffMs);
  return { connected: live.length, media: live.filter((student) => student?.mediaReady === true).length };
}

function shouldResubscribe(state, attempts, maxAttempts = MAX_RESUBSCRIBE_ATTEMPTS) {
  return Boolean(state)
    && state.mode !== 'practice'
    && typeof state.stream?.sessionId === 'string'
    && typeof state.stream?.trackName === 'string'
    && Number(attempts) < maxAttempts;
}

function videoProgressValue(sample) {
  if (Number.isFinite(sample?.framesDecoded)) return sample.framesDecoded;
  if (Number.isFinite(sample?.bytesReceived)) return sample.bytesReceived;
  return null;
}

function evaluateVideoProgress(previous, sample, freezeMs = FREEZE_MS) {
  const value = videoProgressValue(sample);
  const at = Number(sample?.at) || 0;
  // 통계를 읽지 못하는 환경은 프리즈로 단정하지 않는다. 잠금 해제는 fail-safe지만
  // 계측 부재만으로 latch를 걸면 정상 수업이 복구 불가능하게 끊긴다.
  if (value === null) return { value: previous?.value ?? null, at: previous?.at ?? at, stalledMs: 0, frozen: false };
  if (!previous || previous.value === null || value !== previous.value) return { value, at, stalledMs: 0, frozen: false };
  const stalledMs = Math.max(0, at - previous.at);
  return { value: previous.value, at: previous.at, stalledMs, frozen: stalledMs >= freezeMs };
}

function collectStats(report) {
  const stats = [];
  report?.forEach?.((value) => stats.push(value));
  return stats;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isVideo(stat) {
  return stat?.kind === 'video' || stat?.mediaType === 'video';
}

function outboundVideoSample(stats, at) {
  const outbound = stats.find((stat) => stat?.type === 'outbound-rtp' && isVideo(stat));
  if (!outbound) return null;
  const remote = stats.find((stat) => stat?.type === 'remote-inbound-rtp' && stat.id === outbound.remoteId)
    || stats.find((stat) => stat?.type === 'remote-inbound-rtp' && isVideo(stat));
  return {
    at: Number(at) || 0,
    width: numberOrNull(outbound.frameWidth) || 0,
    height: numberOrNull(outbound.frameHeight) || 0,
    fps: numberOrNull(outbound.framesPerSecond) || 0,
    bytesSent: numberOrNull(outbound.bytesSent),
    packetsSent: numberOrNull(outbound.packetsSent),
    packetsLost: numberOrNull(remote?.packetsLost),
    fractionLost: numberOrNull(remote?.fractionLost)
  };
}

function inboundVideoSample(stats, at) {
  const inbound = stats.find((stat) => stat?.type === 'inbound-rtp' && isVideo(stat));
  if (!inbound) return null;
  return {
    at: Number(at) || 0,
    width: numberOrNull(inbound.frameWidth) || 0,
    height: numberOrNull(inbound.frameHeight) || 0,
    fps: numberOrNull(inbound.framesPerSecond) || 0,
    framesDecoded: numberOrNull(inbound.framesDecoded),
    bytesReceived: numberOrNull(inbound.bytesReceived)
  };
}

function deltaKbps(previous, sample, field) {
  if (!previous || !sample || !Number.isFinite(sample[field]) || !Number.isFinite(previous[field])) return null;
  const elapsed = sample.at - previous.at;
  const bits = (sample[field] - previous[field]) * 8;
  if (!(elapsed > 0) || !(bits >= 0)) return null;
  return bits / elapsed; // bit/ms == kbit/s
}

function formatRate(kbps) {
  return kbps >= 1_000 ? `${(kbps / 1_000).toFixed(1)}Mbps` : `${Math.round(kbps)}kbps`;
}

function lossPercent(previous, sample) {
  if (Number.isFinite(sample?.fractionLost)) return Math.min(100, Math.max(0, sample.fractionLost * 100));
  if (!previous || !Number.isFinite(sample?.packetsLost) || !Number.isFinite(previous.packetsLost)) return null;
  const lost = sample.packetsLost - previous.packetsLost;
  const sent = sample.packetsSent - previous.packetsSent;
  if (!(sent > 0) || !(lost >= 0)) return null;
  return Math.min(100, (lost / sent) * 100);
}

function formatMediaLine(previous, sample, field) {
  if (!sample) return '';
  const parts = [];
  if (sample.width && sample.height) parts.push(`${sample.width}×${sample.height}`);
  if (sample.fps) parts.push(`${Math.round(sample.fps)}fps`);
  const kbps = deltaKbps(previous, sample, field);
  if (kbps !== null) parts.push(formatRate(kbps));
  const loss = lossPercent(previous, sample);
  if (loss !== null) parts.push(`손실 ${loss.toFixed(1)}%`);
  return parts.join(' · ');
}

function message(text, isError = false) {
  const el = $('message');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#ff9994' : '#ffcc74';
}

function videoConfig() {
  return config?.video || DEFAULT_VIDEO;
}

// Worker fallback (no TURN) sends an array; Worker-proxied Cloudflare TURN sends one {urls,username,credential}
// object instead. RTCPeerConnection only accepts an array, so accept either shape and normalize to one.
function normalizeIceServers(iceServers) {
  if (Array.isArray(iceServers)) return iceServers;
  return iceServers && typeof iceServers === 'object' ? [iceServers] : [];
}

async function iceConfiguration() {
  try {
    const result = await api.getIce();
    return { iceServers: normalizeIceServers(result?.iceServers) };
  } catch { return { iceServers: [] }; }
}

async function waitIceComplete(pc, timeoutMs = 4_000) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function applyTrackCaps(track, video) {
  try {
    // 화면은 PPT·문서 위주라 움직임보다 글자 가독성을 우선하도록 인코더에 힌트를 준다.
    track.contentHint = 'text';
    await track.applyConstraints?.({ height: { max: video.maxHeight }, frameRate: { max: video.maxFps } });
  } catch (error) {
    message(`송출 해상도 제한을 적용하지 못했습니다: ${error.message}`);
  }
}

async function applySenderCaps(sender, video) {
  try {
    if (typeof sender?.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    // getParameters가 돌려준 객체를 그대로 수정해 넘겨야 한다. 새 객체를 만들면 transactionId가
    // 달라 InvalidModificationError로 송출 자체가 실패한다.
    const parameters = sender.getParameters();
    if (!Array.isArray(parameters?.encodings) || !parameters.encodings[0]) return;
    parameters.encodings[0].maxBitrate = video.maxBitrateKbps * 1_000;
    parameters.encodings[0].maxFramerate = video.maxFps;
    parameters.degradationPreference = 'maintain-resolution';
    await sender.setParameters(parameters);
  } catch (error) {
    message(`송출 비트레이트 제한을 적용하지 못했습니다: ${error.message}`);
  }
}

// 라이브 SFU 실측(2026-09-18): /sessions/new는 offer를 요구하고 같은 응답에 answer를 돌려준다.
// 빈 body({})는 400 decoding_error(Body JSON validation error: sessionDescription)로 거절된다.
// 공개된 realtime-api-2024-05-21.yaml은 body 없는 세션 생성을 적고 있으나 낡았다.
function sessionCreationBody(description) {
  return { sessionDescription: plainDescription(description) };
}

// 트랙 요청은 최소 형태로 보낸다. offer는 세션 생성에서 이미 전달·응답됐고,
// /tracks/new가 SDP를 또 요구하는지는 실기기 검증 전까지 확정되지 않았다.
function localTrackRequest(mid, trackName) {
  return { tracks: [{ location: 'local', kind: 'video', mid, trackName }] };
}

function remoteTrackRequest(streamInfo) {
  return { tracks: [{ location: 'remote', sessionId: streamInfo.sessionId, trackName: streamInfo.trackName }] };
}

// 어느 응답이 SDP를 실어 줄지는 세션 생성만 측정으로 확정됐다. 트랙 응답이 SDP를 함께 주더라도
// 무시하지 않는다. 이미 협상이 끝난 뒤 온 answer는 중복이라 버리고, offer는 renegotiate로 답한다.
function negotiationStep(description, signalingState) {
  if (!description || typeof description.type !== 'string' || typeof description.sdp !== 'string') return 'none';
  if (description.type === 'answer') return signalingState === 'have-local-offer' ? 'answer' : 'none';
  if (description.type === 'offer') return 'renegotiate';
  return 'none';
}

async function applyNegotiation(pc, sessionId, description, action) {
  const step = negotiationStep(description, pc.signalingState);
  if (step === 'none') return step;
  await pc.setRemoteDescription(description);
  if (step === 'answer') return step;
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceComplete(pc);
  assertRtc(await api.renegotiateRtc(sessionId, { sessionDescription: plainDescription(pc.localDescription) }), action);
  return step;
}

function stopPublishStats() {
  if (publishStatsTimer) clearInterval(publishStatsTimer);
  publishStatsTimer = null;
  publishSample = null;
  const el = $('publish-stats');
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
}

function startPublishStats(publication) {
  stopPublishStats();
  publishStatsTimer = setInterval(async () => {
    if (publishing !== publication) return stopPublishStats();
    let sample;
    try { sample = outboundVideoSample(collectStats(await publication.pc.getStats()), performance.now()); }
    catch { return; }
    if (!sample || publishing !== publication) return;
    const line = formatMediaLine(publishSample, sample, 'bytesSent');
    publishSample = sample;
    const el = $('publish-stats');
    if (el && line) { el.textContent = `송출 ${line}`; el.classList.remove('hidden'); }
  }, PUBLISH_STATS_MS);
}

async function stopPublishing() {
  if (!publishing) return;
  const active = publishing;
  publishing = null;
  markSources();
  stopPublishStats();
  if (active.endedHandler) active.track.removeEventListener('ended', active.endedHandler);
  active.stream.getTracks().forEach((track) => track.stop());
  active.pc.close();
}

async function startPublishing() {
  if (publishing) return publishing.descriptor;
  if (!selectedSourceId) throw new Error('먼저 송출할 화면을 선택하세요.');
  await api.selectCaptureSource(selectedSourceId);
  const video = videoConfig();
  let stream;
  let pc;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { height: { max: video.maxHeight }, frameRate: { ideal: video.maxFps, max: video.maxFps } },
      audio: false
    });
    pc = new RTCPeerConnection(await iceConfiguration());
    const track = stream.getVideoTracks()[0];
    await applyTrackCaps(track, video);
    const trackName = `screen-${config.deviceId}-${Date.now()}`;
    const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    await applySenderCaps(transceiver.sender, video);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    const session = assertRtc(await api.createRtcSession(sessionCreationBody(pc.localDescription)), 'RTC 세션 생성');
    if (!session.sessionId) throw new Error('Cloudflare RTC 세션 ID를 받지 못했습니다.');
    const sessionStep = await applyNegotiation(pc, session.sessionId, session.sessionDescription, 'RTC 세션 SDP 확정');
    const result = assertRtc(await api.addRtcTracks(session.sessionId, localTrackRequest(transceiver.mid, trackName)), '화면 트랙 발행');
    const trackStep = await applyNegotiation(pc, session.sessionId, result.sessionDescription, '화면 트랙 SDP 확정');
    if (sessionStep === 'none' && trackStep === 'none') throw new Error('Cloudflare가 송출 응답 SDP를 반환하지 않았습니다.');
    const endedHandler = () => setPractice().catch(() => {});
    track.addEventListener('ended', endedHandler, { once: true });
    const descriptor = { sessionId: session.sessionId, trackName: result.tracks?.[0]?.trackName || trackName };
    // sender를 함께 들고 있어야 송출을 끊지 않고 replaceTrack으로 화면만 바꿀 수 있다.
    publishing = { pc, stream, track, sender: transceiver.sender, endedHandler, descriptor, activationRevision: null, sourceId: selectedSourceId };
    markSources();
    startPublishStats(publishing);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' && publishing?.pc === pc) {
        message('화면 송출 연결이 끊겨 실습 모드로 해제합니다.', true);
        setPractice().catch((error) => message(error.message, true));
      }
    });
    return descriptor;
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    pc?.close();
    throw error;
  }
}

function assertRtc(value, action) {
  const trackError = Array.isArray(value?.tracks) && value.tracks.find((track) => track?.errorCode || track?.error);
  if (!value || value.errorCode || value.error || trackError) throw new Error(`${action} 실패: ${trackError?.errorDescription || trackError?.error || trackError?.errorCode || value?.errorDescription || value?.error || value?.errorCode || '응답 없음'}`);
  return value;
}

function plainDescription(description) {
  if (!description || typeof description.type !== 'string' || typeof description.sdp !== 'string') throw new Error('유효한 SDP를 만들지 못했습니다.');
  return { type: description.type, sdp: description.sdp };
}

// 장애 문구에만 붙는 모드 접두사. 정상 상태에서는 어디에도 표시되지 않는다.
const AGENT_STATUS = {
  practice: '실습 모드',
  broadcast: '화면 보여주기',
  lecture: '이론 모드 · 입력 차단 중',
  lock: '강사 주목 · 입력 차단 중'
};

const AGENT_OFFLINE_TEXT = '서버 재연결 중 · 15초 후 자동 해제';

function agentStatusText(mode) {
  return AGENT_STATUS[mode] || AGENT_STATUS.practice;
}

// 학생 화면은 발표 모드처럼 영상만 남긴다. 정상일 때는 모드 안내도 실측값도 올리지 않고,
// 학생과 현장 담당자가 대응해야 하는 장애에서만 말한다: 제어 연결 끊김·재연결, 프리즈 안전 해제,
// 구독 재시도·실패, 비상 해제. released는 그 revision 동안 latch되어 다른 문구에 밀리지 않는다.
const agentAlert = { mode: 'practice', revision: -1, offline: false, subscribe: '', released: '' };

// 해제·장애 문구는 그 revision 동안 유지한다. 같은 revision을 다시 받아도 지우지 않는다 —
// 그러면 방금 왜 풀렸는지가 화면에서 사라진다. 더 큰 revision의 새 강사 명령만 화면을 다시 조용하게 한다.
function alertClearedByRevision(alert, revision) {
  return Number.isSafeInteger(revision) && Number.isSafeInteger(alert?.revision) && revision > alert.revision;
}

// 해제 문구에는 모드 접두사를 붙이지 않는다. 이미 잠금이 풀린 상태라 '입력 차단 중'을 덧붙이면
// 학생에게 거짓을 말한다.
function agentOverlayText(alert) {
  if (alert?.released) return alert.released;
  const fault = alert?.offline ? AGENT_OFFLINE_TEXT : alert?.subscribe || '';
  if (!fault) return '';
  return alert.mode && alert.mode !== 'practice' ? `${agentStatusText(alert.mode)} · ${fault}` : fault;
}

function renderAgentAlert() {
  const el = $('agent-status');
  if (!el) return;
  const text = agentOverlayText(agentAlert);
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function latchAgentRelease(text) {
  agentAlert.released = text || '';
  agentAlert.subscribe = '';
  renderAgentAlert();
}

function setAgentSubscribeAlert(text) {
  agentAlert.subscribe = text || '';
  renderAgentAlert();
}

function stopInboundStats() {
  if (inboundStatsTimer) clearInterval(inboundStatsTimer);
  inboundStatsTimer = null;
  inboundProgress = null;
}

function declareFreeze(generation) {
  if (mediaFrozen || generation !== subscriptionGeneration) return;
  mediaFrozen = true;
  agentMediaReady = false;
  // pulse(false)로 즉시 알려 main의 250ms watchdog이 다음 tick에 LOCK 기록을 멈추게 한다.
  api.pulse(false);
  stopSubscription();
  api.reportMediaFailure();
  latchAgentRelease(`강사 화면 신호가 ${FREEZE_MS / 1_000}초 이상 멈춰 입력 차단을 해제했습니다. 강사의 새 명령을 기다립니다.`);
}

// 학생 쪽 수신 통계는 계속 읽지만 화면에는 올리지 않는다. 폴링의 목적은 표시가 아니라 프리즈 감지다.
function startInboundStats(pc, generation) {
  stopInboundStats();
  inboundStatsTimer = setInterval(async () => {
    if (generation !== subscriptionGeneration || subscribing !== pc) return stopInboundStats();
    let sample;
    try { sample = inboundVideoSample(collectStats(await pc.getStats()), performance.now()); }
    catch { return; }
    if (!sample || generation !== subscriptionGeneration || mediaFrozen) return;
    inboundProgress = evaluateVideoProgress(inboundProgress, sample);
    if (inboundProgress.frozen) declareFreeze(generation);
  }, INBOUND_STATS_MS);
}

function cancelResubscribe() {
  if (resubscribeTimer) clearTimeout(resubscribeTimer);
  resubscribeTimer = null;
}

// 해제된 revision을 되살리지 않는다. 재시도는 서버가 마지막으로 보낸 상태만 근거로 하고,
// 비상 해제 뒤 main이 내려보내는 practice/stream:null 상태가 도착하면 즉시 멈춘다.
function scheduleResubscribe(reason) {
  if (resubscribeTimer) return;
  if (!shouldResubscribe(agentState, resubscribeAttempts)) {
    setAgentSubscribeAlert(`영상 연결 실패 · 강사에게 알려주세요 (${reason})`);
    return;
  }
  const attempt = resubscribeAttempts + 1;
  setAgentSubscribeAlert(`영상 재연결 시도 ${attempt}/${MAX_RESUBSCRIBE_ATTEMPTS}`);
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    resubscribeAttempts = attempt;
    if (!shouldResubscribe(agentState, attempt - 1)) return;
    // addRemoteTrack은 이미 같은 트랙을 받고 있으면 undefined를 반환한다.
    Promise.resolve(addRemoteTrack(agentState.stream)).catch((error) => scheduleResubscribe(error.message));
  }, RESUBSCRIBE_BACKOFF_MS[resubscribeAttempts]);
}

function addRemoteTrack(streamInfo) {
  const key = `${streamInfo.sessionId}:${streamInfo.trackName}`;
  if (key === lastStreamKey && subscribing && subscribing.connectionState !== 'failed') return;
  if (key === pendingStreamKey && subscriptionPromise) return subscriptionPromise;
  stopSubscription();
  const generation = subscriptionGeneration;
  pendingStreamKey = key;
  subscriptionPromise = (async () => {
    const pc = new RTCPeerConnection(await iceConfiguration());
    if (generation !== subscriptionGeneration) return pc.close();
    subscribing = pc;
    pc.ontrack = (event) => {
      if (generation !== subscriptionGeneration) return;
      $('remote-video').srcObject = event.streams[0] || new MediaStream([event.track]);
      $('agent-empty').classList.add('hidden');
      agentMediaReady = true;
      mediaFrozen = false;
      resubscribeAttempts = 0;
      // 영상이 붙은 순간이 정상 상태다. 재시도 안내를 지워 학생 화면을 다시 조용하게 만든다.
      setAgentSubscribeAlert('');
      api.pulse(true);
      startInboundStats(pc, generation);
    };
    try {
      // 학생도 세션 생성 시점에 offer를 내야 한다. 받기만 하는 쪽이라 recvonly 트랜시버로 offer를 만든다.
      pc.addTransceiver('video', { direction: 'recvonly' });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc);
      if (generation !== subscriptionGeneration) return pc.close();
      const session = assertRtc(await api.createRtcSession(sessionCreationBody(pc.localDescription)), '수신 RTC 세션 생성');
      if (!session.sessionId) throw new Error('Cloudflare RTC 세션 ID를 받지 못했습니다.');
      if (generation !== subscriptionGeneration) return pc.close();
      const sessionStep = await applyNegotiation(pc, session.sessionId, session.sessionDescription, '수신 세션 SDP 확정');
      if (generation !== subscriptionGeneration) return pc.close();
      const result = assertRtc(await api.addRtcTracks(session.sessionId, remoteTrackRequest(streamInfo)), '원격 트랙 구독');
      if (generation !== subscriptionGeneration) return pc.close();
      const trackStep = await applyNegotiation(pc, session.sessionId, result.sessionDescription, '수신 SDP 확정');
      if (generation !== subscriptionGeneration) return pc.close();
      if (sessionStep === 'none' && trackStep === 'none') throw new Error('Cloudflare가 수신 SDP를 반환하지 않았습니다.');
      lastStreamKey = key;
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' && generation === subscriptionGeneration) {
          agentMediaReady = false;
          api.pulse(false);
          api.reportMediaFailure();
        }
      });
    } catch (error) {
      pc.close();
      if (subscribing === pc) subscribing = null;
      throw error;
    }
  })().finally(() => {
    if (pendingStreamKey === key) {
      pendingStreamKey = null;
      subscriptionPromise = null;
    }
  });
  return subscriptionPromise;
}

function stopSubscription() {
  subscriptionGeneration += 1;
  agentMediaReady = false;
  cancelResubscribe();
  stopInboundStats();
  if (subscribing) subscribing.close();
  subscribing = null;
  lastStreamKey = null;
  pendingStreamKey = null;
  const video = $('remote-video');
  if (video?.srcObject) video.srcObject.getTracks().forEach((track) => track.stop());
  if (video) video.srcObject = null;
  $('agent-empty')?.classList.remove('hidden');
}

// 고른 화면(selected)과 지금 실제로 나가는 화면(live)은 다를 수 있다. 둘을 같은 표시로 묶으면
// 강사가 교체가 끝났는지 알 수 없다.
function sourceStateClass(sourceId, selectedId, liveId) {
  return `source${sourceId === selectedId ? ' selected' : ''}${liveId && sourceId === liveId ? ' live' : ''}`;
}

function markSources() {
  const live = publishing?.sourceId || null;
  $('sources')?.querySelectorAll('.source').forEach((item) => {
    item.className = sourceStateClass(item.dataset.sourceId, selectedSourceId, live);
  });
}

function sourceSwitchMessage(name) {
  return `송출 화면을 '${name}'(으)로 바꿨습니다. 수업 모드와 입력 잠금은 그대로입니다.`;
}

function publicationCancelled(publication, connectionGeneration) {
  return publishing !== publication || !controllerOnline || connectionGeneration !== controllerConnectionGeneration;
}

// ended 리스너는 강사가 OS 공유 UI에서 공유를 끊었을 때 수업을 실습으로 내리는 장치다. 화면 교체로
// 헌 트랙을 stop()하면 같은 ended가 발생하므로, 반드시 리스너를 새 트랙으로 옮긴 다음에만 헌 트랙을
// 멈춘다. 순서가 뒤집히면 화면만 바꿨는데 수업 전체가 실습으로 풀린다.
// descriptor와 activationRevision은 건드리지 않는다 — 발행 신분과 revision이 그대로여야
// 화면 교체가 잠금을 다시 걸거나 해제된 잠금을 되살리지 못한다.
function adoptPublishedTrack(publication, sourceId, stream, track) {
  const previous = { stream: publication.stream, track: publication.track };
  previous.track.removeEventListener('ended', publication.endedHandler);
  track.addEventListener('ended', publication.endedHandler, { once: true });
  publication.sourceId = sourceId;
  publication.stream = stream;
  publication.track = track;
  previous.stream.getTracks().forEach((item) => item.stop());
  return previous;
}

// 송출을 끊지 않고 sender의 트랙만 바꾼다. 재협상도 새 SFU 세션도 setMode도 없어 수업 revision이
// 변하지 않는다. cancelled는 기본값으로 실제 취소 조건을 읽고, 테스트에서만 주입한다.
async function replaceLiveTrack(publication, sourceId, cancelled = () => publicationCancelled(publication, controllerConnectionGeneration)) {
  if (typeof publication?.sender?.replaceTrack !== 'function') {
    throw new Error('이 실행 환경은 송출 중 화면 교체를 지원하지 않습니다. 실습 모드로 내린 뒤 다시 송출하세요.');
  }
  const video = videoConfig();
  await api.selectCaptureSource(sourceId);
  let stream;
  try {
    if (cancelled()) throw new Error(SWITCH_CANCELLED);
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { height: { max: video.maxHeight }, frameRate: { ideal: video.maxFps, max: video.maxFps } },
      audio: false
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('선택한 화면에서 영상 트랙을 얻지 못했습니다.');
    await applyTrackCaps(track, video);
    if (cancelled()) throw new Error(SWITCH_CANCELLED);
    await publication.sender.replaceTrack(track);
    // replaceTrack 뒤에도 한 번 더 확인한다. 그 사이 재연결이 stopPublishing()을 지나갔다면
    // 헌 트랙은 이미 멈췄고 새 트랙만 남아 강사 화면을 계속 캡처하게 된다.
    if (cancelled()) throw new Error(SWITCH_CANCELLED);
    adoptPublishedTrack(publication, sourceId, stream, track);
  } catch (error) {
    // 교체 실패는 학생 화면을 끊지 않는다. 새로 딴 스트림만 버리고 sender는 헌 트랙을 계속 보낸다.
    stream?.getTracks().forEach((item) => item.stop());
    throw error;
  }
}

async function switchLiveSource(sourceId, name) {
  const publication = publishing;
  if (!publication) throw new Error('송출 중이 아닙니다. 화면을 선택하고 송출 버튼을 누르세요.');
  message('송출 화면을 바꾸고 있습니다…');
  await replaceLiveTrack(publication, sourceId);
  message(sourceSwitchMessage(name));
}

function selectSource(source) {
  // 교체 중에는 선택도 받지 않는다. 받아 주면 아무 일도 하지 않은 클릭이 선택 표시만 옮겨
  // 강사가 지금 무엇이 나가는지 헷갈리게 된다.
  if (sourceSwitching) return;
  selectedSourceId = source.id;
  markSources();
  if (!publishing || publishing.sourceId === source.id) return;
  sourceSwitching = true;
  withBusy(() => switchLiveSource(source.id, source.name)).finally(() => {
    sourceSwitching = false;
    markSources();
  });
}

async function refreshSources() {
  const container = $('sources');
  container.replaceChildren();
  sources = await api.listCaptureSources();
  const live = publishing?.sourceId || null;
  for (const source of sources) {
    const button = document.createElement('button');
    button.dataset.sourceId = source.id;
    button.className = sourceStateClass(source.id, selectedSourceId, live);
    const image = document.createElement('img');
    image.src = source.thumbnail;
    image.alt = '';
    const name = document.createElement('span');
    name.textContent = source.name;
    const badge = document.createElement('em');
    badge.className = 'live-badge';
    badge.textContent = '송출 중';
    button.append(image, name, badge);
    button.addEventListener('click', () => selectSource(source));
    container.append(button);
  }
}

function showRebroadcastNotice(visible) {
  $('rebroadcast-notice')?.classList.toggle('hidden', !visible);
}

const MODE_LABELS = {
  practice: ['실습 모드', '학생이 각자 노트북을 사용할 수 있습니다.'],
  broadcast: ['화면 보여주기', '강사 화면이 학생 PC에 전체화면으로 표시됩니다. 학생 입력은 막지 않습니다.'],
  lecture: ['이론 모드', '강사 화면을 가리지 않고 보여주면서 학생 입력만 차단합니다.'],
  lock: ['강사 주목', '학생 화면을 가리고 입력을 차단합니다. 학생은 강의실에서 강사를 봅니다.']
};

const COMMAND_MESSAGES = {
  broadcast: '강사 화면을 학생 PC에 표시했습니다. 학생 입력은 자유입니다.',
  lecture: '이론 모드로 전환했습니다. 강사 화면은 그대로 보이고 학생 입력만 차단됩니다.',
  lock: '강사 주목 모드로 전환했습니다. 학생 화면을 가리고 입력을 차단했습니다.'
};

function controllerModeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS.practice;
}

function commandMessage(mode) {
  return COMMAND_MESSAGES[mode] || '명령을 전송했습니다.';
}

function renderControllerState(state) {
  latestControllerState = state;
  const pair = controllerModeLabel(state.mode);
  $('mode-label').textContent = pair[0];
  $('mode-description').textContent = pair[1];
  // 제어 소켓 연결 수만으로 30대 영상 성공을 판단하지 않는다.
  const roster = summarizeRoster(state.students, Date.now());
  $('student-count').textContent = roster.connected;
  $('student-media').textContent = `영상 ${roster.media}`;
  $('connection').textContent = '서버 연결됨';
  $('connection').className = 'status status-online';
  if (shouldStopPublishingForState(state, publishing)) {
    stopPublishing().catch((error) => message(error.message, true));
  }
}

async function withBusy(action) {
  document.querySelectorAll('.action').forEach((button) => { button.disabled = true; });
  try { await action(); } catch (error) { message(error.message, true); }
  finally { document.querySelectorAll('.action').forEach((button) => { button.disabled = false; }); }
}

async function broadcast(mode) {
  message('화면 송출 연결을 준비하고 있습니다…');
  const connectionGeneration = controllerConnectionGeneration;
  const descriptor = await startPublishing();
  const publication = publishing;
  try {
    if (!controllerOnline || connectionGeneration !== controllerConnectionGeneration) {
      throw new Error('서버 연결이 바뀌어 화면 송출 준비를 취소했습니다. 다시 시도하세요.');
    }
    const state = await api.setMode({ mode, stream: descriptor });
    if (publishing !== publication) throw new Error('화면 송출 준비가 취소되었습니다.');
    if (!Number.isSafeInteger(state?.revision)) throw new Error('서버가 유효한 모드 revision을 반환하지 않았습니다.');
    publication.activationRevision = state.revision;
    if (shouldStopPublishingForState(latestControllerState, publication)) {
      await stopPublishing();
      throw new Error('서버 안전 해제가 송출 명령보다 최신이어서 송출을 중단했습니다.');
    }
  } catch (error) {
    if (publishing === publication) await stopPublishing();
    throw error;
  }
  rebroadcastRequired = false;
  showRebroadcastNotice(false);
  message(commandMessage(mode));
}

// background는 강사가 실습 시작을 직접 누른 경우에만 true다. 송출 실패·트랙 종료로 자동 전환된
// 실습에서 창을 내리면 방금 띄운 오류 메시지가 강사 눈에서 사라진다.
async function setPractice({ background = false } = {}) {
  let modeError;
  try { await api.setMode({ mode: 'practice' }); }
  catch (error) { modeError = error; }
  finally { await stopPublishing(); }
  if (modeError) throw modeError;
  rebroadcastRequired = false;
  showRebroadcastNotice(false);
  message('모든 학생 PC를 실습 모드로 전환했습니다.');
  if (background) api.backgroundWindow();
}

function quitReportMessage(result) {
  const notified = Number(result?.notified);
  if (!Number.isInteger(notified) || notified < 0) {
    return '학생 앱에 종료를 전달했지만 전달 대수를 확인하지 못했습니다. 학생 PC를 직접 확인하세요.';
  }
  if (notified === 0) return '종료를 전달할 학생 앱이 없었습니다. 연결된 학생 앱이 없습니다.';
  return `학생 앱 ${notified}대에 종료를 전달했습니다. 강사 앱에서는 다시 실행할 수 없습니다.`;
}

function showQuitConfirm(visible) {
  $('quit-confirm')?.classList.toggle('hidden', !visible);
  $('quit-agents')?.classList.toggle('hidden', visible);
}

async function initController() {
  $('controller').classList.remove('hidden');
  $('startup').checked = config.autoLaunch;
  $('startup').addEventListener('change', async (event) => {
    try { event.target.checked = await api.setStartup(event.target.checked); }
    catch (error) { message(error.message, true); }
  });
  $('refresh-sources').addEventListener('click', () => refreshSources().catch((error) => message(error.message, true)));
  $('broadcast').addEventListener('click', () => withBusy(() => broadcast('broadcast')));
  $('lecture').addEventListener('click', () => withBusy(() => broadcast('lecture')));
  $('lock').addEventListener('click', () => withBusy(() => broadcast('lock')));
  $('practice').addEventListener('click', () => withBusy(() => setPractice({ background: true })));
  // 30대를 한꺼번에 멈추는 명령이라 확인을 받는다. window.confirm은 렌더러를 동기 차단해
  // pulse가 끊기고 4초 뒤 heartbeat가 멈춰 서버 lease까지 만료되므로 쓰지 않는다.
  $('quit-agents').addEventListener('click', () => showQuitConfirm(true));
  $('quit-cancel').addEventListener('click', () => showQuitConfirm(false));
  $('quit-proceed').addEventListener('click', () => withBusy(async () => {
    showQuitConfirm(false);
    message(quitReportMessage(await api.quitAgents()));
  }));
  api.onState(renderControllerState);
  api.onConnection((state) => {
    if (state.online) controllerOnline = true;
    else {
      controllerOnline = false;
      controllerConnectionGeneration += 1;
      if (publishing) {
        // 재연결만으로 송출이 살아나지 않는다. 강사가 직접 다시 송출해야 한다는 사실을 남긴다.
        rebroadcastRequired = true;
        stopPublishing().catch((error) => message(error.message, true));
      }
    }
    showRebroadcastNotice(state.online && rebroadcastRequired);
    $('connection').textContent = state.online ? '서버 연결됨' : '연결 끊김';
    $('connection').className = `status ${state.online ? 'status-online' : 'status-offline'}`;
    if (!state.online && state.message) message(state.message, true);
  });
  api.stateReady();
  await refreshSources();
}

// lecture는 강사 화면을 가려서는 안 되므로 아무 오버레이도 띄우지 않는다. lock의 차단막은 설계상
// 화면을 덮으므로 그 안의 비상 해제 안내는 가리는 것이 없다 — 단축키가 화면에 남는 유일한 모드다.
// 실제 입력 차단은 오버레이가 아니라 main의 locksInput 경로와 네이티브 InputGuard가 한다.
function renderAgentMode(command) {
  const locked = command.mode === 'lock';
  $('input-shield').classList.toggle('hidden', !locked);
  if (alertClearedByRevision(agentAlert, command.revision)) latchAgentRelease('');
  if (Number.isSafeInteger(command.revision)) agentAlert.revision = command.revision;
  agentAlert.mode = command.mode;
  renderAgentAlert();
  if (locked) $('input-shield').focus();
  if (command.mode === 'practice') stopSubscription();
}

async function handleAgentState(state) {
  agentState = state;
  const key = state.stream ? `${state.stream.sessionId}:${state.stream.trackName}` : null;
  if (key !== agentStreamKey) {
    agentStreamKey = key;
    resubscribeAttempts = 0;
    cancelResubscribe();
  }
  renderAgentMode(state);
  if (state.mode === 'practice' || !state.stream) return;
  try { await addRemoteTrack(state.stream); }
  catch (error) { scheduleResubscribe(error.message); }
}

async function initAgent() {
  $('agent').classList.remove('hidden');
  api.onState(handleAgentState);
  api.onAgentMode(renderAgentMode);
  api.onNotice((text) => { latchAgentRelease(text); stopSubscription(); });
  api.onConnection((state) => { agentAlert.offline = state.online !== true; renderAgentAlert(); });
  api.stateReady();
}

(async () => {
  config = await api.getConfig();
  api.pulse(config.role === 'controller' ? true : agentMediaReady);
  setInterval(() => api.pulse(config.role === 'controller' ? true : agentMediaReady), 1_000);
  if (config.role === 'controller') await initController();
  else await initAgent();
})().catch((error) => {
  document.body.textContent = `앱 초기화 실패: ${error.message}`;
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    shouldStopPublishingForState,
    summarizeRoster,
    shouldResubscribe,
    normalizeIceServers,
    plainDescription,
    sessionCreationBody,
    localTrackRequest,
    remoteTrackRequest,
    negotiationStep,
    videoProgressValue,
    evaluateVideoProgress,
    outboundVideoSample,
    inboundVideoSample,
    formatMediaLine,
    lossPercent,
    deltaKbps,
    controllerModeLabel,
    commandMessage,
    agentStatusText,
    agentOverlayText,
    alertClearedByRevision,
    quitReportMessage,
    sourceStateClass,
    sourceSwitchMessage,
    adoptPublishedTrack,
    replaceLiveTrack,
    MODE_LABELS,
    AGENT_STATUS,
    AGENT_OFFLINE_TEXT,
    SWITCH_CANCELLED,
    FREEZE_MS,
    MAX_RESUBSCRIBE_ATTEMPTS,
    RESUBSCRIBE_BACKOFF_MS,
    DEFAULT_VIDEO
  };
}
