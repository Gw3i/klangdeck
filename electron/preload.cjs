const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundboard', Object.freeze({
  getVolume: () => ipcRenderer.invoke('volume:get'),
  setVolume: value => ipcRenderer.invoke('volume:set', value),
  hide: () => ipcRenderer.send('window:hide'),
  getShortcut: () => ipcRenderer.invoke('shortcut:get'),
  meetStatus: () => ipcRenderer.invoke('meet:status'),
  prepareMeet: () => ipcRenderer.invoke('meet:prepare'),
  showMeetFolder: () => ipcRenderer.invoke('meet:show-folder'),
  playMeet: payload => ipcRenderer.invoke('meet:play', payload),
  stopMeet: () => ipcRenderer.invoke('meet:stop'),
  onMeetStatus: callback => { const handler=(_event,status)=>callback(status);ipcRenderer.on('meet:status-changed',handler);return()=>ipcRenderer.removeListener('meet:status-changed',handler); }
}));
