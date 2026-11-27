const ports = new Map();
let nativePort, connected = false, target, sessionId = crypto.randomUUID(), retry;
const status = () => ({ v: 1, type: 'status', sessionId, eligible: [...ports.values()].filter(p => p.eligible).length, muted: !!target?.muted, error: target?.error || [...ports.values()].find(p => p.error)?.error || '' });
function sendNative(message) { try { nativePort?.postMessage(message); } catch {} }
function post(port, message) { try { port.postMessage(message); } catch {} }
function select() {
  const eligible = [...ports.values()].filter(p => p.eligible);
  const next = eligible.length === 1 ? eligible[0] : undefined;
  if (next !== target) {
    for (const entry of ports.values()) post(entry.port, { v: 1, type: 'connection', connected: false });
    target = next; sessionId = crypto.randomUUID();
    if (target && connected) post(target.port, { v: 1, type: 'connection', connected: true, sessionId });
  }
  sendNative(status());
}
function connect() {
  if (nativePort || !ports.size) return;
  try { nativePort = chrome.runtime.connectNative('local.klangdeck.meet'); } catch { retry = setTimeout(connect, 2000); return; }
  const current = nativePort;
  current.onMessage.addListener(message => {
    if (message?.v !== 1) return;
    if (message.type === 'connection') {
      connected = message.connected === true; sessionId = crypto.randomUUID();
      for (const entry of ports.values()) post(entry.port, { v: 1, type: 'connection', connected: false });
      if (target && connected) post(target.port, { v: 1, type: 'connection', connected: true, sessionId });
      sendNative(status()); return;
    }
    if (connected && target && message.sessionId === sessionId && ['clip-start', 'clip-chunk', 'clip-end', 'play', 'stop'].includes(message.type)) post(target.port, message);
  });
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (nativePort !== current) return;
    nativePort = undefined; connected = false; sessionId = crypto.randomUUID();
    for (const entry of ports.values()) post(entry.port, { v: 1, type: 'connection', connected: false });
    if (ports.size) retry = setTimeout(connect, 2000);
  });
  sendNative(status());
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'klangdeck-meet' || port.sender?.frameId !== 0 || !port.sender?.tab || !/^https:\/\/meet\.google\.com\//.test(port.sender.url || '')) { port.disconnect(); return; }
  const key = crypto.randomUUID(), entry = { port, eligible: false, muted: true, error: '' };
  ports.set(key, entry);
  port.onMessage.addListener(message => {
    if (message?.type !== 'status' || typeof message.eligible !== 'boolean' || typeof message.muted !== 'boolean') return;
    entry.eligible = message.eligible; entry.muted = message.muted;
    entry.error = typeof message.error === 'string' ? message.error.slice(0, 160) : '';
    select();
  });
  port.onDisconnect.addListener(() => {
    ports.delete(key); select();
    if (!ports.size) { clearTimeout(retry); nativePort?.disconnect(); nativePort = undefined; connected = false; }
  });
  connect();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id === chrome.runtime.id && message?.type === 'popup-status') reply({ connected, eligible: status().eligible, muted: status().muted });
});
setInterval(() => sendNative({ v: 1, type: 'heartbeat', sessionId }), 5000);
