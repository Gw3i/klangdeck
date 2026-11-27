import { packager } from '@electron/packager';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.packaging', `stage-${Date.now()}`);
const extras = path.join(root, '.packaging', `meet-resources-${Date.now()}`);
const outputFlag = process.argv.indexOf('--out');
if (outputFlag !== -1 && !process.argv[outputFlag + 1]) throw new Error('--out requires an output directory.');
const output = outputFlag === -1 ? path.join(root, 'release') : path.resolve(process.argv[outputFlag + 1]);
await mkdir(stage, { recursive: true });
await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
await cp(path.join(root, 'electron'), path.join(stage, 'electron'), { recursive: true });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main }, null, 2));
await cp(path.join(root, 'README.md'), path.join(stage, 'README.md'));
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(stage, 'THIRD_PARTY_NOTICES.md'));
await cp(path.join(root, 'node_modules/three/LICENSE'), path.join(stage, 'THREE_LICENSE.txt'));
await cp(path.join(root, 'node_modules/lucide/LICENSE'), path.join(stage, 'LUCIDE_LICENSE.txt'));
await mkdir(path.join(extras,'meet-native'),{recursive:true});
await cp(path.join(root,'extension'),path.join(extras,'meet-extension'),{recursive:true});
for(const filename of ['meet-host.cjs','meet-protocol.cjs'])await cp(path.join(root,'electron',filename),path.join(extras,'meet-native',filename));
const apps = await packager({
  dir: stage, out: path.join(root, '.packaging', 'app'), name: 'Klangdeck',
  platform: 'darwin', arch: 'arm64', electronVersion: pkg.devDependencies.electron,
  appBundleId: 'local.klangdeck.soundboard', appVersion: pkg.version,
  icon: path.join(root, 'assets/icon.icns'),
  extraResource:[path.join(extras,'meet-native'),path.join(extras,'meet-extension')],
  appCopyright: 'Klangdeck', asar: true, prune: false, overwrite: true
});
await mkdir(output, { recursive: true });
await cp(path.join(apps[0], 'Klangdeck.app'), path.join(output, 'Klangdeck.app'), { recursive: true, force: true, verbatimSymlinks: true });
console.log(`Packaged: ${path.join(output, 'Klangdeck.app')}`);
