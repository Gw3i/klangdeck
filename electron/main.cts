import { app, BrowserWindow, globalShortcut, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVolumeControl } from './volume.cjs';
import { createMeetBridge, type MeetBridge } from './meet-bridge.cjs';
import type { ShortcutStatus } from '../shared/contracts.ts';

// The Dock and menu show the lowercase brand. The data folder keeps its original
// capitalised name, so existing sounds stay where earlier versions saved them.
app.setName('klangdeck');
app.setPath('userData', path.join(app.getPath('appData'), 'Klangdeck'));
// Explicit opt-in for isolated automated QA; normal app launches use macOS Application Support.
const qaData = process.argv.find(arg => arg.startsWith('--qa-user-data='));
if (qaData) {
  const directory = qaData.slice('--qa-user-data='.length);
  if (!path.isAbsolute(directory)) throw new Error('QA data directory must be absolute.');
  app.setPath('userData', directory);
}

// This file runs from build/electron; the renderer build lives in dist/ at the project root.
const shortcut = 'CommandOrControl+Shift+Space';
const rendererURL = pathToFileURL(path.join(__dirname, '../../dist/index.html')).href;
const volume = createVolumeControl();
let window: BrowserWindow | undefined;
let quitting = false;
let shortcutRegistered = false;
let meet: MeetBridge | undefined;

function trusted(event: IpcMainEvent | IpcMainInvokeEvent) {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === rendererURL;
}
function assertTrusted(event: IpcMainInvokeEvent) {
  if (!trusted(event)) throw new Error('Access denied.');
}
function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  if (qaData) window.showInactive();
  else {
    window.show();
    window.focus();
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 700, height: 740, minWidth: 600, minHeight: 660,
    title: 'klangdeck', show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', hasShadow: false, resizable: false,
    fullscreenable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
      backgroundThrottling: !qaData, spellcheck: false
    }
  });
  window = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));

  const bridge = createMeetBridge({
    userData: app.getPath('userData'),
    extensionSource: app.isPackaged ? path.join(process.resourcesPath, 'meet-extension') : path.join(__dirname, '../extension'),
    hostSource: app.isPackaged ? path.join(process.resourcesPath, 'meet-native') : __dirname,
    executable: process.execPath,
    registrationDirectory: qaData ? path.join(app.getPath('userData'), 'qa-native-messaging-hosts') : path.join(app.getPath('home'), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
    onStatus: status => {
      if (!win.webContents.isDestroyed()) win.webContents.send('meet:status-changed', status);
    }
  });
  meet = bridge;
  ipcMain.handle('meet:status', event => {
    assertTrusted(event);
    return bridge.status();
  });
  ipcMain.handle('meet:prepare', async event => {
    assertTrusted(event);
    return bridge.prepare();
  });
  ipcMain.handle('meet:show-folder', async event => {
    assertTrusted(event);
    if (!bridge.status().prepared) throw new Error('Prepare the extension first.');
    if (qaData) return;
    const error = await shell.openPath(bridge.extensionPath);
    if (error) throw new Error(error);
  });
  ipcMain.handle('meet:play', (event, payload: unknown) => {
    assertTrusted(event);
    return bridge.play(payload);
  });
  ipcMain.handle('meet:stop', event => {
    assertTrusted(event);
    return bridge.stop();
  });
  void bridge.start();
  ipcMain.handle('volume:get', event => {
    assertTrusted(event);
    return volume.getVolume();
  });
  ipcMain.handle('volume:set', (event, value: unknown) => {
    assertTrusted(event);
    return volume.setVolume(value);
  });
  ipcMain.handle('shortcut:get', (event): ShortcutStatus => {
    assertTrusted(event);
    return { shortcut, registered: shortcutRegistered };
  });
  ipcMain.on('window:hide', event => {
    if (trusted(event)) win.hide();
  });

  win.once('ready-to-show', showWindow);
  win.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  void win.loadURL(rendererURL);
  shortcutRegistered = globalShortcut.register(shortcut, () => {
    if (win.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'klangdeck', submenu: [
      { label: 'About klangdeck', role: 'about' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => {
        showWindow();
        win.webContents.executeJavaScript("window.dispatchEvent(new Event('klangdeck:settings'))").catch(() => {});
      } },
      { type: 'separator' },
      { label: 'Show soundboard', click: showWindow },
      { label: 'Hide soundboard', accelerator: 'CmdOrCtrl+W', click: () => win.hide() },
      { type: 'separator' },
      { label: 'Quit klangdeck', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo', label: 'Undo' }, { role: 'redo', label: 'Redo' },
      { type: 'separator' }, { role: 'cut', label: 'Cut' },
      { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' },
      { role: 'selectAll', label: 'Select all' }
    ] },
    { label: 'Help', submenu: [
      { label: 'Show local app data', click: () => void shell.openPath(app.getPath('userData')) }
    ] }
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  void app.whenReady().then(createWindow);
  app.on('activate', showWindow);
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    if (meet) {
      event.preventDefault();
      void meet.close().finally(() => app.quit());
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
