const MAX_FRAME = 256 * 1024;
const MAX_CLIP = 25 * 1024 * 1024;
const MAX_CACHE = 64 * 1024 * 1024;
const CHUNK_BYTES = 96 * 1024;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function extensionMessage(message) {
  if (!message || message.v !== 1 || !validId(message.sessionId)) return false;
  if (message.type === 'heartbeat') return Object.keys(message).every(k => ['v','type','sessionId'].includes(k));
  return message.type === 'status' && integer(message.eligible, 0, 1000) && typeof message.muted === 'boolean' &&
    (message.error === undefined || typeof message.error === 'string' && message.error.length <= 240) &&
    Object.keys(message).every(k => ['v','type','sessionId','eligible','muted','error'].includes(k));
}
function desktopMessage(message) {
  if (!message || message.v !== 1) return false;
  if (message.type === 'connection') return typeof message.connected === 'boolean';
  if (!validId(message.sessionId)) return false;
  if (message.type === 'stop') return integer(message.epoch, 0, Number.MAX_SAFE_INTEGER);
  if (!validId(message.id)) return false;
  if (message.type === 'clip-start') return integer(message.byteLength, 1, MAX_CLIP) && integer(message.decodedBytes, 1, MAX_CACHE);
  if (message.type === 'clip-chunk') return integer(message.index, 0, Math.ceil(MAX_CLIP / CHUNK_BYTES)) && typeof message.data === 'string' && message.data.length <= Math.ceil(CHUNK_BYTES / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data);
  if (message.type === 'clip-end') return true;
  return message.type === 'play' && integer(message.slot, 0, 15) && integer(message.epoch, 0, Number.MAX_SAFE_INTEGER) && Number.isFinite(message.createdAt);
}
function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > MAX_FRAME) throw new Error('Invalid Meet message size.');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function frameReader(onMessage, onError) {
  let buffered = Buffer.alloc(0), failed = false;
  return data => {
    if (failed) return;
    try {
      buffered = buffered.length ? Buffer.concat([buffered, data]) : data;
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (!size || size > MAX_FRAME) throw new Error('Invalid Meet message size.');
        if (buffered.length < size + 4) break;
        const message = JSON.parse(buffered.subarray(4, size + 4).toString('utf8'));
        buffered = buffered.subarray(size + 4);
        onMessage(message);
      }
    } catch (error) { failed = true; buffered = Buffer.alloc(0); onError(error); }
  };
}

module.exports = { MAX_FRAME, MAX_CLIP, MAX_CACHE, CHUNK_BYTES, validId, integer, extensionMessage, desktopMessage, encodeFrame, frameReader };
