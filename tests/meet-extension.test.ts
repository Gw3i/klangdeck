import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';

// The built extension, exactly as it is copied into the app and loaded by Chrome.
const directory = path.resolve(import.meta.dirname, '../build/extension');
type Message = Record<string, unknown>;
interface FakePort {
  name: string;
  sender: unknown;
  onMessage: FakeEvent<Message>;
  onDisconnect: FakeEvent<void>;
  sent: Message[];
  disconnected: boolean;
  postMessage(message: Message): void;
  disconnect(): void;
}

type FakeEvent<T> = ReturnType<typeof event<T>>;

function event<T>() { const listeners: ((value: T) => void)[] = []; return { addListener(fn: (value: T) => void) { listeners.push(fn); }, emit(value: T) { listeners.forEach(fn => fn(value)); } }; }
function port(sender?: unknown): FakePort {
  return { name: 'klangdeck-meet', sender, onMessage: event(), onDisconnect: event(), sent: [], disconnected: false,
    postMessage(message) { this.sent.push(message); }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
}
function last(messages: Message[]) {
  const message = messages.at(-1);
  assert.ok(message, 'expected a sent message');
  return message;
}
function setup() {
  const native = port(), onConnect = event<FakePort>(), onMessage = event<Message>(), timers: (() => void)[] = [];
  const chrome = { runtime: { id: 'extension-id', onConnect, onMessage, connectNative(name: string) { assert.equal(name, 'local.klangdeck.meet'); return native; } } };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'background.js'), 'utf8'), { chrome, crypto, setTimeout: (callback: () => void) => timers.push(callback), clearTimeout() {}, setInterval() {} });
  function tab(id: number, url = 'https://meet.google.com/abc-defg-hij', frameId = 0) { const value = port({ id: chrome.runtime.id, tab: { id }, url, frameId }); onConnect.emit(value); return value; }
  const status = (value: FakePort, eligible: boolean, muted = false) => value.onMessage.emit({ type: 'status', eligible, muted, error: '' });
  return { native, tab, status, timers };
}
test('manifest is limited to Google Meet and native messaging', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
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
  const originalSession = last(state.native.sent).sessionId;
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: originalSession, slot: 0 });
  assert.equal(last(one.sent).type, 'play');
  const two = state.tab(2); state.status(two, true);
  assert.equal(last(state.native.sent).eligible, 2);
  assert.equal(last(one.sent).connected, false);
  const before = one.sent.length + two.sent.length;
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: originalSession, slot: 0 });
  assert.equal(one.sent.length + two.sent.length, before);
  state.status(one, false);
  const currentSession = last(state.native.sent).sessionId;
  assert.notEqual(currentSession, originalSession);
  assert.equal(last(two.sent).connected, true);
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: originalSession, slot: 0 });
  assert.notEqual(last(two.sent).type, 'play');
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: currentSession, slot: 0 });
  assert.equal(last(two.sent).type, 'play');
});
test('disconnect invalidates playback and retries without replaying commands', () => {
  const state = setup(), one = state.tab(1);
  state.native.onMessage.emit({ v: 1, type: 'connection', connected: true }); state.status(one, true);
  const session = last(state.native.sent).sessionId;
  state.native.onDisconnect.emit();
  assert.equal(last(one.sent).connected, false); assert.equal(state.timers.length, 1);
  const before = one.sent.length;
  state.native.onMessage.emit({ v: 1, type: 'play', sessionId: session, slot: 0 });
  assert.equal(one.sent.length, before);
});
