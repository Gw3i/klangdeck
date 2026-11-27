// Main-world Meet script: mixes Klangdeck clips into the microphone track Meet sends.
// Messages from the content script are untrusted page data and are validated here.
declare global {
  interface Window {
    __klangdeckMeetInstalled?: boolean;
  }
}

interface Graph {
  raw: MediaStreamTrack;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  destination: MediaStreamAudioDestinationNode;
  mix: DynamicsCompressorNode;
  tracks: Set<MediaStreamTrack>;
}
interface Clip {
  bytes: ArrayBuffer;
  decodedBytes: number;
}
interface Transfer {
  id: string;
  bytes: Uint8Array<ArrayBuffer>;
  decodedBytes: number;
  offset: number;
  index: number;
}
interface PlayMessage {
  id: string;
  slot: number;
  createdAt: number;
}
interface BridgeMessage {
  v?: unknown;
  type?: unknown;
  connected?: unknown;
  sessionId?: unknown;
  epoch?: unknown;
  id?: unknown;
  byteLength?: unknown;
  decodedBytes?: unknown;
  index?: unknown;
  data?: unknown;
  slot?: unknown;
  createdAt?: unknown;
}

// Insecure or restricted pages have no getUserMedia even though the DOM types always declare it.
if (typeof navigator.mediaDevices?.getUserMedia === 'function' && !window.__klangdeckMeetInstalled) install();

function install() {
  Object.defineProperty(window, '__klangdeckMeetInstalled', { value: true });
  const MAX_CLIP = 25 * 1024 * 1024, MAX_CACHE = 64 * 1024 * 1024;
  const graphs = new Set<Graph>(), peers = new Set<RTCPeerConnection>(), trackGraphs = new WeakMap<MediaStreamTrack, Graph>();
  const clips = new Map<string, Clip>(), decoded = new Map<string, AudioBuffer>();
  const playing = new Map<number, AudioBufferSourceNode>(), tokens = new Map<number, number>();
  const media = navigator.mediaDevices, originalGetUserMedia = media.getUserMedia.bind(media);
  const nativeTrackClone = MediaStreamTrack.prototype.clone, nativeTrackStop = MediaStreamTrack.prototype.stop;
  const nativeStreamClone = MediaStream.prototype.clone;
  let connected = false, sessionId: string | undefined, epoch = -1, generation = 0, transfer: Transfer | undefined;
  let bytesUsed = 0, decodedUsed = 0, decodingUsed = 0, error = '', routingError = '';
  const idOK = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(id);
  const isInteger = (value: unknown): value is number => Number.isInteger(value);
  const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
  const decodedSize = (buffer: AudioBuffer) => buffer.length * buffer.numberOfChannels * 4;
  const liveAudio = (track: MediaStreamTrack | null): track is MediaStreamTrack => track?.kind === 'audio' && track.readyState === 'live';
  const firstKey = <K, V>(map: Map<K, V>) => map.keys().next().value as K;

  function livePeers() {
    return [...peers].filter(pc => pc.connectionState === 'connected' && pc.getSenders().some(sender => liveAudio(sender.track)));
  }
  function selectedGraph() {
    routingError = '';
    const outgoing = livePeers();
    if (!outgoing.length) return;
    for (const pc of outgoing) for (const sender of pc.getSenders()) {
      const graph = sender.track && trackGraphs.get(sender.track);
      if (graph && graphs.has(graph)) return graph;
    }
    // Meet may insert its own processing or clone tracks before addTrack.
    const candidates = [...graphs].filter(graph => graph.tracks.size && graph.raw.readyState === 'live');
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) routingError = 'Multiple microphone streams. Close Meet audio settings and reload the tab if needed.';
  }
  function report() {
    for (const pc of peers) if (pc.connectionState === 'closed') peers.delete(pc);
    const graph = selectedGraph();
    const senders = livePeers().flatMap(pc => pc.getSenders()).map(sender => sender.track).filter(liveAudio);
    window.postMessage({ source: 'klangdeck:mixer', eligible: !!graph, muted: !senders.some(track => track.enabled), error: routingError || error }, location.origin);
  }
  const NativePeerConnection = window.RTCPeerConnection;
  if (NativePeerConnection) {
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        peers.add(this);
        this.addEventListener('connectionstatechange', report);
      }
    };
  }

  function stopSource(source: AudioBufferSourceNode) {
    try {
      source.stop();
    } catch { /* Never started or already stopped. */ }
  }
  function stopEffects() {
    generation++;
    tokens.clear();
    transfer = undefined;
    for (const source of playing.values()) {
      stopSource(source);
      source.disconnect();
    }
    playing.clear();
  }
  function clearCache() {
    clips.clear();
    decoded.clear();
    bytesUsed = 0;
    decodedUsed = 0;
  }
  function release(graph: Graph, track: MediaStreamTrack, ended = false) {
    if (!graph.tracks.delete(track)) return;
    nativeTrackStop.call(track);
    if (ended) track.dispatchEvent(new Event('ended'));
    if (!graph.tracks.size) {
      graphs.delete(graph);
      graph.source.disconnect();
      nativeTrackStop.call(graph.raw);
      graph.context.close().catch(() => {});
      for (const [slot, source] of playing) {
        if (source.context === graph.context) {
          stopSource(source);
          playing.delete(slot);
        }
      }
    }
    report();
  }
  function manage(graph: Graph, track: MediaStreamTrack): MediaStreamTrack {
    if (track.readyState === 'ended') return track;
    graph.tracks.add(track);
    trackGraphs.set(track, graph);
    // A clone owns one reference to the graph; stopping any individual clone must
    // not stop the microphone while another sender still uses it.
    Object.defineProperties(track, {
      stop: { configurable: true, value: () => release(graph, track) },
      clone: { configurable: true, value: () => manage(graph, nativeTrackClone.call(track)) },
      getSettings: { configurable: true, value: () => graph.raw.getSettings() },
      getConstraints: { configurable: true, value: () => graph.raw.getConstraints() },
      getCapabilities: { configurable: true, value: () => graph.raw.getCapabilities() },
      applyConstraints: { configurable: true, value: (constraints?: MediaTrackConstraints) => graph.raw.applyConstraints(constraints) },
      label: { configurable: true, get: () => graph.raw.label },
      muted: { configurable: true, get: () => graph.raw.muted }
    });
    return track;
  }
  MediaStream.prototype.clone = function (this: MediaStream) {
    const result = nativeStreamClone.call(this), originals = this.getAudioTracks(), copies = result.getAudioTracks();
    originals.forEach((track, index) => {
      const graph = trackGraphs.get(track), copy = copies[index];
      if (graph && copy) manage(graph, copy);
    });
    return result;
  };
  media.getUserMedia = async constraints => {
    const stream = await originalGetUserMedia(constraints);
    const raw = stream.getAudioTracks()[0];
    if (!raw) return stream;
    let context: AudioContext | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      context = new AudioContext();
      await Promise.race([context.resume(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Audio did not start')), 1500);
      })]);
      clearTimeout(timeout);
      if (context.state !== 'running' || raw.readyState !== 'live') throw new Error('Microphone not ready');
      const source = context.createMediaStreamSource(new MediaStream([raw])), destination = context.createMediaStreamDestination(), mix = context.createDynamicsCompressor();
      mix.threshold.value = 0;
      mix.knee.value = 0;
      mix.ratio.value = 20;
      mix.attack.value = 0.003;
      mix.release.value = 0.05;
      source.connect(mix).connect(destination);
      const graph: Graph = { raw, context, source, destination, mix, tracks: new Set() };
      const mixed = destination.stream.getAudioTracks()[0];
      if (!mixed) throw new Error('Mixer has no output track');
      const output = manage(graph, mixed);
      graphs.add(graph);
      raw.addEventListener('ended', () => {
        for (const track of [...graph.tracks]) release(graph, track, true);
      });
      for (const type of ['mute', 'unmute']) {
        raw.addEventListener(type, () => {
          for (const track of graph.tracks) track.dispatchEvent(new Event(type));
        });
      }
      error = '';
      report();
      return new MediaStream([output, ...stream.getVideoTracks()]);
    } catch {
      clearTimeout(timeout);
      context?.close().catch(() => {});
      error = 'Sound mixing unavailable; microphone is unchanged.';
      report();
      return stream;
    }
  };

  /** Map lookup that also marks the entry as most recently used. */
  function touch<V>(map: Map<string, V>, id: string) {
    const value = map.get(id);
    if (value) {
      map.delete(id);
      map.set(id, value);
    }
    return value;
  }
  function removeDecoded(id: string) {
    const buffer = decoded.get(id);
    if (buffer) {
      decodedUsed -= decodedSize(buffer);
      decoded.delete(id);
    }
  }
  function storeClip(id: string, bytes: ArrayBuffer, decodedBytes: number) {
    const previous = clips.get(id);
    if (previous) bytesUsed -= previous.bytes.byteLength;
    clips.delete(id);
    removeDecoded(id);
    clips.set(id, { bytes, decodedBytes });
    bytesUsed += bytes.byteLength;
    while (bytesUsed > MAX_CACHE) {
      const oldest = firstKey(clips);
      bytesUsed -= clips.get(oldest)?.bytes.byteLength ?? 0;
      clips.delete(oldest);
      removeDecoded(oldest);
    }
  }
  async function play(message: PlayMessage) {
    const graph = selectedGraph(), clip = touch(clips, message.id);
    if (!graph || !clip) {
      error = 'Sound not ready. Press the pad again.';
      report();
      return;
    }
    const token = (tokens.get(message.slot) || 0) + 1;
    tokens.set(message.slot, token);
    const stamp = generation, expectedSession = sessionId;
    const old = playing.get(message.slot);
    if (old) {
      old.stop();
      old.disconnect();
      playing.delete(message.slot);
    }
    const current = () => connected && generation === stamp && tokens.get(message.slot) === token &&
      Date.now() - message.createdAt <= 3000 && selectedGraph() === graph;
    try {
      let buffer = touch(decoded, message.id);
      if (!buffer) {
        if (decodingUsed + clip.decodedBytes > MAX_CACHE) throw new Error('Audio is still being prepared');
        while (decoded.size && decodedUsed + decodingUsed + clip.decodedBytes > MAX_CACHE) removeDecoded(firstKey(decoded));
        decodingUsed += clip.decodedBytes;
        try {
          buffer = await graph.context.decodeAudioData(clip.bytes.slice(0));
        } finally {
          decodingUsed -= clip.decodedBytes;
        }
        const size = decodedSize(buffer);
        if (size > MAX_CACHE) throw new Error('Sound is too large for Meet');
        if (generation !== stamp || sessionId !== expectedSession) return;
        removeDecoded(message.id);
        decoded.set(message.id, buffer);
        decodedUsed += size;
        while (decodedUsed > MAX_CACHE) removeDecoded(firstKey(decoded));
      }
      if (sessionId !== expectedSession || !current()) return;
      await graph.context.resume();
      if (!current()) return;
      const source = graph.context.createBufferSource();
      source.buffer = buffer;
      source.connect(graph.mix);
      playing.set(message.slot, source);
      source.onended = () => {
        source.disconnect();
        if (playing.get(message.slot) === source) playing.delete(message.slot);
      };
      source.start();
      error = '';
      report();
    } catch {
      error = 'Sound could not be played in Meet.';
      report();
    }
  }

  function receiveChunk(message: BridgeMessage) {
    if (!transfer || message.id !== transfer.id || message.index !== transfer.index || typeof message.data !== 'string' ||
      message.data.length > 192 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) {
      transfer = undefined;
      return;
    }
    try {
      const raw = atob(message.data);
      if (!raw.length || transfer.offset + raw.length > transfer.bytes.length) throw new Error('overflow');
      for (let i = 0; i < raw.length; i++) transfer.bytes[transfer.offset + i] = raw.charCodeAt(i);
      transfer.offset += raw.length;
      transfer.index++;
    } catch {
      transfer = undefined;
    }
  }

  function receive(message: BridgeMessage | null | undefined) {
    if (message?.v !== 1) return;
    if (message.type === 'connection') {
      stopEffects();
      clearCache();
      epoch = -1;
      connected = message.connected === true && typeof message.sessionId === 'string';
      sessionId = connected && typeof message.sessionId === 'string' ? message.sessionId : undefined;
      return;
    }
    if (!connected || message.sessionId !== sessionId) return;
    if (message.type === 'stop') {
      if (!isSafeInteger(message.epoch) || message.epoch < epoch) return;
      epoch = message.epoch;
      stopEffects();
      return;
    }
    if (message.type === 'clip-start') {
      transfer = undefined;
      const { id, byteLength, decodedBytes } = message;
      if (idOK(id) && isInteger(byteLength) && byteLength > 0 && byteLength <= MAX_CLIP && isInteger(decodedBytes) && decodedBytes > 0 && decodedBytes <= MAX_CACHE) {
        transfer = { id, bytes: new Uint8Array(byteLength), decodedBytes, offset: 0, index: 0 };
      }
      return;
    }
    if (message.type === 'clip-chunk') {
      receiveChunk(message);
      return;
    }
    if (message.type === 'clip-end') {
      if (transfer && message.id === transfer.id && transfer.offset === transfer.bytes.length) storeClip(transfer.id, transfer.bytes.buffer, transfer.decodedBytes);
      transfer = undefined;
      return;
    }
    const { id, slot, epoch: playEpoch, createdAt } = message;
    if (message.type === 'play' && idOK(id) && isInteger(slot) && slot >= 0 && slot < 16 && isSafeInteger(playEpoch) &&
      playEpoch >= epoch && typeof createdAt === 'number' && Number.isFinite(createdAt) && Math.abs(Date.now() - createdAt) <= 3000) {
      if (playEpoch > epoch) {
        stopEffects();
        epoch = playEpoch;
      }
      void play({ id, slot, createdAt });
    }
  }

  window.addEventListener('message', (event: MessageEvent<{ source?: unknown; message?: BridgeMessage } | null>) => {
    if (event.source === window && event.origin === location.origin && event.data?.source === 'klangdeck:bridge') receive(event.data.message);
  });
  setInterval(report, 1000);
  window.addEventListener('pagehide', () => {
    stopEffects();
    for (const graph of [...graphs]) for (const track of [...graph.tracks]) release(graph, track);
  });
}
