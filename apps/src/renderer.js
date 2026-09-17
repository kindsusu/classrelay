'use strict';

const api = window.classroom;
const $ = (id) => document.getElementById(id);
let config;
let sources = [];
let selectedSourceId = null;
let publishing = null;
let subscribing = null;
let lastStreamKey = null;
let pendingStreamKey = null;
let subscriptionPromise = null;
let subscriptionGeneration = 0;
let agentMediaReady = false;

function message(text, isError = false) {
  const el = $('message');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#ff9994' : '#ffcc74';
}

async function iceConfiguration() {
  try {
    const result = await api.getIce();
    return { iceServers: Array.isArray(result?.iceServers) ? result.iceServers : [] };
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

async function stopPublishing() {
  if (!publishing) return;
  publishing.stream.getTracks().forEach((track) => track.stop());
  publishing.pc.close();
  publishing = null;
}

async function startPublishing() {
  if (publishing) return publishing.descriptor;
  if (!selectedSourceId) throw new Error('먼저 송출할 화면을 선택하세요.');
  await api.selectCaptureSource(selectedSourceId);
  let stream;
  let pc;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 20 } }, audio: false });
    pc = new RTCPeerConnection(await iceConfiguration());
    const track = stream.getVideoTracks()[0];
    const trackName = `screen-${config.deviceId}-${Date.now()}`;
    const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    const session = assertRtc(await api.createRtcSession({}), 'RTC 세션 생성');
    if (!session.sessionId) throw new Error('Cloudflare RTC 세션 ID를 받지 못했습니다.');
    const result = assertRtc(await api.addRtcTracks(session.sessionId, {
      tracks: [{ location: 'local', kind: 'video', mid: transceiver.mid, trackName }],
      sessionDescription: plainDescription(pc.localDescription)
    }), '화면 트랙 발행');
    if (result.sessionDescription) await pc.setRemoteDescription(result.sessionDescription);
    track.addEventListener('ended', () => setPractice().catch(() => {}), { once: true });
    const descriptor = { sessionId: session.sessionId, trackName: result.tracks?.[0]?.trackName || trackName };
    publishing = { pc, stream, descriptor };
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
      api.pulse(true);
    };
    try {
      const session = assertRtc(await api.createRtcSession({}), '수신 RTC 세션 생성');
      if (generation !== subscriptionGeneration) return pc.close();
      const result = assertRtc(await api.addRtcTracks(session.sessionId, {
        tracks: [{ location: 'remote', sessionId: streamInfo.sessionId, trackName: streamInfo.trackName }]
      }), '원격 트랙 구독');
      if (!result.sessionDescription) throw new Error('Cloudflare가 수신 SDP를 반환하지 않았습니다.');
      await pc.setRemoteDescription(result.sessionDescription);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIceComplete(pc);
      if (generation !== subscriptionGeneration) return pc.close();
      assertRtc(await api.renegotiateRtc(session.sessionId, { sessionDescription: plainDescription(pc.localDescription) }), '수신 SDP 확정');
      lastStreamKey = key;
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' && generation === subscriptionGeneration) {
          agentMediaReady = false;
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
  if (subscribing) subscribing.close();
  subscribing = null;
  lastStreamKey = null;
  pendingStreamKey = null;
  const video = $('remote-video');
  if (video?.srcObject) video.srcObject.getTracks().forEach((track) => track.stop());
  if (video) video.srcObject = null;
  $('agent-empty')?.classList.remove('hidden');
}

async function refreshSources() {
  const container = $('sources');
  container.replaceChildren();
  sources = await api.listCaptureSources();
  for (const source of sources) {
    const button = document.createElement('button');
    button.className = `source${source.id === selectedSourceId ? ' selected' : ''}`;
    const image = document.createElement('img');
    image.src = source.thumbnail;
    image.alt = '';
    const name = document.createElement('span');
    name.textContent = source.name;
    button.append(image, name);
    button.addEventListener('click', () => {
      selectedSourceId = source.id;
      container.querySelectorAll('.source').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
    });
    container.append(button);
  }
}

function renderControllerState(state) {
  const labels = {
    practice: ['실습 모드', '학생이 각자 노트북을 사용할 수 있습니다.'],
    broadcast: ['화면 송출 중', '강사 화면이 학생 PC에 전체화면으로 표시됩니다.'],
    lock: ['이론교육 잠금', '학생 PC에 입력 차단막이 표시됩니다.']
  };
  const pair = labels[state.mode] || labels.practice;
  $('mode-label').textContent = pair[0];
  $('mode-description').textContent = pair[1];
  const cutoff = Date.now() - 15_000;
  $('student-count').textContent = Array.isArray(state.students) ? state.students.filter((student) => Number(student.lastSeen) >= cutoff).length : 0;
  $('connection').textContent = '서버 연결됨';
  $('connection').className = 'status status-online';
}

async function controllerPoll() {
  try {
    await api.heartbeat();
    renderControllerState(await api.getState());
  } catch (error) {
    $('connection').textContent = '연결 끊김';
    $('connection').className = 'status status-offline';
    message(error.message, true);
  }
}

async function withBusy(action) {
  document.querySelectorAll('.action').forEach((button) => { button.disabled = true; });
  try { await action(); } catch (error) { message(error.message, true); }
  finally { document.querySelectorAll('.action').forEach((button) => { button.disabled = false; }); }
}

async function broadcast(mode) {
  message('화면 송출 연결을 준비하고 있습니다…');
  const descriptor = await startPublishing();
  await api.setMode({ mode, stream: descriptor });
  message(mode === 'lock' ? '입력 차단막을 표시했습니다.' : '화면 송출을 시작했습니다.');
  await controllerPoll();
}

async function setPractice() {
  let modeError;
  try { await api.setMode({ mode: 'practice' }); }
  catch (error) { modeError = error; }
  finally { await stopPublishing(); }
  if (modeError) throw modeError;
  message('모든 학생 PC를 실습 모드로 전환했습니다.');
  await controllerPoll();
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
  $('lock').addEventListener('click', () => withBusy(() => broadcast('lock')));
  $('practice').addEventListener('click', () => withBusy(setPractice));
  await Promise.allSettled([refreshSources(), controllerPoll()]);
  setInterval(controllerPoll, 3_000);
}

function renderAgentMode(command) {
  $('input-shield').classList.toggle('hidden', command.mode !== 'lock');
  $('agent-status').textContent = command.mode === 'lock' ? '입력 차단 중 · 비상 해제 Ctrl+Shift+F12' : '강사 화면 송출 중';
  if (command.mode === 'lock') $('input-shield').focus();
  if (command.mode === 'practice') stopSubscription();
}

async function handleAgentState(state) {
  renderAgentMode(state);
  if (state.mode !== 'practice' && state.stream) {
    try { await addRemoteTrack(state.stream); }
    catch (error) { $('agent-status').textContent = `영상 연결 재시도 대기: ${error.message}`; }
  }
}

async function initAgent() {
  $('agent').classList.remove('hidden');
  api.onState(handleAgentState);
  api.onAgentMode(renderAgentMode);
  api.onNotice((text) => { $('agent-status').textContent = text; stopSubscription(); });
  api.onConnection((state) => { if (!state.online) $('agent-status').textContent = '서버 재연결 중 · 15초 후 자동 해제'; });
  try { await handleAgentState(await api.getState()); } catch { /* main process reconnect loop owns recovery */ }
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
