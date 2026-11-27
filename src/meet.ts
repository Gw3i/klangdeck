import './meet.css';
import type { MeetStatus, SoundboardApi } from '../shared/contracts.ts';
import type { Pad } from './board.ts';
import { $, errorMessage } from './dom.ts';

declare global {
  interface Window {
    /** Exposed by the Electron preload; absent in the browser preview. */
    soundboard?: SoundboardApi;
  }
}

/** The status the renderer starts with before the main process reports one. */
type KnownStatus = Partial<MeetStatus> & Pick<MeetStatus, 'prepared' | 'connected' | 'eligible' | 'ready' | 'muted'>;

interface MeetPlayRequest {
  slot: number;
  pad: Pad;
  buffer: AudioBuffer;
  createdAt: number;
  readBytes(id: string): Promise<ArrayBuffer | undefined>;
}

/** Encodes decoded audio as 16-bit PCM WAV, used to send built-in demo sounds to Meet. */
export function wavBytes(buffer: AudioBuffer) {
  const channels = buffer.numberOfChannels, frames = buffer.length, bytes = new ArrayBuffer(44 + frames * channels * 2), view = new DataView(bytes);
  const word = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  word(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  word(8, 'WAVE');
  word(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  word(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const sample = Math.max(-1, Math.min(1, data[channel][frame]));
    view.setInt16(44 + (frame * channels + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function createMeetControls(editor: HTMLFormElement, notice: (message: string, error?: boolean) => void) {
  const api = window.soundboard;
  let status: KnownStatus = { prepared: false, connected: false, eligible: 0, ready: false, muted: false }, generation = 0, lastNotice = 0;
  const slots = Array<number>(16).fill(0), demos = new Map<string, ArrayBuffer>();
  const section = document.createElement('details');
  section.id = 'meet-settings';
  section.innerHTML = '<summary>Google Meet <span id="meet-summary">Not set up</span></summary><p id="meet-status" role="status" aria-live="polite"></p><button id="prepare-meet" type="button">Prepare extension</button><button id="show-meet-folder" type="button" hidden>Open folder</button><p id="meet-setup-note" class="help">One-time setup for Google Meet in Chrome. Registers only the local Klangdeck connection; no audio driver is installed.</p><ol id="meet-steps"><li>Open <code>chrome://extensions</code> in Chrome and turn on Developer mode.</li><li>Choose “Load unpacked” and select the Klangdeck folder.</li><li>Reload any open Meet tabs. Your usual microphone stays selected.</li></ol><p id="meet-folder-path"></p><p id="meet-call-note" class="help" hidden>Meet mute also silences sounds. If Meet suppresses effects, check noise cancellation in the call. Headphones prevent local playback from feeding back through your microphone.</p><p id="meet-error" role="alert"></p>';
  editor.querySelector('footer')?.before(section);
  const prepareButton = $<HTMLButtonElement>('prepare-meet'), folderButton = $<HTMLButtonElement>('show-meet-folder');
  const errorText = $('meet-error');

  function describe(): [label: string, detail: string] {
    if (!api?.meetStatus) return ['Mac app only', 'This connection is available only in Klangdeck for Mac.'];
    if (status.eligible > 1) return ['Multiple calls', 'Multiple Meet calls are connected. Sounds play locally only. Keep just one call connected.'];
    if (status.ready) {
      const detail = status.muted ? 'Your microphone and Klangdeck sounds are muted in Meet.' : 'One Meet call is connected. New pad presses also send sounds to this call.';
      return [status.muted ? 'Meet is muted' : 'Call connected', status.error ? `${detail} Latest notice: ${status.error}` : detail];
    }
    if (status.error) return ['Not ready', status.error];
    if (!status.prepared) return ['Not set up', 'Prepare the local Chrome extension once. Sounds keep playing on your Mac.'];
    if (!status.connected) return ['Chrome not connected', 'Load the extension and open Google Meet. Keep Klangdeck open during the call.'];
    return ['Waiting for a call', 'The extension is connected. Sounds are sent only during an active Meet call, not in the preview before joining.'];
  }
  function render(next: KnownStatus) {
    if (status.sessionId !== next.sessionId || status.ready && (!next.ready || status.eligible !== next.eligible)) generation++;
    status = next;
    const [label, detail] = describe();
    $('meet-summary').textContent = label;
    $('meet-status').textContent = detail;
    prepareButton.disabled = !api?.prepareMeet;
    prepareButton.textContent = status.prepared ? 'Refresh setup' : 'Prepare extension';
    folderButton.hidden = !status.prepared;
    $('meet-steps').hidden = !status.prepared;
    $('meet-folder-path').textContent = status.prepared ? status.extensionPath || '' : '';
    $('meet-call-note').hidden = !status.ready;
  }
  prepareButton.onclick = async () => {
    prepareButton.disabled = true;
    errorText.textContent = '';
    try {
      if (!api) throw new Error('This connection is available only in Klangdeck for Mac.');
      render(await api.prepareMeet());
      await api.showMeetFolder();
    } catch (error) {
      errorText.textContent = `Setup failed: ${errorMessage(error)}`;
    } finally {
      prepareButton.disabled = false;
    }
  };
  folderButton.onclick = () => {
    api?.showMeetFolder().catch((error: unknown) => errorText.textContent = errorMessage(error));
  };
  render(status);
  api?.onMeetStatus?.(render);
  api?.meetStatus?.().then(render).catch((error: unknown) => render({ ...status, error: errorMessage(error) }));
  const warn = (message: string) => {
    if (Date.now() - lastNotice > 4000) {
      notice(message, true);
      lastNotice = Date.now();
    }
  };
  return {
    async play({ slot, pad, buffer, readBytes, createdAt }: MeetPlayRequest) {
      const sequence = ++slots[slot], epoch = generation, destination = status.sessionId ?? null;
      if (!status.ready || !api) {
        if (status.eligible > 1) warn('Multiple Meet calls are open: this sound plays locally only.');
        return;
      }
      try {
        const decodedBytes = buffer.length * buffer.numberOfChannels * 4;
        if (decodedBytes > 64 * 1024 * 1024) {
          warn('This long sound plays locally only; it is too large for Meet after decoding.');
          return;
        }
        let id: string, bytes: ArrayBuffer | undefined;
        if (pad.demo !== null) {
          id = `demo:${pad.demo}`;
          bytes = demos.get(id) ?? wavBytes(buffer);
          demos.set(id, bytes);
        } else if (pad.audio) {
          id = pad.audio;
          bytes = await readBytes(pad.audio);
        } else return;
        if (epoch !== generation || sequence !== slots[slot] || !status.ready || Date.now() - createdAt > 3000) return;
        if (!bytes) throw new Error('The saved audio file is missing.');
        const result = await api.playMeet({ slot, id, bytes, decodedBytes, createdAt, sessionId: destination });
        if (!result.sent && result.reason !== 'stale' && result.reason !== 'stopped') warn('This sound plays locally only. Check the Meet connection in Settings.');
      } catch {
        warn('This sound could not be sent to Meet and plays locally only.');
      }
    },
    stop() {
      generation++;
      if (api?.stopMeet) void api.stopMeet().catch(() => {});
    },
    diagnostics: () => ({ prepared: status.prepared, connected: status.connected, eligible: status.eligible, ready: status.ready, muted: status.muted })
  };
}
