import './meet.css';

export function wavBytes(buffer) {
  const channels=buffer.numberOfChannels,frames=buffer.length,bytes=new ArrayBuffer(44+frames*channels*2),view=new DataView(bytes);
  const word=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
  word(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);word(8,'WAVE');word(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);word(36,'data');view.setUint32(40,frames*channels*2,true);
  const data=Array.from({length:channels},(_,i)=>buffer.getChannelData(i));
  for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++){const sample=Math.max(-1,Math.min(1,data[channel][frame]));view.setInt16(44+(frame*channels+channel)*2,Math.round(sample*(sample<0?32768:32767)),true);}
  return bytes;
}

export function createMeetControls(editor,notice) {
  const api=window.soundboard;
  let status={prepared:false,connected:false,eligible:0,ready:false,muted:false},generation=0,lastNotice=0;
  const slots=Array(16).fill(0),demos=new Map();
  const section=document.createElement('details');section.id='meet-settings';
  section.innerHTML='<summary>Google Meet <span id="meet-summary">Not set up</span></summary><p id="meet-status" role="status" aria-live="polite"></p><button id="prepare-meet" type="button">Prepare extension</button><button id="show-meet-folder" type="button" hidden>Open folder</button><p id="meet-setup-note" class="help">One-time setup for Google Meet in Chrome. Registers only the local Klangdeck connection; no audio driver is installed.</p><ol id="meet-steps"><li>Open <code>chrome://extensions</code> in Chrome and turn on Developer mode.</li><li>Choose “Load unpacked” and select the Klangdeck folder.</li><li>Reload any open Meet tabs. Your usual microphone stays selected.</li></ol><p id="meet-folder-path"></p><p id="meet-call-note" class="help" hidden>Meet mute also silences sounds. If Meet suppresses effects, check noise cancellation in the call. Headphones prevent local playback from feeding back through your microphone.</p><p id="meet-error" role="alert"></p>';
  editor.querySelector('footer').before(section);
  const find=id=>section.querySelector(`#${id}`);
  function render(next) {
    if(status.sessionId!==next.sessionId || status.ready && (!next.ready || status.eligible!==next.eligible))generation++;
    status=next;
    let label,detail;
    if(!api?.meetStatus){label='Mac app only';detail='This connection is available only in Klangdeck for Mac.';}
    else if(status.eligible>1){label='Multiple calls';detail='Multiple Meet calls are connected. Sounds play locally only. Keep just one call connected.';}
    else if(status.ready){label=status.muted?'Meet is muted':'Call connected';detail=status.muted?'Your microphone and Klangdeck sounds are muted in Meet.':'One Meet call is connected. New pad presses also send sounds to this call.';if(status.error)detail+=` Latest notice: ${status.error}`;}
    else if(status.error){label='Not ready';detail=status.error;}
    else if(!status.prepared){label='Not set up';detail='Prepare the local Chrome extension once. Sounds keep playing on your Mac.';}
    else if(!status.connected){label='Chrome not connected';detail='Load the extension and open Google Meet. Keep Klangdeck open during the call.';}
    else{label='Waiting for a call';detail='The extension is connected. Sounds are sent only during an active Meet call, not in the preview before joining.';}
    find('meet-summary').textContent=label;find('meet-status').textContent=detail;
    find('prepare-meet').disabled=!api?.prepareMeet;
    find('prepare-meet').textContent=status.prepared?'Refresh setup':'Prepare extension';
    find('show-meet-folder').hidden=!status.prepared;
    find('meet-steps').hidden=!status.prepared;
    find('meet-folder-path').textContent=status.prepared?status.extensionPath||'':'';
    find('meet-call-note').hidden=!status.ready;
  }
  find('prepare-meet').onclick=async()=>{
    find('prepare-meet').disabled=true;find('meet-error').textContent='';
    try{render(await api.prepareMeet());await api.showMeetFolder();}
    catch(error){find('meet-error').textContent=`Setup failed: ${error.message}`;}
    finally{find('prepare-meet').disabled=false;}
  };
  find('show-meet-folder').onclick=()=>api.showMeetFolder().catch(error=>find('meet-error').textContent=error.message);
  render(status);
  api?.onMeetStatus?.(render);
  api?.meetStatus?.().then(render).catch(error=>render({...status,error:error.message}));
  const warn=message=>{if(Date.now()-lastNotice>4000){notice(message,true);lastNotice=Date.now();}};
  return {
    async play({slot,pad,buffer,readBytes,createdAt}) {
      const sequence=++slots[slot],epoch=generation,destination=status.sessionId;
      if(!status.ready){if(status.eligible>1)warn('Multiple Meet calls are open: this sound plays locally only.');return;}
      try{
        const decodedBytes=buffer.length*buffer.numberOfChannels*4;
        if(decodedBytes>64*1024*1024){warn('This long sound plays locally only; it is too large for Meet after decoding.');return;}
        const id=pad.demo!==null?`demo:${pad.demo}`:pad.audio;
        let bytes;
        if(pad.demo!==null){if(!demos.has(id))demos.set(id,wavBytes(buffer));bytes=demos.get(id);}
        else bytes=await readBytes(pad.audio);
        if(epoch!==generation||sequence!==slots[slot]||!status.ready||Date.now()-createdAt>3000)return;
        const result=await api.playMeet({slot,id,bytes,decodedBytes,createdAt,sessionId:destination});
        if(!result.sent&&!['stale','stopped'].includes(result.reason))warn('This sound plays locally only. Check the Meet connection in Settings.');
      }catch{warn('This sound could not be sent to Meet and plays locally only.');}
    },
    stop(){generation++;if(api?.stopMeet)void api.stopMeet().catch(()=>{});},
    diagnostics:()=>({prepared:status.prepared,connected:status.connected,eligible:status.eligible,ready:status.ready,muted:status.muted})
  };
}
