'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { SafetyState, ALLOWED_MODES, locksInput } = require('./safety.cjs');
const { ControlSocket } = require('./control-socket.cjs');

let mainWindow;
let config;
let selectedSourceId = null;
let stopping = false;
let watchdogTimer;
let controlSocket;
let latestState;
let latestConnectionState;
let rendererStateReady = false;
let loadedConfigPath;
let inputGuard;
let inputGuardBuffer = '';
let lastRendererPulse = 0;
let rendererMediaReady = false;
let nativeGuardUnavailable = false;
const safety = new SafetyState();

const VIDEO_DEFAULTS = Object.freeze({ maxHeight: 720, maxFps: 15, maxBitrateKbps: 2_000 });
const VIDEO_RANGES = Object.freeze({ maxHeight: [360, 1440], maxFps: [5, 30], maxBitrateKbps: [300, 8_000] });

function resolveVideoConfig(raw) {
  if (raw === undefined || raw === null) return { ...VIDEO_DEFAULTS };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('video는 객체여야 합니다.');
  // 오타 난 항목을 조용히 무시하면 대역폭 상한이 걸리지 않은 채 운영된다.
  const unknown = Object.keys(raw).filter((key) => !(key in VIDEO_DEFAULTS));
  if (unknown.length) throw new Error(`video에 알 수 없는 항목이 있습니다: ${unknown.join(', ')}`);
  const resolved = { ...VIDEO_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(VIDEO_RANGES)) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || raw[key] < min || raw[key] > max) {
      throw new Error(`video.${key}는 ${min}~${max} 사이 정수여야 합니다.`);
    }
    resolved[key] = raw[key];
  }
  return resolved;
}

const API_ERROR_MAX = 160;
// SDP 특징 줄. 오류 본문이 SDP를 되돌려주더라도 UI·메시지 줄로 새어 나가면 안 된다.
const SDP_MARKER = /\bv=0\b|\bo=[-\w]+ \d|\bm=(?:video|audio|application)\b|\ba=(?:fingerprint|ice-ufrag|ice-pwd|candidate|setup|mid|rtpmap)\b/i;
// 32자 이상 이어지는 불투명 토큰(키·자격증명 후보)은 값을 보여주지 않는다.
const OPAQUE_RUN = /[A-Za-z0-9+/=_-]{32,}/g;

function apiErrorDetail(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || SDP_MARKER.test(text)) return null;
  const masked = text.replace(OPAQUE_RUN, '[생략]');
  return masked.length > API_ERROR_MAX ? `${masked.slice(0, API_ERROR_MAX)}…` : masked;
}

// SFU 오류 본문은 error가 아니라 errorCode/errorDescription을 쓴다. error만 읽으면 400의 실제
// 이유(decoding_error 등)가 사라져 운영자가 원인을 볼 수 없다. 대신 업스트림 본문을 그대로
// 흘리지 않도록 알려진 필드만, 길이를 제한해, SDP·자격증명 후보를 지운 뒤 붙인다.
function describeApiError(status, body) {
  const detail = [apiErrorDetail(body?.errorCode), apiErrorDetail(body?.errorDescription) || apiErrorDetail(body?.error)]
    .filter((part) => part)
    .join(': ');
  return detail ? `서버 오류 ${status} · ${detail}` : `서버 오류 ${status}`;
}

function readConfig() {
  const configPath = process.env.CLASSROOM_CONFIG
    ? path.resolve(process.env.CLASSROOM_CONFIG)
    : path.join(app.getPath('userData'), 'config.json');
  loadedConfigPath = configPath;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`설정 파일을 읽을 수 없습니다: ${configPath}\n${error.message}`); }
  if (!['controller', 'agent'].includes(parsed.role)) throw new Error('role은 controller 또는 agent여야 합니다.');
  if (!/^https:\/\//i.test(parsed.backendUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(parsed.backendUrl)) {
    throw new Error('backendUrl은 HTTPS여야 합니다(로컬 개발 localhost 예외).');
  }
  if (typeof parsed.token !== 'string' || parsed.token.length < 8) throw new Error('token이 없거나 너무 짧습니다.');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(parsed.deviceId || '')) throw new Error('deviceId 형식이 올바르지 않습니다.');
  return { ...parsed, backendUrl: parsed.backendUrl.replace(/\/$/, ''), video: resolveVideoConfig(parsed.video) };
}

function apiHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
    'X-Device-Id': config.deviceId,
    ...extra
  };
}

async function api(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response;
  let text;
  try {
    response = await fetch(`${config.backendUrl}${pathname}`, {
      ...options,
      headers: apiHeaders(options.headers),
      redirect: 'error',
      signal: controller.signal
    });
    text = await response.text();
  } finally { clearTimeout(timeout); }
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { error: text }; }
  }
  if (!response.ok) throw new Error(describeApiError(response.status, body));
  return body;
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function sanitizedState(state) {
  const mode = safety.effectiveMode();
  return { ...state, mode, stream: mode === 'practice' ? null : state.stream };
}

function writeInputGuard(command) {
  if (inputGuard?.stdin?.writable) inputGuard.stdin.write(`${command}\n`);
}

function configureStartup(enabled) {
  if (process.platform !== 'win32') return false;
  if (enabled) {
    const persistentPath = path.join(app.getPath('userData'), 'config.json');
    if (path.resolve(loadedConfigPath) !== path.resolve(persistentPath)) {
      fs.mkdirSync(path.dirname(persistentPath), { recursive: true });
      fs.copyFileSync(loadedConfigPath, persistentPath);
      loadedConfigPath = persistentPath;
    }
  }
  try {
    const persisted = JSON.parse(fs.readFileSync(loadedConfigPath, 'utf8'));
    persisted.autoLaunch = Boolean(enabled);
    fs.writeFileSync(loadedConfigPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    config.autoLaunch = Boolean(enabled);
  } catch (error) {
    throw new Error(`자동 실행 설정을 저장하지 못했습니다: ${error.message}`);
  }
  const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: executable, args });
  return app.getLoginItemSettings({ path: executable, args }).openAtLogin;
}

function startupEnabled() {
  if (process.platform !== 'win32') return false;
  const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  return app.getLoginItemSettings({ path: executable, args }).openAtLogin;
}

function startInputGuard() {
  if (process.platform !== 'win32' || config.role !== 'agent' || config.nativeInputLock !== true) return;
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'InputGuard.exe')
    : path.resolve(__dirname, '..', '..', 'native-input', 'dist', 'InputGuard.exe');
  if (!fs.existsSync(executable)) {
    nativeGuardUnavailable = true;
    dialog.showErrorBox('입력 보호 비활성', 'InputGuard.exe를 찾지 못했습니다. 안전을 위해 잠금 명령은 실행하지 않습니다.');
    return;
  }
  inputGuard = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  inputGuard.stdout.setEncoding('utf8');
  inputGuard.stdout.on('data', (chunk) => {
    inputGuardBuffer += chunk;
    const lines = inputGuardBuffer.split(/\r?\n/);
    inputGuardBuffer = lines.pop() || '';
    if (lines.some((line) => ['UNLOCKED emergency', 'UNLOCKED lease-expired'].includes(line.trim()))) emergencyUnlock('네이티브 fail-safe 해제');
  });
  inputGuard.stdin.on('error', (error) => {
    if (!stopping) {
      nativeGuardUnavailable = true;
      emergencyUnlock(`네이티브 입력 보호 통신 오류: ${error.code || error.message}`);
    }
  });
  inputGuard.stderr.on('data', (chunk) => send('agent:notice', `입력 보호 도구: ${String(chunk).trim()}`));
  inputGuard.on('error', (error) => {
    nativeGuardUnavailable = true;
    emergencyUnlock('네이티브 입력 보호 시작 실패');
    dialog.showErrorBox('입력 보호 오류', `안전을 위해 잠금을 해제했습니다.\n${error.message}`);
  });
  inputGuard.on('exit', () => {
    inputGuard = null;
    if (!stopping) {
      nativeGuardUnavailable = true;
      emergencyUnlock('네이티브 입력 보호 종료');
    }
  });
}

function applyAgentWindow() {
  if (config.role !== 'agent' || !mainWindow || mainWindow.isDestroyed()) return;
  const mode = safety.effectiveMode();
  if (mode === 'practice') {
    mainWindow.setKiosk(false);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.setFullScreen(true);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    // 비실습 모드는 전부 발표 모드처럼 작업 표시줄까지 덮는다. kiosk는 창 크롬을 가릴 뿐
    // 입력 잠금이 아니다. 실제 입력 차단은 locksInput(mode)와 네이티브 InputGuard가 담당한다.
    mainWindow.setKiosk(true);
    mainWindow.focus();
  }
  send('agent:mode', { mode, revision: safety.revision });
}

function emergencyUnlock(reason = 'shortcut') {
  if (config.role !== 'agent') return;
  safety.emergencyUnlock();
  applyAgentWindow();
  if (latestState && rendererStateReady) send('state:update', sanitizedState(latestState));
  send('agent:notice', `비상 해제됨 (${reason}). 새 명령 전까지 유지됩니다.`);
}

// 종료 경로는 하나만 둔다. stopping을 먼저 세워 뒤따르는 창 닫기·InputGuard 종료가 크래시로
// 오인돼 emergencyUnlock을 부르지 않게 하고, 그 다음 입력 보호를 UNLOCK으로 되돌린다.
// 두 번 불려도 안전해야 한다 — handleQuitCommand가 부르고 app.quit()이 before-quit으로 또 부른다.
function teardown() {
  stopping = true;
  controlSocket?.stop();
  clearInterval(watchdogTimer);
  watchdogTimer = undefined;
  if (mainWindow && !mainWindow.isDestroyed() && config?.role === 'agent') {
    mainWindow.setKiosk(false);
    mainWindow.setAlwaysOnTop(false);
  }
  writeInputGuard('UNLOCK');
  inputGuard?.stdin?.end();
}

// 강사의 학생 앱 종료 명령. 입력 보호 해제와 kiosk 해제가 끝난 뒤에만 종료한다.
function handleQuitCommand() {
  if (config?.role !== 'agent') return;
  teardown();
  send('agent:notice', '강사가 앱 종료를 요청했습니다. 입력 차단을 해제하고 종료합니다.');
  app.quit();
}

function acceptControlState(state) {
  if (config.role === 'agent') {
    if (!safety.accept(state)) return;
    if (nativeGuardUnavailable && locksInput(state.mode)) safety.emergencyUnlock();
    applyAgentWindow();
    latestState = sanitizedState(state);
  } else {
    latestState = state;
  }
  if (rendererStateReady) send('state:update', latestState);
}

function startControlSocket() {
  controlSocket = new ControlSocket({
    WebSocket,
    backendUrl: config.backendUrl,
    headers: apiHeaders(),
    canHeartbeat: () => config.role !== 'controller' || performance.now() - lastRendererPulse < 4_000,
    mediaReady: () => (config.role === 'agent' ? rendererMediaReady : undefined),
    onState: acceptControlState,
    onQuit: handleQuitCommand,
    onConnection: (state) => {
      latestConnectionState = state;
      if (rendererStateReady) send('connection:update', state);
    }
  });
  controlSocket.start();
}

function setupDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((item) => item.id === selectedSourceId);
      if (!source) return callback({});
      callback({ video: source });
    } catch { callback({}); }
  });
}

function createWindow() {
  const agent = config.role === 'agent';
  mainWindow = new BrowserWindow({
    width: agent ? 1280 : 1080,
    height: agent ? 720 : 760,
    show: !agent,
    backgroundColor: '#07111f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      backgroundThrottling: false
    }
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('render-process-gone', () => emergencyUnlock('화면 프로세스 종료'));
  mainWindow.webContents.on('did-start-loading', () => {
    lastRendererPulse = 0;
    rendererStateReady = false;
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  if (agent) mainWindow.on('close', (event) => { if (!stopping) { event.preventDefault(); emergencyUnlock('창 닫기 요청'); } });
}

function registerIpc() {
  ipcMain.handle('config:get-public', () => ({ role: config.role, deviceId: config.deviceId, backendUrl: config.backendUrl, autoLaunch: startupEnabled(), video: { ...(config.video || VIDEO_DEFAULTS) } }));
  ipcMain.on('renderer:pulse', (_event, mediaReady) => {
    lastRendererPulse = performance.now();
    rendererMediaReady = mediaReady === true;
  });
  ipcMain.on('state:ready', () => {
    rendererStateReady = true;
    if (latestState) send('state:update', config.role === 'agent' ? sanitizedState(latestState) : latestState);
    if (latestConnectionState) send('connection:update', latestConnectionState);
  });
  ipcMain.on('agent:media-failed', () => {
    if (config.role === 'agent') emergencyUnlock('영상 연결 실패');
  });
  ipcMain.handle('startup:set', (_event, enabled) => {
    return configureStartup(enabled);
  });
  ipcMain.handle('capture:list', async () => {
    if (config.role !== 'controller') throw new Error('controller 전용 기능입니다.');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((source) => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
  });
  ipcMain.handle('capture:select', (_event, sourceId) => {
    if (config.role !== 'controller' || typeof sourceId !== 'string' || sourceId.length > 256) throw new Error('잘못된 화면 선택입니다.');
    selectedSourceId = sourceId;
    return true;
  });
  ipcMain.handle('api:mode', (_event, payload) => {
    if (config.role !== 'controller' || !payload || !ALLOWED_MODES.has(payload.mode)) throw new Error('허용되지 않은 모드입니다.');
    const body = { mode: payload.mode };
    if (payload.stream && typeof payload.stream.sessionId === 'string' && typeof payload.stream.trackName === 'string') body.stream = payload.stream;
    return api('/api/mode', { method: 'POST', body: JSON.stringify(body) });
  });
  ipcMain.handle('api:quit-agents', () => {
    if (config.role !== 'controller') throw new Error('controller 전용 기능입니다.');
    return api('/api/agents/quit', { method: 'POST', body: JSON.stringify({}) });
  });
  // 실습 시작 직후 강사가 자기 PC를 바로 쓰게 창을 내린다. 트레이 아이콘이 없으므로 hide()가
  // 아니라 minimize()만 쓴다 — 작업 표시줄에서 항상 되돌릴 수 있어야 한다.
  ipcMain.on('window:background', () => {
    if (config.role !== 'controller' || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.minimize();
  });
  ipcMain.handle('api:ice', () => api('/api/ice'));
  ipcMain.handle('rtc:session', (_event, body) => {
    // 라이브 SFU는 세션 생성에서 offer를 요구한다. 빈 body는 업스트림 400으로만 끝나므로 여기서 막는다.
    const description = body?.sessionDescription;
    if (typeof description?.type !== 'string' || typeof description?.sdp !== 'string') throw new Error('RTC 세션 생성 요청에 SDP가 없습니다.');
    return api('/api/rtc/sessions', { method: 'POST', body: JSON.stringify(body) });
  });
  ipcMain.handle('rtc:tracks', (_event, sessionId, body) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || '') || !body || !Array.isArray(body.tracks)) throw new Error('잘못된 RTC 요청입니다.');
    return api(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/tracks`, { method: 'POST', body: JSON.stringify(body) });
  });
  ipcMain.handle('rtc:renegotiate', (_event, sessionId, body) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || '') || !body) throw new Error('잘못된 RTC 요청입니다.');
    return api(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/renegotiate`, { method: 'PUT', body: JSON.stringify(body) });
  });
}

app.whenReady().then(() => {
  try { config = readConfig(); }
  catch (error) {
    config = { role: 'controller', deviceId: 'invalid', backendUrl: 'http://localhost', token: '' };
    app.whenReady().then(() => require('electron').dialog.showErrorBox('설정 오류', error.message));
    setImmediate(() => app.quit());
    return;
  }
  registerIpc();
  setupDisplayCapture();
  createWindow();
  startInputGuard();
  globalShortcut.register('CommandOrControl+Shift+F12', () => emergencyUnlock());
  if (config.autoLaunch === true) configureStartup(true);
  startControlSocket();
  watchdogTimer = setInterval(() => {
    const agent = config.role === 'agent';
    if (agent && safety.effectiveMode() === 'practice' && safety.mode !== 'practice') emergencyUnlock('15초 연결 제한');
    const rendererHealthy = performance.now() - lastRendererPulse < 4_000;
    // effectiveMode()는 조건마다 새로 읽는다. 앞선 emergencyUnlock이 이미 해제했을 수 있고,
    // 값을 한 번 담아 재사용하면 해제된 직후 tick에서 LOCK을 다시 써 버린다.
    if (agent && locksInput(safety.effectiveMode()) && !rendererHealthy) emergencyUnlock('화면 프로세스 응답 없음');
    if (agent && locksInput(safety.effectiveMode()) && rendererHealthy && rendererMediaReady) writeInputGuard(`LOCK ${safety.revision}`);
    else writeInputGuard('UNLOCK');
  }, 250);
});

app.on('before-quit', teardown);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (config?.role !== 'agent') app.quit(); });

module.exports = { resolveVideoConfig, VIDEO_DEFAULTS, VIDEO_RANGES, describeApiError, API_ERROR_MAX };
