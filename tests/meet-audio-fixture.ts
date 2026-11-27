// Browser side of the isolated audio harness. Loaded as a classic script before the built mixer.
interface MixerStatus {
  source: 'klangdeck:mixer';
  eligible: boolean;
  muted: boolean;
  error: string;
}
interface Check {
  name: string;
  passed: boolean;
  detail: string;
}
interface Call {
  sender: RTCPeerConnection;
  receiver: RTCPeerConnection;
  rtp: RTCRtpSender;
  level(frequency: number): number;
  diagnostic(): Promise<unknown>;
  close(): void;
}

declare global {
  interface Window {
    runMeetAudioTests(): Promise<unknown>;
  }
}

const RealAudioContext = window.AudioContext;
interface HarnessState {
  nextFrequency: number;
  mode: 'normal' | 'denied';
  raw: MediaStreamTrack[];
  contexts: AudioContext[];
  statuses: MixerStatus[];
  calls: (MediaStreamConstraints | undefined)[];
  applied?: MediaTrackConstraints;
  lastStream?: MediaStream;
}
const qa: HarnessState = { nextFrequency: 440, mode: 'normal', raw: [], contexts: [], statuses: [], calls: [] };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lastOf = <T>(items: T[]) => items.at(-1);
/** Replaces a window constructor for one check; the DOM types do not allow assigning an incompatible class. */
const setAudioContext = (value: unknown) => Object.defineProperty(window, 'AudioContext', { value, configurable: true, writable: true });

navigator.mediaDevices.getUserMedia = async constraints => {
  qa.calls.push(constraints);
  if (qa.mode === 'denied') throw new DOMException('No microphone permission', 'NotAllowedError');
  const context = new RealAudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
  await context.resume();
  oscillator.frequency.value = qa.nextFrequency;
  gain.gain.value = 0.08;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  const raw = destination.stream.getAudioTracks()[0];
  if (!raw) throw new Error('No synthetic microphone track');
  raw.getSettings = () => ({ deviceId: 'qa-mic', sampleRate: context.sampleRate });
  raw.getConstraints = () => typeof constraints?.audio === 'object' ? constraints.audio : {};
  raw.getCapabilities = () => ({ deviceId: 'qa-mic' });
  raw.applyConstraints = async value => {
    qa.applied = value;
  };
  const video = constraints?.video ? document.createElement('canvas').captureStream(10).getVideoTracks() : [];
  const stream = new MediaStream([raw, ...video]);
  qa.raw.push(raw);
  qa.lastStream = stream;
  qa.contexts.push(context);
  return stream;
};
window.addEventListener('message', (event: MessageEvent<MixerStatus | null>) => {
  if (event.data?.source === 'klangdeck:mixer') qa.statuses.push(event.data);
});

async function command(message: Record<string, unknown>) {
  window.postMessage({ source: 'klangdeck:bridge', message: { v: 1, sessionId: 'qa-session', ...message } }, location.origin);
  await wait(20);
}
function wav(frequency = 880, seconds = 2) {
  const rate = 48000, frames = rate * seconds, bytes = new Uint8Array(44 + frames * 2), view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => [...text].forEach((c, i) => bytes[offset + i] = c.charCodeAt(0));
  write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * frequency * i / rate) * 0.14 * 32767, true);
  return bytes;
}
async function clip(id = 'tone', extra: Record<string, unknown> = {}) {
  const bytes = wav();
  await command({ type: 'clip-start', id, byteLength: bytes.byteLength, decodedBytes: 48000 * 2 * 4, ...extra });
  for (let offset = 0, index = 0; offset < bytes.length; offset += 96 * 1024, index++) {
    let binary = '';
    for (const value of bytes.subarray(offset, offset + 96 * 1024)) binary += String.fromCharCode(value);
    await command({ type: 'clip-chunk', id, index, data: btoa(binary) });
  }
  await command({ type: 'clip-end', id });
}
function audioTrack(stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('Stream has no audio track');
  return track;
}
function localDescription(peer: RTCPeerConnection) {
  if (!peer.localDescription) throw new Error('Missing local description');
  return peer.localDescription;
}
async function link(stream: MediaStream): Promise<Call> {
  const sender = new RTCPeerConnection(), receiver = new RTCPeerConnection();
  sender.onicecandidate = e => e.candidate && receiver.addIceCandidate(e.candidate).catch(() => {});
  receiver.onicecandidate = e => e.candidate && sender.addIceCandidate(e.candidate).catch(() => {});
  const received = new Promise<MediaStream>(resolve => receiver.ontrack = e => resolve(e.streams[0] ?? new MediaStream([e.track])));
  const rtp = sender.addTrack(audioTrack(stream), stream);
  await sender.setLocalDescription(await sender.createOffer());
  await receiver.setRemoteDescription(localDescription(sender));
  await receiver.setLocalDescription(await receiver.createAnswer());
  await sender.setRemoteDescription(localDescription(receiver));
  const incoming = await received;
  // Chromium's WebRTC receive pipeline needs a media playback sink in addition
  // to the analysis graph. Volume zero prevents test audio reaching speakers.
  const playback = document.createElement('audio');
  playback.volume = 0;
  playback.srcObject = incoming;
  await playback.play();
  for (let i = 0; i < 100 && sender.connectionState !== 'connected'; i++) await wait(50);
  if (sender.connectionState !== 'connected') throw new Error('Loopback peer connection failed');
  const context = new RealAudioContext(), source = context.createMediaStreamSource(incoming), analyser = context.createAnalyser();
  await context.resume();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const silence = context.createGain();
  silence.gain.value = 0;
  analyser.connect(silence).connect(context.destination);
  qa.contexts.push(context);
  function level(frequency: number) {
    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    const bin = frequency / context.sampleRate * analyser.fftSize;
    return Math.max(...data.slice(Math.max(0, Math.floor(bin) - 3), Math.ceil(bin) + 4));
  }
  const incomingTrack = audioTrack(incoming);
  return {
    sender, receiver, rtp, level,
    diagnostic: async () => ({
      contextState: context.state,
      contextTime: context.currentTime,
      sourceContexts: qa.contexts.map(c => ({ state: c.state, time: c.currentTime })),
      track: { enabled: incomingTrack.enabled, muted: incomingTrack.muted, state: incomingTrack.readyState },
      stats: [...(await receiver.getStats()).values()].filter((s: { type: string }) => ['inbound-rtp', 'media-source', 'outbound-rtp'].includes(s.type))
    }),
    close: () => {
      playback.pause();
      playback.srcObject = null;
      sender.close();
      receiver.close();
    }
  };
}

window.runMeetAudioTests = async () => {
  const results: Check[] = [], measure: Record<string, unknown> = {};
  const check = (name: string, passed: unknown, detail = '') => {
    results.push({ name, passed: !!passed, detail });
    if (!passed) console.error(name, detail);
  };
  let call: Call | undefined;
  try {
    const constraints = { audio: { deviceId: { exact: 'qa-mic' }, echoCancellation: false }, video: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints), track = audioTrack(stream), raw = lastOf(qa.raw);
    check('original constraints and video preserved', qa.calls[0] === constraints && stream.getVideoTracks().length === 1 && track !== raw && track.getSettings().deviceId === 'qa-mic');
    await track.applyConstraints({ echoCancellation: true });
    check('applyConstraints forwarded to physical track', qa.applied?.echoCancellation === true);
    await wait(1100);
    check('prejoin microphone is not eligible', lastOf(qa.statuses)?.eligible === false);
    call = await link(stream);
    await wait(1100);
    check('connected audio sender is eligible', lastOf(qa.statuses)?.eligible === true);
    const voiceBefore = call.level(440), effectBefore = call.level(880);
    Object.assign(measure, { voiceBefore, effectBefore });
    if (!Number.isFinite(voiceBefore)) measure.diagnostic = await call.diagnostic();
    check('remote peer receives microphone alone', voiceBefore > -45 && effectBefore < -55, JSON.stringify(measure));
    await command({ type: 'connection', connected: true });
    await clip();
    await command({ type: 'play', id: 'tone', slot: 0, epoch: 1, createdAt: Date.now() });
    await wait(350);
    const voiceMixed = call.level(440), effectMixed = call.level(880);
    Object.assign(measure, { voiceMixed, effectMixed });
    check('remote peer receives voice and sound together', voiceMixed > -45 && effectMixed > -45, JSON.stringify(measure));
    track.enabled = false;
    await wait(300);
    const voiceMuted = call.level(440), effectMuted = call.level(880);
    Object.assign(measure, { voiceMuted, effectMuted });
    check('Meet output mute silences voice and sounds', voiceMuted < -60 && effectMuted < -60, JSON.stringify(measure));
    track.enabled = true;
    await command({ type: 'stop', epoch: 2 });
    await wait(300);
    check('stop removes effects and keeps voice', call.level(440) > -45 && call.level(880) < -55);
    await command({ type: 'play', id: 'tone', slot: 0, epoch: 1, createdAt: Date.now() });
    await wait(150);
    check('stale epoch cannot restart effects', call.level(880) < -55);
    await command({ type: 'play', id: 'tone', slot: 0, epoch: 2, createdAt: Date.now() - 5000 });
    await wait(150);
    check('expired play cannot replay', call.level(880) < -55);
    await command({ type: 'play', id: 'tone', slot: 0, epoch: 2, createdAt: Date.now() });
    await wait(150);
    await command({ type: 'connection', connected: false });
    await wait(300);
    check('desktop disconnect stops sounds and preserves voice', call.level(440) > -45 && call.level(880) < -55 && raw?.readyState === 'live');
    const clone = track.clone(), streamClone = audioTrack(stream.clone());
    track.stop();
    const endedClone = track.clone(), endedStreamClone = audioTrack(new MediaStream([track]).clone());
    check('clones keep microphone alive after original stops', raw?.readyState === 'live' && clone.readyState === 'live' && streamClone.readyState === 'live');
    clone.stop();
    streamClone.stop();
    check('last clone releases mic even when ended clones exist', raw?.readyState === 'ended' && endedClone.readyState === 'ended' && endedStreamClone.readyState === 'ended');
    call.close();
    stream.getVideoTracks().forEach(t => t.stop());

    qa.nextFrequency = 550;
    const second = await navigator.mediaDevices.getUserMedia({ audio: true }), secondRaw = lastOf(qa.raw);
    call = await link(second);
    await wait(350);
    await command({ type: 'connection', connected: true });
    await clip('delayed');
    const decode = RealAudioContext.prototype.decodeAudioData;
    RealAudioContext.prototype.decodeAudioData = async function (this: AudioContext, bytes: ArrayBuffer) {
      await wait(200);
      return decode.call(this, bytes);
    };
    await command({ type: 'play', id: 'delayed', slot: 1, epoch: 3, createdAt: Date.now() });
    await command({ type: 'stop', epoch: 4 });
    await wait(500);
    RealAudioContext.prototype.decodeAudioData = decode;
    check('stop during decode cancels late playback', call.level(550) > -45 && call.level(880) < -55);
    await clip('oversize', { decodedBytes: 65 * 1024 * 1024 });
    await command({ type: 'play', id: 'oversize', slot: 1, epoch: 4, createdAt: Date.now() });
    await wait(200);
    check('oversized decoded projection is rejected', call.level(880) < -55);
    const processingContext = new RealAudioContext(), processed = processingContext.createMediaStreamDestination();
    await processingContext.resume();
    processingContext.createMediaStreamSource(second).connect(processed);
    qa.contexts.push(processingContext);
    await call.rtp.replaceTrack(audioTrack(processed.stream));
    const preview = await navigator.mediaDevices.getUserMedia({ audio: true });
    await wait(1100);
    check('ambiguous processed call plus preview blocks effects', lastOf(qa.statuses)?.eligible === false && lastOf(qa.statuses)?.error.includes('Multiple microphone streams'));
    preview.getTracks().forEach(t => t.stop());
    await wait(1100);
    check('processed call recovers when preview closes', lastOf(qa.statuses)?.eligible === true);
    qa.nextFrequency = 660;
    const replacement = await navigator.mediaDevices.getUserMedia({ audio: true }), replacementRaw = lastOf(qa.raw);
    await call.rtp.replaceTrack(audioTrack(replacement));
    second.getTracks().forEach(t => t.stop());
    await wait(350);
    check('mid-call microphone replacement preserves new voice', call.level(660) > -45 && call.level(550) < -55 && secondRaw?.readyState === 'ended');
    await command({ type: 'play', id: 'delayed', slot: 1, epoch: 4, createdAt: Date.now() });
    await wait(300);
    check('effects follow microphone replacement', call.level(660) > -45 && call.level(880) > -45);
    let ended = false;
    audioTrack(replacement).addEventListener('ended', () => ended = true);
    replacementRaw?.stop();
    replacementRaw?.dispatchEvent(new Event('ended'));
    await wait(100);
    check('physical microphone end ends mixed track', ended && audioTrack(replacement).readyState === 'ended');
    call.close();

    qa.mode = 'denied';
    let denied: unknown;
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      denied = error;
    }
    check('microphone permission error is preserved', denied instanceof DOMException && denied.name === 'NotAllowedError');
    qa.mode = 'normal';
    setAudioContext(class {
      constructor() {
        throw new Error('deliberate mixer failure');
      }
    });
    const fallback = await navigator.mediaDevices.getUserMedia({ audio: true });
    check('mixer failure returns original microphone stream', fallback === qa.lastStream && fallback.getAudioTracks()[0] === lastOf(qa.raw));
    fallback.getTracks().forEach(t => t.stop());
    setAudioContext(class extends RealAudioContext {
      override resume() {
        return new Promise<void>(() => {});
      }
    });
    const start = performance.now(), timedFallback = await navigator.mediaDevices.getUserMedia({ audio: true });
    check('blocked context resume fails open within two seconds', timedFallback === qa.lastStream && performance.now() - start < 2000);
    timedFallback.getTracks().forEach(t => t.stop());
    setAudioContext(RealAudioContext);
  } catch (error) {
    check('harness completed', false, error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    call?.close();
    for (const track of qa.raw) track.stop();
    await Promise.all(qa.contexts.map(context => context.close().catch(() => {})));
  }
  return {
    kind: 'isolated Chromium WebRTC loopback, not a real Google Meet call',
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    measurementsDb: measure,
    results
  };
};
