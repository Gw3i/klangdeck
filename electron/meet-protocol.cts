// Length-prefixed JSON frames shared by the desktop app and the Chrome native host.
export const MAX_FRAME = 256 * 1024;
export const MAX_CLIP = 25 * 1024 * 1024;
export const MAX_CACHE = 64 * 1024 * 1024;
export const CHUNK_BYTES = 96 * 1024;

type Message = Record<string, unknown>;

interface StatusMessage {
  v: 1;
  type: 'status';
  sessionId: string;
  eligible: number;
  muted: boolean;
  error?: string;
}
interface HeartbeatMessage {
  v: 1;
  type: 'heartbeat';
  sessionId: string;
}
type ExtensionMessage = StatusMessage | HeartbeatMessage;

export const isRecord = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(value);
export const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const onlyKeys = (message: Message, keys: string[]) => Object.keys(message).every(key => keys.includes(key));

export function extensionMessage(message: unknown): message is ExtensionMessage {
  if (!isRecord(message) || message.v !== 1 || !validId(message.sessionId)) return false;
  if (message.type === 'heartbeat') return onlyKeys(message, ['v', 'type', 'sessionId']);
  return message.type === 'status' && integer(message.eligible, 0, 1000) && typeof message.muted === 'boolean' &&
    (message.error === undefined || typeof message.error === 'string' && message.error.length <= 240) &&
    onlyKeys(message, ['v', 'type', 'sessionId', 'eligible', 'muted', 'error']);
}

export function desktopMessage(message: unknown): message is Message {
  if (!isRecord(message) || message.v !== 1) return false;
  if (message.type === 'connection') return typeof message.connected === 'boolean';
  if (!validId(message.sessionId)) return false;
  if (message.type === 'stop') return integer(message.epoch, 0, Number.MAX_SAFE_INTEGER);
  if (!validId(message.id)) return false;
  if (message.type === 'clip-start') return integer(message.byteLength, 1, MAX_CLIP) && integer(message.decodedBytes, 1, MAX_CACHE);
  if (message.type === 'clip-chunk') {
    return integer(message.index, 0, Math.ceil(MAX_CLIP / CHUNK_BYTES)) && typeof message.data === 'string' &&
      message.data.length <= Math.ceil(CHUNK_BYTES / 3) * 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data);
  }
  if (message.type === 'clip-end') return true;
  return message.type === 'play' && integer(message.slot, 0, 15) && integer(message.epoch, 0, Number.MAX_SAFE_INTEGER) &&
    Number.isFinite(message.createdAt);
}

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > MAX_FRAME) throw new Error('Invalid Meet message size.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** Returns a stream `data` handler. After the first error it ignores all further input. */
export function frameReader(onMessage: (message: unknown) => void, onError: (error: unknown) => void) {
  let buffered: Buffer = Buffer.alloc(0), failed = false;
  return (data: Buffer) => {
    if (failed) return;
    try {
      buffered = buffered.length ? Buffer.concat([buffered, data]) : data;
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (!size || size > MAX_FRAME) throw new Error('Invalid Meet message size.');
        if (buffered.length < size + 4) break;
        const message: unknown = JSON.parse(buffered.subarray(4, size + 4).toString('utf8'));
        buffered = buffered.subarray(size + 4);
        onMessage(message);
      }
    } catch (error) {
      failed = true;
      buffered = Buffer.alloc(0);
      onError(error);
    }
  };
}
