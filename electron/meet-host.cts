// Chrome native-messaging host. Electron runs this in Node mode; never launches the desktop app.
// It is copied next to meet-protocol.cjs outside the app bundle, so it must only require that file.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { extensionMessage, desktopMessage, encodeFrame, frameReader, isRecord, errorMessage } from './meet-protocol.cjs';

function privateEntry(filename: string, kind: 'isFile' | 'isDirectory' | 'isSocket') {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || !stat[kind]()) throw new Error('Unsafe Meet connection path.');
}

function run() {
  const args = process.argv.slice(2);
  const [flag, configPath, origin] = args;
  if (args.length !== 3 || flag !== '--config' || !configPath || !path.isAbsolute(configPath)) throw new Error('Invalid host invocation.');
  privateEntry(configPath, 'isFile');
  const config: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!isRecord(config) || typeof config.origin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(config.origin) || origin !== config.origin) throw new Error('Chrome extension not allowed.');
  if (typeof config.socket !== 'string' || !/^\/tmp\/klangdeck-\d+-[a-f0-9]{12}\/meet\.sock$/.test(config.socket)) throw new Error('Invalid socket path.');
  const socketPath = config.socket;
  privateEntry(path.dirname(socketPath), 'isDirectory');
  const disconnected = encodeFrame({ v: 1, type: 'connection', connected: false });
  try {
    privateEntry(socketPath, 'isSocket');
  } catch {
    process.stdout.write(disconnected);
    return;
  }
  const socket = net.createConnection(socketPath);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    process.stdin.pause();
    socket.destroy();
    process.stdout.write(disconnected, () => process.exit(0));
    setTimeout(() => process.exit(0), 300).unref();
  };
  socket.setTimeout(15000, finish);
  socket.on('error', finish);
  socket.on('close', finish);
  socket.on('data', frameReader(message => {
    if (!desktopMessage(message)) return finish();
    if (!process.stdout.write(encodeFrame(message))) {
      socket.pause();
      process.stdout.once('drain', () => socket.resume());
    }
  }, finish));
  process.stdin.on('data', frameReader(message => {
    if (!extensionMessage(message)) return finish();
    socket.setTimeout(15000);
    if (!socket.write(encodeFrame(message))) {
      process.stdin.pause();
      socket.once('drain', () => process.stdin.resume());
    }
  }, finish));
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  process.stdout.on('error', () => process.exit(0));
}

try {
  run();
} catch (error) {
  process.stderr.write(`Klangdeck Meet: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
