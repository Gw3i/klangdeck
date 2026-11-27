const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {createMeetBridge,socketLocation,privateDirectory,extensionId,shellQuote}=require('../electron/meet-bridge.cjs');
const {MAX_FRAME,MAX_CLIP,MAX_CACHE,CHUNK_BYTES,encodeFrame,frameReader,extensionMessage,desktopMessage}=require('../electron/meet-protocol.cjs');
const root=path.resolve(__dirname,'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,message='condition',timeout=2500){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await delay(5);}throw new Error(`Timed out: ${message}`);}
async function fixture(t,extra={}){
  await fs.mkdir(path.join(root,'.qa/meet-native'),{recursive:true});
  const directory=await fs.mkdtemp(path.join(root,'.qa/meet-native/profile-'));
  const bridge=createMeetBridge({userData:directory,registrationDirectory:path.join(directory,'qa-native-messaging-hosts'),extensionSource:path.join(root,'extension'),hostSource:path.join(root,'electron'),executable:process.execPath,...extra});
  t.after(()=>bridge.close());await bridge.start();
  assert.equal(bridge.status().error,'');
  return {bridge,directory};
}
async function connect(t,bridge,sessionId='session-1'){
  const socket=net.createConnection(bridge.socketPath),messages=[];
  socket.on('data',frameReader(m=>messages.push(m),error=>{throw error;}));socket.on('error',()=>{});
  t.after(()=>socket.destroy());
  await new Promise(resolve=>socket.once('connect',resolve));
  socket.write(encodeFrame({v:1,type:'status',sessionId,eligible:1,muted:false}));
  await until(()=>bridge.status().sessionId===sessionId);
  return {socket,messages};
}
const payload=(overrides={})=>({slot:0,id:'clip-1',sessionId:'session-1',bytes:new Uint8Array([1,2,3,4]),decodedBytes:16,createdAt:Date.now(),...overrides});

test('framing handles split/coalesced input and rejects malformed/oversized frames',()=>{
  const messages=[],errors=[];const read=frameReader(m=>messages.push(m),e=>errors.push(e));
  const a={v:1,type:'heartbeat',sessionId:'test'},encoded=encodeFrame(a);
  read(encoded.subarray(0,2));read(Buffer.concat([encoded.subarray(2),encoded]));
  assert.deepEqual(messages,[a,a]);assert.equal(errors.length,0);
  const invalid=Buffer.alloc(4);invalid.writeUInt32LE(MAX_FRAME+1);read(invalid);read(encoded);
  assert.equal(errors.length,1);assert.equal(messages.length,2);
  const malformed=[];frameReader(()=>assert.fail(),e=>malformed.push(e))(Buffer.from([1,0,0,0,123]));assert.equal(malformed.length,1);
  assert.throws(()=>encodeFrame({payload:'x'.repeat(MAX_FRAME)}));
});

test('protocol accepts only status/heartbeat upstream and bounded typed clip fields',()=>{
  assert.ok(extensionMessage({v:1,type:'status',sessionId:'s',eligible:1,muted:false}));
  for(const message of [{v:1,type:'exec',sessionId:'s'},{v:1,type:'status',sessionId:'s',eligible:1,muted:false,path:'/etc/passwd'},{v:1,type:'heartbeat',sessionId:'../bad'},{v:1,type:'status',sessionId:'s',eligible:-1,muted:false}])assert.equal(extensionMessage(message),false);
  assert.ok(desktopMessage({v:1,type:'clip-start',sessionId:'s',id:'a',byteLength:MAX_CLIP,decodedBytes:MAX_CACHE}));
  assert.equal(desktopMessage({v:1,type:'clip-start',sessionId:'s',id:'a',byteLength:MAX_CLIP+1,decodedBytes:16}),false);
  assert.equal(desktopMessage({v:1,type:'clip-start',sessionId:'s',id:'a',byteLength:1,decodedBytes:MAX_CACHE+1}),false);
  assert.equal(desktopMessage({v:1,type:'clip-chunk',sessionId:'s',id:'a',index:0,data:'not base64!'}),false);
  assert.ok(encodeFrame({v:1,type:'clip-chunk',sessionId:'s',id:'a',index:0,data:Buffer.alloc(CHUNK_BYTES).toString('base64')}).length<MAX_FRAME);
});

test('socket path is short, permissions private, setup explicit and QA registration isolated',async t=>{
  const {bridge,directory}=await fixture(t);
  assert.ok(Buffer.byteLength(socketLocation('/very-long/'.repeat(30)))<104);
  assert.equal((await fs.stat(path.dirname(bridge.socketPath))).mode&0o777,0o700);
  assert.equal((await fs.stat(bridge.socketPath)).mode&0o777,0o600);
  await assert.rejects(fs.access(path.join(directory,'qa-native-messaging-hosts')));
  const result=await bridge.prepare();
  assert.equal(result.extensionId,'biflmfgmofkfjhhchkhgdfenipjhmdjg');
  const registration=JSON.parse(await fs.readFile(path.join(directory,'qa-native-messaging-hosts/local.klangdeck.meet.json'),'utf8'));
  assert.deepEqual(registration.allowed_origins,[`chrome-extension://${result.extensionId}/`]);
  assert.equal(registration.path,path.join(directory,'meet-native/launch-host'));
  const second=await bridge.prepare();assert.equal(second.extensionPath,result.extensionPath);
  assert.equal(extensionId(JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json'),'utf8')).key),result.extensionId);
});

test('unsafe directory symlink and forged extension key are rejected',async t=>{
  const {directory}=await fixture(t);
  const link=path.join(directory,'symlink');await fs.symlink(directory,link);
  await assert.rejects(privateDirectory(link),/Unsafe/);
  assert.throws(()=>extensionId('not-a-public-key'));
  assert.equal(shellQuote("path with ' quote"),"'path with '\\'' quote'");
});

test('cached playback retries after transient receiver error and blocks multiple destinations',async t=>{
  const {bridge}=await fixture(t);const {socket,messages}=await connect(t,bridge);
  assert.deepEqual(await bridge.play(payload()),{sent:true});
  assert.deepEqual(await bridge.play(payload()),{sent:true});
  await until(()=>messages.filter(m=>m.type==='play').length===2);
  assert.equal(messages.filter(m=>m.type==='clip-start').length,1);
  socket.write(encodeFrame({v:1,type:'status',sessionId:'session-1',eligible:1,muted:false,error:'Please play the sound again.'}));
  await until(()=>!!bridge.status().error);
  assert.equal(bridge.status().ready,true);
  assert.deepEqual(await bridge.play(payload()),{sent:true});
  await until(()=>messages.filter(m=>m.type==='play').length===3);
  assert.equal(messages.filter(m=>m.type==='clip-start').length,2);
  socket.write(encodeFrame({v:1,type:'status',sessionId:'session-many',eligible:2,muted:false}));
  await until(()=>bridge.status().eligible===2);
  assert.deepEqual(await bridge.play(payload({sessionId:'session-many'})),{sent:false,reason:'unavailable'});
});

test('stop cancels in-flight transfer and reconnect does not replay old presses',async t=>{
  const {bridge}=await fixture(t);const first=await connect(t,bridge);
  const pending=bridge.play(payload({bytes:new Uint8Array(CHUNK_BYTES*3)}));bridge.stop();
  assert.equal((await pending).sent,false);
  await delay(30);assert.equal(first.messages.filter(m=>m.type==='play').length,0);
  first.socket.destroy();await until(()=>!bridge.status().connected);
  const second=await connect(t,bridge,'session-new');await delay(30);
  assert.equal(second.messages.filter(m=>m.type==='play').length,0);
  assert.deepEqual(await bridge.play(payload()),{sent:false,reason:'stale'});
  assert.deepEqual(await bridge.play(payload({sessionId:'session-new'})),{sent:true});
});

test('pending clip bytes stay bounded and stop resolves queued work',async t=>{
  const {bridge}=await fixture(t);const {socket}=await connect(t,bridge);socket.pause();
  const bytes=new Uint8Array(MAX_CLIP);
  const first=bridge.play(payload({bytes,id:'large-1',slot:0}));
  const second=bridge.play(payload({bytes,id:'large-2',slot:1}));
  assert.deepEqual(await bridge.play(payload({bytes,id:'large-3',slot:2})),{sent:false,reason:'busy'});
  bridge.stop();socket.resume();
  assert.equal((await first).sent,false);assert.deepEqual(await second,{sent:false,reason:'stopped'});
  assert.deepEqual(await bridge.play(payload({id:'after-stop'})),{sent:true});
});

test('native boundary rejects unsafe slots, old timestamps and decoded expansion',async t=>{
  const {bridge}=await fixture(t);
  for(const fields of [{slot:16},{id:'../../file'},{bytes:new Uint8Array(0)},{bytes:'text'},{createdAt:Date.now()-4000},{decodedBytes:MAX_CACHE+1},{sessionId:'../x'}])assert.throws(()=>bridge.play(payload(fields)));
});

test('native host validates Chrome origin and relays framed messages without launching desktop',async t=>{
  const {bridge,directory}=await fixture(t);const setup=await bridge.prepare();
  const launcher=path.join(directory,'meet-native/launch-host');
  const bad=spawn(launcher,['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']);let badError='';bad.stderr.on('data',d=>badError+=d);
  const code=await new Promise(resolve=>bad.once('close',resolve));assert.equal(code,1);assert.match(badError,/not allowed/);
  const child=spawn(launcher,[`chrome-extension://${setup.extensionId}/`]);t.after(()=>child.kill());
  const messages=[];child.stdout.on('data',frameReader(m=>messages.push(m),e=>{throw e;}));child.stderr.on('data',()=>{});
  await until(()=>messages.some(m=>m.type==='connection'&&m.connected));
  child.stdin.write(encodeFrame({v:1,type:'status',sessionId:'host-session',eligible:1,muted:false}));
  await until(()=>bridge.status().ready);
  assert.deepEqual(await bridge.play(payload({sessionId:'host-session'})),{sent:true});
  await until(()=>messages.some(m=>m.type==='play'));
  await bridge.close();await until(()=>messages.some(m=>m.type==='connection'&&!m.connected));
  const absent=spawn(launcher,[`chrome-extension://${setup.extensionId}/`]);let output=Buffer.alloc(0);absent.stdout.on('data',d=>output=Buffer.concat([output,d]));
  await new Promise(resolve=>absent.once('close',resolve));const after=[];frameReader(m=>after.push(m),e=>{throw e;})(output);
  assert.deepEqual(after,[{v:1,type:'connection',connected:false}]);
});
