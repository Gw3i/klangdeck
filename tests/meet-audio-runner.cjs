// Isolated Chromium/Web Audio acceptance harness. Never opens a real meeting.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.setPath('userData', path.resolve(process.argv[2] || '/tmp/klangdeck-meet-audio-qa'));
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  if (req.url === '/mixer.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'extension/mixer.js'))); }
  else if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(__dirname, 'meet-audio-fixture.js'))); }
  else res.end('<!doctype html><title>Klangdeck isolated audio QA</title><script src="/fixture.js"></script><script src="/mixer.js"></script>');
});
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const timeout = setTimeout(() => { console.error('QA timed out'); app.exit(1); }, 90000);
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const result = await win.webContents.executeJavaScript('runMeetAudioTests()', true);
    console.log(JSON.stringify(result, null, 2));
    if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(result, null, 2));
    clearTimeout(timeout); server.close(); app.exit(result.failed ? 1 : 0);
  } catch (error) { console.error(error); clearTimeout(timeout); server.close(); app.exit(1); }
});
