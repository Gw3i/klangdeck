(() => {
  let port, lastStatus;
  function connect() {
    if (port) return;
    try { port = chrome.runtime.connect({ name: 'klangdeck-meet' }); } catch { return; }
    port.onMessage.addListener(message => window.postMessage({ source: 'klangdeck:bridge', message }, location.origin));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; port = undefined;
      window.postMessage({ source: 'klangdeck:bridge', message: { v: 1, type: 'connection', connected: false } }, location.origin);
    });
    if (lastStatus) port.postMessage(lastStatus);
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'klangdeck:mixer') return;
    const message = event.data;
    if (typeof message.eligible !== 'boolean' || typeof message.muted !== 'boolean') return;
    lastStatus = { type: 'status', eligible: message.eligible, muted: message.muted, error: typeof message.error === 'string' ? message.error.slice(0, 160) : '' };
    connect();
    try { port?.postMessage(lastStatus); } catch { port = undefined; }
  });
  connect();
})();
