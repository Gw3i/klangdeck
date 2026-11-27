// Isolated Chromium/Web Audio acceptance harness. Never opens a real meeting.
// Runs from build/tests and serves the built mixer and fixture classic scripts.
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.setPath('userData', path.resolve(process.argv[2] || '/tmp/klangdeck-meet-audio-qa'));
const build = path.resolve(__dirname, '..');
const scripts: Record<string, string> = {
  '/mixer.js': path.join(build, 'extension/mixer.js'),
  '/fixture.js': path.join(__dirname, 'meet-audio-fixture.js')
};
const server = http.createServer((req, res) => {
  const script = scripts[req.url ?? ''];
  if (script) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(script));
  } else res.end('<!doctype html><title>Klangdeck isolated audio QA</title><script src="/fixture.js"></script><script src="/mixer.js"></script>');
});

interface HarnessResult {
  failed: number;
}

void app.whenReady().then(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const timeout = setTimeout(() => {
    console.error('QA timed out');
    app.exit(1);
  }, 90000);
  try {
    await win.loadURL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const result = await win.webContents.executeJavaScript('runMeetAudioTests()', true) as HarnessResult;
    console.log(JSON.stringify(result, null, 2));
    if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(result, null, 2));
    clearTimeout(timeout);
    server.close();
    app.exit(result.failed ? 1 : 0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    server.close();
    app.exit(1);
  }
});
