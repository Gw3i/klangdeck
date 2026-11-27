const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const directory = path.resolve(__dirname, '../extension');
function event() { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(value) { listeners.forEach(fn => fn(value)); } }; }
function port(sender) {
  return { name: 'klangdeck-meet', sender, onMessage: event(), onDisconnect: event(), sent: [], disconnected: false,
    postMessage(message) { this.sent.push(message); }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
}
function setup() {
  const native = port(), onConnect = event(), onMessage = event(), timers = [];
  const chrome = { runtime: { id: 'extension-id', onConnect, onMessage, connectNative(name) { assert.equal(name, 'local.klangdeck.meet'); return native; } } };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'background.js'), 'utf8'), { chrome, crypto, setTimeout: callback => timers.push(callback), clearTimeout() {}, setInterval() {} });
  function tab(id, url = 'https://meet.google.com/abc-defg-hij', frameId = 0) { const value = port({ id: chrome.runtime.id, tab: { id }, url, frameId }); onConnect.emit(value); return value; }
  const status = (value, eligible, muted = false) => value.onMessage.emit({ type: 'status', eligible, muted, error: '' });
  return { native, tab, status, timers };
}
test('manifest is limited to Google Meet and native messaging', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  assert.deepEqual(manifest.permissions, ['nativeMessaging']);
  assert.ok(manifest.key);
  for (const script of manifest.content_scripts) { assert.deepEqual(script.matches, ['https://meet.google.com/*']); assert.equal(script.run_at, 'document_start'); }
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.host_permissions, undefined);
});
test('background rejects unrelated sites and non-top frames', () => {
  const state = setup();
  assert.equal(state.tab(1, 'https://evil.example/').disconnected, true);
  assert.equal(state.tab(2, 'https://meet.google.com.evil.example/').disconnected, true);
  assert.equal(state.tab(3, 'https://meet.google.com/a', 1).disconnected, true);
});
test('one eligible call receives effects; multiple calls block and invalidate old sessions', () => {
  const state = setup(), one = state.tab(1);
  state.native.onMessage.emit({ v: 1, type: 'connection', connected: true });
  state.status(one, true);
  const originalSession = state.native.sent.at(-1).sessionId;
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: originalSession, slot: 0 });
  assert.equal(one.sent.at(-1).type, 'play');
  const two = state.tab(2); state.status(two, true);
  assert.equal(state.native.sent.at(-1).eligible, 2);
  assert.equal(one.sent.at(-1).connected, false);
  const before = one.sent.length + two.sent.length;
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: originalSession, slot: 0 });
  assert.equal(one.sent.length + two.sent.length, before);
  state.status(one, false);
  const currentSession = state.native.sent.at(-1).sessionId;
  assert.notEqual(currentSession, originalSession);
  assert.equal(two.sent.at(-1).connected, true);
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: originalSession, slot: 0 });
  assert.notEqual(two.sent.at(-1).type, 'play');
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: currentSession, slot: 0 });
  assert.equal(two.sent.at(-1).type, 'play');
});
test('disconnect invalidates playback and retries without replaying commands', () => {
  const state = setup(), one = state.tab(1);
  state.native.onMessage.emit({ v: 1, type: 'connection', connected: true }); state.status(one, true);
  const session = state.native.sent.at(-1).sessionId;
  state.native.onDisconnect.emit();
  assert.equal(one.sent.at(-1).connected, false); assert.equal(state.timers.length, 1);
  const before = one.sent.length;
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: session, slot: 0 });
  assert.equal(one.sent.length, before);
});
