// Chrome native-messaging host. Electron runs this in Node mode; never launches the desktop app.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { extensionMessage, desktopMessage, encodeFrame, frameReader } = require('./meet-protocol.cjs');

function privateEntry(filename, kind) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || !stat[kind]()) throw new Error('Unsafe Meet connection path.');
}
function run() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--config' || !path.isAbsolute(args[1])) throw new Error('Invalid host invocation.');
  privateEntry(args[1], 'isFile');
  const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(config.origin) || args[2] !== config.origin) throw new Error('Chrome extension not allowed.');
  if (typeof config.socket !== 'string' || !/^\/tmp\/klangdeck-\d+-[a-f0-9]{12}\/meet\.sock$/.test(config.socket)) throw new Error('Invalid socket path.');
  privateEntry(path.dirname(config.socket), 'isDirectory');
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    process.stdin.pause(); socket.destroy();
    process.stdout.write(encodeFrame({ v:1, type:'connection', connected:false }), () => process.exit(0));
    setTimeout(() => process.exit(0), 300).unref();
  };
  try { privateEntry(config.socket, 'isSocket'); } catch { process.stdout.write(encodeFrame({v:1,type:'connection',connected:false})); return; }
  const socket = net.createConnection(config.socket);
  socket.setTimeout(15000, finish);
  socket.on('error', finish); socket.on('close', finish);
  socket.on('data', frameReader(message => {
    if (!desktopMessage(message)) return finish();
    if (!process.stdout.write(encodeFrame(message))) { socket.pause(); process.stdout.once('drain', () => socket.resume()); }
  }, finish));
  process.stdin.on('data', frameReader(message => {
    if (!extensionMessage(message)) return finish();
    socket.setTimeout(15000);
    if (!socket.write(encodeFrame(message))) { process.stdin.pause(); socket.once('drain', () => process.stdin.resume()); }
  }, finish));
  process.stdin.on('end', finish); process.stdin.on('error', finish);
  process.stdout.on('error', () => process.exit(0));
}
try { run(); } catch (error) { process.stderr.write(`Klangdeck Meet: ${error.message}\n`); process.exitCode = 1; }
