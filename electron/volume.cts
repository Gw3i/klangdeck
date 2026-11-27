import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { MacVolume } from '../shared/contracts.ts';

type Execute = (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>;

const run: Execute = async (file, args, options) => {
  const { stdout } = await promisify(execFile)(file, args, { ...options, encoding: 'utf8' });
  return { stdout };
};
const OSASCRIPT = '/usr/bin/osascript';
const OPTIONS = { timeout: 2500, maxBuffer: 4096 };
const READ_SCRIPT = 'set s to get volume settings\nreturn ((output volume of s) as text) & "|" & ((output muted of s) as text)';

export function normalizeVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Invalid volume.');
  return Math.round(Math.max(0, Math.min(100, value)));
}

export function parseVolume(output: string): MacVolume {
  const match = /^(\d{1,3})\|(true|false)$/.exec(output.trim());
  if (!match || Number(match[1]) > 100) throw new Error('Could not read the Mac volume.');
  return { volume: Number(match[1]), muted: match[2] === 'true' };
}

interface Listener {
  resolve(value: MacVolume): void;
  reject(error: unknown): void;
}

export function createVolumeControl(execute: Execute = run) {
  let writes: Promise<MacVolume | void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let pending: Listener[] = [];
  let requested = 0;
  async function read() {
    const { stdout } = await execute(OSASCRIPT, ['-e', READ_SCRIPT], OPTIONS);
    return parseVolume(stdout);
  }
  return {
    async getVolume() {
      await writes.catch(() => {});
      return read();
    },
    setVolume(value: unknown) {
      const volume = normalizeVolume(value);
      requested = volume;
      clearTimeout(timer);
      return new Promise<MacVolume>((resolve, reject) => {
        pending.push({ resolve, reject });
        timer = setTimeout(() => {
          const listeners = pending;
          const target = requested;
          pending = [];
          const write = writes.catch(() => {}).then(async () => {
            await execute(OSASCRIPT, ['-e', `set volume output volume ${target}\nset volume ${target > 0 ? 'without' : 'with'} output muted`], OPTIONS);
            const actual = await read();
            if (Math.abs(actual.volume - target) > 2 || (target > 0 && actual.muted)) {
              throw new Error('This output device does not support Mac volume control. Use its own volume control.');
            }
            return actual;
          });
          writes = write;
          write.then(result => listeners.forEach(listener => listener.resolve(result)), error => listeners.forEach(listener => listener.reject(error)));
        }, 60);
      });
    }
  };
}
