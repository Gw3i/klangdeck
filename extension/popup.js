chrome.runtime.sendMessage({ type: 'popup-status' }).then(status => {
  document.querySelector('#status').textContent = !status?.connected ? 'Klangdeck is not connected. Open the app and complete setup.' : status.eligible > 1 ? 'Multiple Meet calls are active. Sounds are blocked until only one call is active.' : !status.eligible ? 'Connected. Ready when you join a Meet call.' : status.muted ? 'Meet is muted. Voice and sounds stay muted.' : 'Connected to your Meet call.';
}).catch(() => { document.querySelector('#status').textContent = 'Open Google Meet and reload the tab if needed.'; });
