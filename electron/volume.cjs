const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const READ_SCRIPT = 'set s to get volume settings\nreturn ((output volume of s) as text) & "|" & ((output muted of s) as text)';

function normalizeVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Invalid volume.');
  return Math.round(Math.max(0, Math.min(100, value)));
}

function parseVolume(output) {
  const match = /^(\d{1,3})\|(true|false)$/.exec(output.trim());
  if (!match || Number(match[1]) > 100) throw new Error('Could not read the Mac volume.');
  return { volume: Number(match[1]), muted: match[2] === 'true' };
}

function createVolumeControl(execute = run) {
  let writes = Promise.resolve();
  let timer;
  let pending = [];
  let requested = 0;
  async function read() {
    const { stdout } = await execute('/usr/bin/osascript', ['-e', READ_SCRIPT], { timeout: 2500, maxBuffer: 4096 });
    return parseVolume(stdout);
  }
  return {
    async getVolume() {
      await writes.catch(() => {});
      return read();
    },
    setVolume(value) {
      const volume = normalizeVolume(value);
      requested = volume;
      clearTimeout(timer);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        timer = setTimeout(() => {
          const listeners = pending;
          const target = requested;
          pending = [];
          writes = writes.catch(() => {}).then(async () => {
            await execute('/usr/bin/osascript', ['-e', `set volume output volume ${target}\nset volume ${target > 0 ? 'without' : 'with'} output muted`], { timeout: 2500, maxBuffer: 4096 });
            const actual = await read();
            if (Math.abs(actual.volume - target) > 2 || (target > 0 && actual.muted)) {
              throw new Error('This output device does not support Mac volume control. Use its own volume control.');
            }
            return actual;
          });
          writes.then(result => listeners.forEach(listener => listener.resolve(result)), error => listeners.forEach(listener => listener.reject(error)));
        }, 60);
      });
    }
  };
}

module.exports = { createVolumeControl, normalizeVolume, parseVolume };
