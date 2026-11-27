// Extension service worker: relays between the one eligible Meet tab and the native host.
interface TabEntry {
  port: chrome.runtime.Port;
  eligible: boolean;
  muted: boolean;
  error: string;
}
interface NativeMessage {
  v?: unknown;
  type?: unknown;
  connected?: unknown;
  sessionId?: unknown;
}

/** The reply the toolbar popup receives. */
export interface PopupStatus {
  connected: boolean;
  eligible: number;
  muted: boolean;
}

const RELAYED = ['clip-start', 'clip-chunk', 'clip-end', 'play', 'stop'];
const ports = new Map<string, TabEntry>();
let nativePort: chrome.runtime.Port | undefined, connected = false, target: TabEntry | undefined, sessionId = crypto.randomUUID();
let retry: ReturnType<typeof setTimeout> | undefined;

const eligibleTabs = () => [...ports.values()].filter(entry => entry.eligible);
const status = () => ({
  v: 1,
  type: 'status',
  sessionId,
  eligible: eligibleTabs().length,
  muted: !!target?.muted,
  error: target?.error || [...ports.values()].find(entry => entry.error)?.error || ''
});
function post(port: chrome.runtime.Port | undefined, message: object) {
  try {
    port?.postMessage(message);
  } catch { /* The other side already went away. */ }
}
const sendNative = (message: object) => post(nativePort, message);
/** Starts a new session: every tab is told it is disconnected, then only the target is reconnected. */
function renewSession() {
  sessionId = crypto.randomUUID();
  for (const entry of ports.values()) post(entry.port, { v: 1, type: 'connection', connected: false });
  if (target && connected) post(target.port, { v: 1, type: 'connection', connected: true, sessionId });
}

function select() {
  const eligible = eligibleTabs();
  const next = eligible.length === 1 ? eligible[0] : undefined;
  if (next !== target) {
    target = next;
    renewSession();
  }
  sendNative(status());
}

function connect() {
  if (nativePort || !ports.size) return;
  try {
    nativePort = chrome.runtime.connectNative('local.klangdeck.meet');
  } catch {
    retry = setTimeout(connect, 2000);
    return;
  }
  const current = nativePort;
  current.onMessage.addListener((message: NativeMessage | null) => {
    if (message?.v !== 1) return;
    if (message.type === 'connection') {
      connected = message.connected === true;
      renewSession();
      sendNative(status());
      return;
    }
    if (connected && target && message.sessionId === sessionId && typeof message.type === 'string' && RELAYED.includes(message.type)) post(target.port, message);
  });
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (nativePort !== current) return;
    nativePort = undefined;
    connected = false;
    renewSession();
    if (ports.size) retry = setTimeout(connect, 2000);
  });
  sendNative(status());
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'klangdeck-meet' || port.sender?.frameId !== 0 || !port.sender.tab || !/^https:\/\/meet\.google\.com\//.test(port.sender.url || '')) {
    port.disconnect();
    return;
  }
  const key = crypto.randomUUID(), entry: TabEntry = { port, eligible: false, muted: true, error: '' };
  ports.set(key, entry);
  port.onMessage.addListener((message: { type?: unknown; eligible?: unknown; muted?: unknown; error?: unknown } | null) => {
    if (message?.type !== 'status' || typeof message.eligible !== 'boolean' || typeof message.muted !== 'boolean') return;
    entry.eligible = message.eligible;
    entry.muted = message.muted;
    entry.error = typeof message.error === 'string' ? message.error.slice(0, 160) : '';
    select();
  });
  port.onDisconnect.addListener(() => {
    ports.delete(key);
    select();
    if (!ports.size) {
      clearTimeout(retry);
      nativePort?.disconnect();
      nativePort = undefined;
      connected = false;
    }
  });
  connect();
});

chrome.runtime.onMessage.addListener((message: { type?: unknown } | null, sender, reply) => {
  if (sender.id === chrome.runtime.id && message?.type === 'popup-status') reply({ connected, eligible: status().eligible, muted: status().muted } satisfies PopupStatus);
});

setInterval(() => sendNative({ v: 1, type: 'heartbeat', sessionId }), 5000);
