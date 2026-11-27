// Isolated-world content script: forwards between the page mixer (window messages) and the service worker (port).
interface MixerStatus {
  source?: unknown;
  eligible?: unknown;
  muted?: unknown;
  error?: unknown;
}

let port: chrome.runtime.Port | undefined;
let lastStatus: { type: 'status'; eligible: boolean; muted: boolean; error: string } | undefined;

const toMixer = (message: unknown) => window.postMessage({ source: 'klangdeck:bridge', message }, location.origin);

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connect({ name: 'klangdeck-meet' });
  } catch {
    return;
  }
  port.onMessage.addListener(toMixer);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = undefined;
    toMixer({ v: 1, type: 'connection', connected: false });
  });
  if (lastStatus) port.postMessage(lastStatus);
}

window.addEventListener('message', (event: MessageEvent<MixerStatus | null>) => {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'klangdeck:mixer') return;
  const message = event.data;
  if (typeof message.eligible !== 'boolean' || typeof message.muted !== 'boolean') return;
  lastStatus = { type: 'status', eligible: message.eligible, muted: message.muted, error: typeof message.error === 'string' ? message.error.slice(0, 160) : '' };
  connect();
  try {
    port?.postMessage(lastStatus);
  } catch {
    port = undefined;
  }
});

connect();
