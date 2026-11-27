// Rebuilds the macOS app icon from the committed artwork in assets/icon.png.
// Uses only the built-in macOS tools `sips` and `iconutil`. Usage: node scripts/build-icon.ts [output.icns]
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'assets/icon.png');
const output = path.resolve(process.argv[2] ?? path.join(root, 'assets/icon.icns'));
const iconset = path.join(root, '.packaging', 'Klangdeck.iconset');

await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const [scale, suffix] of [[1, ''], [2, '@2x']] as const) {
    const pixels = String(size * scale);
    execFileSync('/usr/bin/sips', ['-z', pixels, pixels, source, '--out', path.join(iconset, `icon_${size}x${size}${suffix}.png`)], { stdio: 'ignore' });
  }
}
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', output]);
console.log(`Icon: ${output}`);
