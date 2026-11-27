const { app, BrowserWindow, globalShortcut, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createVolumeControl } = require('./volume.cjs');
const { createMeetBridge } = require('./meet-bridge.cjs');

app.setName('Klangdeck');
// Explicit opt-in for isolated automated QA; normal app launches use macOS Application Support.
const qaData = process.argv.find(arg => arg.startsWith('--qa-user-data='));
if (qaData) {
  const directory = qaData.slice('--qa-user-data='.length);
  if (!path.isAbsolute(directory)) throw new Error('QA data directory must be absolute.');
  app.setPath('userData', directory);
}

const shortcut = 'CommandOrControl+Shift+Space';
const rendererURL = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
const volume = createVolumeControl();
let window;
let quitting = false;
let shortcutRegistered = false;
let meet;

function trusted(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === rendererURL;
}
function assertTrusted(event) {
  if (!trusted(event)) throw new Error('Access denied.');
}
function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  if (qaData) window.showInactive();
  else { window.show(); window.focus(); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    window = new BrowserWindow({
      width: 700, height: 740, minWidth: 600, minHeight: 660,
      title: 'Klangdeck', show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, resizable: false,
      fullscreenable: false, maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true,
        backgroundThrottling: !qaData, spellcheck: false
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    meet = createMeetBridge({
      userData:app.getPath('userData'),
      extensionSource:app.isPackaged ? path.join(process.resourcesPath,'meet-extension') : path.join(__dirname,'../extension'),
      hostSource:app.isPackaged ? path.join(process.resourcesPath,'meet-native') : __dirname,
      executable:process.execPath,
      registrationDirectory:qaData ? path.join(app.getPath('userData'),'qa-native-messaging-hosts') : path.join(app.getPath('home'),'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      onStatus:status => { if (!window.webContents.isDestroyed()) window.webContents.send('meet:status-changed',status); }
    });
    ipcMain.handle('meet:status', event => { assertTrusted(event); return meet.status(); });
    ipcMain.handle('meet:prepare', async event => { assertTrusted(event); return meet.prepare(); });
    ipcMain.handle('meet:show-folder', async event => { assertTrusted(event); if(!meet.status().prepared)throw new Error('Prepare the extension first.');if(qaData)return;const error=await shell.openPath(meet.extensionPath);if(error)throw new Error(error); });
    ipcMain.handle('meet:play', (event,payload) => { assertTrusted(event); return meet.play(payload); });
    ipcMain.handle('meet:stop', event => { assertTrusted(event); return meet.stop(); });
    meet.start();
    ipcMain.handle('volume:get', event => { assertTrusted(event); return volume.getVolume(); });
    ipcMain.handle('volume:set', (event, value) => { assertTrusted(event); return volume.setVolume(value); });
    ipcMain.handle('shortcut:get', event => { assertTrusted(event); return { shortcut, registered: shortcutRegistered }; });
    ipcMain.on('window:hide', event => { if (trusted(event)) window.hide(); });

    window.once('ready-to-show', showWindow);
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
    window.loadURL(rendererURL);
    shortcutRegistered = globalShortcut.register(shortcut, () => {
      if (window.isVisible() && window.isFocused()) window.hide();
      else showWindow();
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Klangdeck', submenu: [
        { label: 'About Klangdeck', role: 'about' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => {
          showWindow();
          window.webContents.executeJavaScript("window.dispatchEvent(new Event('klangdeck:settings'))").catch(() => {});
        } },
        { type: 'separator' },
        { label: 'Show soundboard', click: showWindow },
        { label: 'Hide soundboard', accelerator: 'CmdOrCtrl+W', click: () => window.hide() },
        { type: 'separator' },
        { label: 'Quit Klangdeck', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ] },
      { label: 'Edit', submenu: [
        { role: 'undo', label: 'Undo' }, { role: 'redo', label: 'Redo' },
        { type: 'separator' }, { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select all' }
      ] },
      { label: 'Help', submenu: [
        { label: 'Show local app data', click: () => shell.openPath(app.getPath('userData')) }
      ] }
    ]));
  });
  app.on('activate', showWindow);
  app.on('before-quit', event => { if(quitting)return;quitting=true;if(meet){event.preventDefault();meet.close().finally(()=>app.quit());} });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
