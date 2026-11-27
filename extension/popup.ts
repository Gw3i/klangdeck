import type { PopupStatus } from './background.ts';

const statusText = document.querySelector<HTMLElement>('#status');

function describe(status: PopupStatus | undefined) {
  if (!status?.connected) return 'Klangdeck is not connected. Open the app and complete setup.';
  if (status.eligible > 1) return 'Multiple Meet calls are active. Sounds are blocked until only one call is active.';
  if (!status.eligible) return 'Connected. Ready when you join a Meet call.';
  return status.muted ? 'Meet is muted. Voice and sounds stay muted.' : 'Connected to your Meet call.';
}

chrome.runtime.sendMessage<{ type: 'popup-status' }, PopupStatus | undefined>({ type: 'popup-status' }).then(status => {
  if (statusText) statusText.textContent = describe(status);
}).catch(() => {
  if (statusText) statusText.textContent = 'Open Google Meet and reload the tab if needed.';
});
