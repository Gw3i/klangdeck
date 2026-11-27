// Sandboxed preload: it may require only 'electron', so it imports nothing else at runtime.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { MeetStatus, SoundboardApi } from '../shared/contracts.ts';

const api: SoundboardApi = {
  getVolume: () => ipcRenderer.invoke('volume:get'),
  setVolume: value => ipcRenderer.invoke('volume:set', value),
  hide: () => ipcRenderer.send('window:hide'),
  getShortcut: () => ipcRenderer.invoke('shortcut:get'),
  meetStatus: () => ipcRenderer.invoke('meet:status'),
  prepareMeet: () => ipcRenderer.invoke('meet:prepare'),
  showMeetFolder: () => ipcRenderer.invoke('meet:show-folder'),
  playMeet: payload => ipcRenderer.invoke('meet:play', payload),
  stopMeet: () => ipcRenderer.invoke('meet:stop'),
  onMeetStatus: callback => {
    const handler = (_event: IpcRendererEvent, status: MeetStatus) => callback(status);
    ipcRenderer.on('meet:status-changed', handler);
    return () => ipcRenderer.removeListener('meet:status-changed', handler);
  }
};

contextBridge.exposeInMainWorld('soundboard', Object.freeze(api));
