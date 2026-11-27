// Packages the already-built app (`npm run build`) as a local arm64 Klangdeck.app.
import { packager } from '@electron/packager';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface PackageJson {
  name: string;
  version: string;
  description: string;
  main: string;
  devDependencies: { electron: string };
}

const root = path.resolve(import.meta.dirname, '..');
const build = path.join(root, 'build');
const stage = path.join(root, '.packaging', `stage-${Date.now()}`);
const extras = path.join(root, '.packaging', `meet-resources-${Date.now()}`);
const outputFlag = process.argv.indexOf('--out');
if (outputFlag !== -1 && !process.argv[outputFlag + 1]) throw new Error('--out requires an output directory.');
const output = outputFlag === -1 ? path.join(root, 'release') : path.resolve(process.argv[outputFlag + 1]);
const withoutDeclarations = (source: string) => !source.endsWith('.d.cts');

// The stage mirrors the project layout, so build/electron/main.cjs finds ../../dist and its preload.
await mkdir(stage, { recursive: true });
await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
await cp(path.join(build, 'electron'), path.join(stage, 'build/electron'), { recursive: true, filter: withoutDeclarations });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as PackageJson;
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main }, null, 2));
await cp(path.join(root, 'README.md'), path.join(stage, 'README.md'));
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(stage, 'THIRD_PARTY_NOTICES.md'));
await cp(path.join(root, 'node_modules/three/LICENSE'), path.join(stage, 'THREE_LICENSE.txt'));
await cp(path.join(root, 'node_modules/lucide/LICENSE'), path.join(stage, 'LUCIDE_LICENSE.txt'));
// Chrome and the native host need real files outside the asar archive.
await mkdir(path.join(extras, 'meet-native'), { recursive: true });
await cp(path.join(build, 'extension'), path.join(extras, 'meet-extension'), { recursive: true });
for (const filename of ['meet-host.cjs', 'meet-protocol.cjs']) await cp(path.join(build, 'electron', filename), path.join(extras, 'meet-native', filename));
// macOS shows the lowercase name (packager writes it to CFBundleName and CFBundleDisplayName).
// The delivered bundle keeps the Klangdeck.app folder name and the same bundle ID.
const apps = await packager({
  dir: stage, out: path.join(root, '.packaging', 'app'), name: 'klangdeck',
  platform: 'darwin', arch: 'arm64', electronVersion: pkg.devDependencies.electron,
  appBundleId: 'local.klangdeck.soundboard', appVersion: pkg.version,
  icon: path.join(root, 'assets/icon.icns'),
  extraResource: [path.join(extras, 'meet-native'), path.join(extras, 'meet-extension')],
  appCopyright: 'Klangdeck', asar: true, prune: false, overwrite: true
});
const target = path.join(output, 'Klangdeck.app');
await mkdir(output, { recursive: true });
// Replace, never merge: an older bundle's differently named executable and helpers would otherwise remain inside.
await rm(target, { recursive: true, force: true });
await cp(path.join(apps[0], 'klangdeck.app'), target, { recursive: true, verbatimSymlinks: true });
console.log(`Packaged: ${target}`);
