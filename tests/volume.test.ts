import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecFileOptions } from 'node:child_process';
import { normalizeVolume, parseVolume, createVolumeControl } from '../build/electron/volume.cjs';

test('rejects injection and nonfinite values; clamps numeric endpoints', () => {
  for (const value of ['50', '0; do shell script "bad"', NaN, Infinity, null, {}]) assert.throws(() => normalizeVolume(value));
  assert.equal(normalizeVolume(-10), 0);
  assert.equal(normalizeVolume(200), 100);
  assert.equal(normalizeVolume(42.6), 43);
});
test('parses real volume and mute state, rejecting malformed output', () => {
  assert.deepEqual(parseVolume('42|false\n'), { volume: 42, muted: false });
  assert.deepEqual(parseVolume('0|true'), { volume: 0, muted: true });
  for (const value of ['', '101|false', '42|unknown', 'output volume:42', '42|false\nbad']) assert.throws(() => parseVolume(value));
});
test('coalesces slider movement and uses a fixed executable without a shell', async () => {
  const calls: { file: string; args: string[]; options: ExecFileOptions }[] = [];
  const control = createVolumeControl(async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: args[1].startsWith('set s') ? '70|false\n' : '' };
  });
  const results = await Promise.all([control.setVolume(20), control.setVolume(50), control.setVolume(70)]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.equal(calls[0].args[1], 'set volume output volume 70\nset volume without output muted');
  assert.equal(calls[0].options.shell, undefined);
  assert.deepEqual(results, Array(3).fill({ volume: 70, muted: false }));
});
test('unsupported device rejects and a later request can recover', async () => {
  let actual = 100;
  const control = createVolumeControl(async () => ({ stdout: `${actual}|false` }));
  await assert.rejects(control.setVolume(50), /output device/);
  actual = 50;
  assert.deepEqual(await control.getVolume(), { volume: 50, muted: false });
  assert.deepEqual(await control.setVolume(50), { volume: 50, muted: false });
});
test('process failures reject all queued slider requests', async () => {
  const control = createVolumeControl(async () => { throw new Error('timeout'); });
  const results = await Promise.allSettled([control.setVolume(30), control.setVolume(40)]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof Error && result.reason.message === 'timeout'));
});
