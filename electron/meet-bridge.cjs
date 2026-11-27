const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { MAX_CLIP, MAX_CACHE, CHUNK_BYTES, validId, integer, extensionMessage, encodeFrame, frameReader } = require('./meet-protocol.cjs');
const HOST_NAME = 'local.klangdeck.meet';
const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const socketLocation = profile => `/tmp/klangdeck-${process.getuid()}-${crypto.createHash('sha256').update(path.resolve(profile)).digest('hex').slice(0,12)}/meet.sock`;

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive:true, mode:0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('Unsafe Meet connection path.');
  await fs.chmod(directory, 0o700);
}
async function privateWrite(filename, data, mode) {
  try { const stat=await fs.lstat(filename);if(stat.isSymbolicLink()||!stat.isFile()||stat.uid!==process.getuid())throw new Error('Unsafe Meet setup file.'); }
  catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.writeFile(filename,data,{mode});await fs.chmod(filename,mode);
}
function extensionId(key) {
  if (typeof key !== 'string' || key.length > 4096) throw new Error('Invalid extension key.');
  const der = Buffer.from(key, 'base64');
  crypto.createPublicKey({ key:der, format:'der', type:'spki' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0,32).replace(/[0-9a-f]/g, hex => String.fromCharCode(97 + parseInt(hex,16)));
}

function createMeetBridge({ userData, extensionSource, hostSource, executable, registrationDirectory, onStatus = () => {}, now = Date.now }) {
  const socketPath = socketLocation(userData);
  const extensionPath = path.join(userData, 'meet-extension');
  const nativePath = path.join(userData, 'meet-native');
  const clients = new Map(), cache = new Map();
  let server, timer, prepared = false, preparePromise, problem = '', epoch = now(), queue = [], queuedBytes = 0, processing = false, stopped = false;
  const slots = Array(16).fill(0);
  let generation = 0, inFlightBytes = 0, ownsSocket = false;
  function status() {
    const entries = [...clients.values()];
    const client = entries.length === 1 ? entries[0] : null;
    const eligible = entries.length > 1 ? 2 : client?.eligible || 0;
    return { prepared, connected:entries.length > 0, eligible, sessionId:client?.sessionId||null, muted:client?.muted || false, ready:!!client && eligible === 1 && !problem, error:problem || (entries.length > 1 ? 'Multiple Chrome connections are open.' : client?.error || ''), extensionPath };
  }
  const publish = () => onStatus(status());
  function target() {
    if (!status().ready) return null;
    return clients.values().next().value;
  }
  function send(client, message) {
    if (!client.socket.destroyed) client.socket.write(encodeFrame(message));
  }
  function stop() {
    epoch++; generation++;
    for (const job of queue) job.resolve({ sent:false, reason:'stopped' });
    queue = []; queuedBytes = 0;
    for (const client of clients.values()) if (client.sessionId) send(client, { v:1, type:'stop', sessionId:client.sessionId, epoch });
    return { stopped:true };
  }
  function reset() { stop(); cache.clear(); }
  async function start() {
    try {
      await privateDirectory(path.dirname(socketPath));
      try {
        const stat = await fs.lstat(socketPath);
        if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Unsafe Meet socket.');
        const active = await new Promise(resolve => { const probe=net.createConnection(socketPath);probe.once('connect',()=>{probe.destroy();resolve(true);});probe.once('error',()=>resolve(false)); });
        if (active) throw new Error('Another Klangdeck connection is already active.');
        await fs.unlink(socketPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      server = net.createServer(socket => {
        const client = { socket, sessionId:'', eligible:0, muted:false, error:'', lastSeen:now() };
        clients.set(socket,client); reset();
        send(client,{v:1,type:'connection',connected:true}); publish();
        socket.on('data',frameReader(message => {
          if (!extensionMessage(message)) { socket.destroy(); return; }
          client.lastSeen=now();
          if (message.type==='heartbeat') return;
          if (client.sessionId!==message.sessionId || client.eligible!==message.eligible) reset();
          if (message.error) cache.clear();
          Object.assign(client,{sessionId:message.sessionId,eligible:message.eligible,muted:message.muted,error:message.error||''});publish();
        },()=>socket.destroy()));
        socket.on('error',()=>socket.destroy());
        socket.on('close',()=>{clients.delete(socket);reset();publish();});
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
      ownsSocket=true;
      await fs.chmod(socketPath,0o600);
      try { const m=JSON.parse(await fs.readFile(path.join(registrationDirectory,`${HOST_NAME}.json`),'utf8'));prepared=m.name===HOST_NAME&&m.path===path.join(nativePath,'launch-host'); } catch {}
      timer=setInterval(()=>{for(const client of clients.values())if(now()-client.lastSeen>12000)client.socket.destroy();},1000);timer.unref();
      publish();
    } catch (error) { problem=error.message;publish(); }
  }
  async function prepare() {
    if (preparePromise) return preparePromise;
    preparePromise=(async()=>{
      await privateDirectory(userData);await privateDirectory(nativePath);
      const manifest=JSON.parse(await fs.readFile(path.join(extensionSource,'manifest.json'),'utf8'));
      const id=extensionId(manifest.key), origin=`chrome-extension://${id}/`;
      await privateDirectory(extensionPath);
      await fs.cp(extensionSource,extensionPath,{recursive:true,force:true,verbatimSymlinks:true});
      await privateWrite(path.join(nativePath,'meet-host.cjs'),await fs.readFile(path.join(hostSource,'meet-host.cjs')),0o600);
      await privateWrite(path.join(nativePath,'meet-protocol.cjs'),await fs.readFile(path.join(hostSource,'meet-protocol.cjs')),0o600);
      const configPath=path.join(nativePath,'config.json');
      await privateWrite(configPath,JSON.stringify({socket:socketPath,origin}),0o600);
      const launcher=path.join(nativePath,'launch-host');
      await privateWrite(launcher,`#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(executable)} ${shellQuote(path.join(nativePath,'meet-host.cjs'))} --config ${shellQuote(configPath)} "$@"\n`,0o700);
      await privateDirectory(registrationDirectory);
      const registration={name:HOST_NAME,description:'Klangdeck audio for Google Meet',path:launcher,type:'stdio',allowed_origins:[origin]};
      await privateWrite(path.join(registrationDirectory,`${HOST_NAME}.json`),JSON.stringify(registration,null,2),0o600);
      prepared=true;publish();return {...status(),extensionId:id};
    })();
    try { return await preparePromise; } finally { preparePromise=null; }
  }
  function remember(id,size) {
    cache.delete(id);cache.set(id,size);
    let total=[...cache.values()].reduce((a,b)=>a+b,0);
    while(total>MAX_CACHE){const [key,bytes]=cache.entries().next().value;cache.delete(key);total-=bytes;}
  }
  async function write(client,message,job) {
    if (stopped || generation!==job.generation || target()!==client || client.sessionId!==job.sessionId) throw new Error('cancelled');
    if (client.socket.write(encodeFrame(message))) return;
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>done(new Error('Meet connection is too slow.')),2000);
      const drain=()=>done(), close=()=>done(new Error('Connection closed.'));
      function done(error){clearTimeout(timeout);client.socket.off('drain',drain);client.socket.off('close',close);error?reject(error):resolve();}
      client.socket.once('drain',drain);client.socket.once('close',close);
    });
  }
  async function processQueue() {
    if(processing)return;processing=true;
    while(queue.length){
      const job=queue.shift();queuedBytes-=job.bytes.byteLength;inFlightBytes=job.bytes.byteLength;
      const client=target();
      if(!client||job.generation!==generation||now()-job.createdAt>3000||job.sequence!==slots[job.slot]){inFlightBytes=0;job.resolve({sent:false,reason:'stale'});continue;}
      try{
        const envelope={v:1,sessionId:job.sessionId,id:job.id};
        if(!cache.has(job.id)){
          await write(client,{...envelope,type:'clip-start',byteLength:job.bytes.byteLength,decodedBytes:job.decodedBytes},job);
          for(let start=0,index=0;start<job.bytes.byteLength;start+=CHUNK_BYTES,index++)await write(client,{...envelope,type:'clip-chunk',index,data:job.bytes.subarray(start,start+CHUNK_BYTES).toString('base64')},job);
          await write(client,{...envelope,type:'clip-end'},job);remember(job.id,job.bytes.byteLength);
        }
        if(now()-job.createdAt>3000||job.sequence!==slots[job.slot]){job.resolve({sent:false,reason:'stale'});continue;}
        await write(client,{...envelope,type:'play',slot:job.slot,epoch,createdAt:job.createdAt},job);remember(job.id,job.bytes.byteLength);
        job.resolve({sent:true});
      }catch(error){if(error.message!=='cancelled')client.socket.destroy();job.resolve({sent:false,reason:error.message==='cancelled'?'stopped':'connection'});}
      finally{inFlightBytes=0;}
    }
    processing=false;
  }
  function play(payload) {
    if(!payload||!integer(payload.slot,0,15)||!validId(payload.id)||!validId(payload.sessionId)||!Number.isFinite(payload.createdAt)||payload.createdAt>now()+1000||now()-payload.createdAt>3000)throw new Error('Invalid Meet sound.');
    const input=payload.bytes;
    if(!(input instanceof ArrayBuffer)&&!ArrayBuffer.isView(input))throw new Error('Invalid audio data.');
    const length=input.byteLength;
    if(!length||length>MAX_CLIP)throw new Error('Meet sounds must be 25 MB or smaller.');
    if(!integer(payload.decodedBytes,1,MAX_CACHE))throw new Error('This sound is too large for Meet after decoding (64 MB maximum).');
    const client=target();if(!client)return Promise.resolve({sent:false,reason:'unavailable'});
    if(client.sessionId!==payload.sessionId)return Promise.resolve({sent:false,reason:'stale'});
    if(queue.length>=16||queuedBytes+inFlightBytes+length>MAX_CACHE)return Promise.resolve({sent:false,reason:'busy'});
    const bytes=ArrayBuffer.isView(input)?Buffer.from(input.buffer,input.byteOffset,input.byteLength):Buffer.from(input);
    return new Promise(resolve=>{queue.push({slot:payload.slot,id:payload.id,bytes,decodedBytes:payload.decodedBytes,createdAt:payload.createdAt,sessionId:client.sessionId,generation,sequence:++slots[payload.slot],resolve});queuedBytes+=length;processQueue();});
  }
  async function close() {
    stopped=true;stop();clearInterval(timer);
    for(const client of clients.values())client.socket.destroy();
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    if(ownsSocket){await fs.unlink(socketPath).catch(()=>{});ownsSocket=false;}
  }
  return {start,prepare,status,play,stop,close,extensionPath,socketPath};
}
module.exports={createMeetBridge,socketLocation,privateDirectory,extensionId,shellQuote};
