'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('classroom', Object.freeze({
  getConfig: () => ipcRenderer.invoke('config:get-public'),
  stateReady: () => ipcRenderer.send('state:ready'),
  pulse: (mediaReady) => ipcRenderer.send('renderer:pulse', mediaReady === true),
  reportMediaFailure: () => ipcRenderer.send('agent:media-failed'),
  setStartup: (enabled) => ipcRenderer.invoke('startup:set', Boolean(enabled)),
  listCaptureSources: () => ipcRenderer.invoke('capture:list'),
  selectCaptureSource: (id) => ipcRenderer.invoke('capture:select', id),
  setMode: (payload) => ipcRenderer.invoke('api:mode', payload),
  quitAgents: () => ipcRenderer.invoke('api:quit-agents'),
  backgroundWindow: () => ipcRenderer.send('window:background'),
  getIce: () => ipcRenderer.invoke('api:ice'),
  createRtcSession: (body) => ipcRenderer.invoke('rtc:session', body),
  addRtcTracks: (id, body) => ipcRenderer.invoke('rtc:tracks', id, body),
  renegotiateRtc: (id, body) => ipcRenderer.invoke('rtc:renegotiate', id, body),
  onState: (listener) => ipcRenderer.on('state:update', (_event, state) => listener(state)),
  onAgentMode: (listener) => ipcRenderer.on('agent:mode', (_event, mode) => listener(mode)),
  onNotice: (listener) => ipcRenderer.on('agent:notice', (_event, message) => listener(message)),
  onConnection: (listener) => ipcRenderer.on('connection:update', (_event, state) => listener(state))
}));
