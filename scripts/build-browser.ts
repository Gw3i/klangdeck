// Builds each extension script and the audio test fixture as one self-contained classic script.
// Chrome loads content scripts and service workers without module imports, so nothing may stay unresolved.
import { build } from 'vite';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const extension = path.join(root, 'build/extension');
const scripts = [
  ...['background', 'content', 'mixer', 'popup'].map(name => ({ entry: `extension/${name}.ts`, outDir: extension })),
  { entry: 'tests/meet-audio-fixture.ts', outDir: path.join(root, 'build/tests') }
];

await rm(extension, { recursive: true, force: true });
await mkdir(extension, { recursive: true });
for (const { entry, outDir } of scripts) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      copyPublicDir: false,
      lib: { entry: path.join(root, entry), formats: ['iife'], name: 'klangdeck', fileName: () => `${path.basename(entry, '.ts')}.js` }
    }
  });
}
for (const file of ['manifest.json', 'popup.html']) await cp(path.join(root, 'extension', file), path.join(extension, file));
