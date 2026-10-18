'use strict';
// Copy incoming encoded audio before browser decode. Forward each original
// frame unchanged; capture/IPC failure invalidates evidence, never rewrites it.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {waitFor}=require('./macos-media-receiver');
async function install(page,report) {
  const file=path.join(report,'received-opus.jsonl'),fd=fs.openSync(file,'wx',0o600);
  const binding='gcEncodedAudio'+crypto.randomBytes(12).toString('hex');
  let count=0,bytes=0,writeError=null,closed=false;
  try {
  await page.exposeFunction(binding,packet=>{
    try {
      assert(!closed && count<20000);assert(typeof packet.id==='string'&&packet.id.length<200);
      assert(Number.isInteger(packet.rtpTimestamp)&&packet.rtpTimestamp>=0&&packet.rtpTimestamp<=0xffffffff);
      assert(Number.isFinite(packet.observedAtMs)&&typeof packet.data==='string'&&packet.data.length<=5500);
      const size=Buffer.from(packet.data,'base64').length;assert(size>0&&size<=4096&&bytes+size<=16*1024*1024);
      fs.writeSync(fd,JSON.stringify(packet)+'\n');count++;bytes+=size;
    }catch(e){writeError=String(e);throw e;}
  });
  await page.addInitScript(({binding})=>{
    const state={error:null,selectedId:null,frames:0,queued:0};window.gcEncodedAudio=state;
    const entries=[];let pending=Promise.resolve(),ack,worker;
    const code=`let recording=true,count=0,bytes=0;
      onmessage=e=>{if(e.data==='stop'){recording=false;postMessage({stopped:true,count,bytes});}};
      onrtctransform=({transformer})=>{
        transformer.readable.pipeThrough(new TransformStream({transform(frame,controller){
          if(recording){
            if(count>=20000||bytes+frame.data.byteLength>16777216){recording=false;postMessage({error:'Encoded copy bound exceeded'});}
            else{const data=frame.data.slice(0),meta=frame.getMetadata();count++;bytes+=data.byteLength;
              postMessage({id:transformer.options.id,rtpTimestamp:meta.rtpTimestamp,metadata:meta,observedAtMs:performance.timeOrigin+performance.now(),data},[data]);}
          }
          controller.enqueue(frame);
        }})).pipeTo(transformer.writable).catch(e=>postMessage({error:String(e)}));
      };`;
    try {
      if(typeof RTCRtpScriptTransform!=='function')throw Error('RTCRtpScriptTransform unavailable');
      const url=URL.createObjectURL(new Blob([code],{type:'application/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);
      worker.onerror=e=>{state.error=String(e.message||e);};
      worker.onmessage=({data})=>{
        if(data.error){state.error=data.error;return;}
        if(data.stopped){ack?.(data);return;}
        if(state.queued>=512){state.error='Encoded evidence queue overflow';return;}
        const array=new Uint8Array(data.data);let text='';for(const value of array)text+=String.fromCharCode(value);
        data.data=btoa(text);state.queued++;
        pending=pending.then(()=>window[binding](data)).then(()=>state.frames++).catch(e=>{state.error=String(e);}).finally(()=>state.queued--);
      };
      const Original=window.RTCPeerConnection;let serial=0;
      window.RTCPeerConnection=new Proxy(Original,{construct(target,args){
        const pc=new target(...args),number=++serial;
        pc.addEventListener('track',event=>{
          if(event.track.kind!=='audio')return;
          try{const id=number+':'+event.track.id;event.receiver.transform=new RTCRtpScriptTransform(worker,{id});entries.push({id,pc,receiver:event.receiver});}
          catch(e){state.error=String(e);}
        });return pc;
      }});
    }catch(e){state.error=String(e);}
    state.select=()=>{
      if(state.error)throw Error(state.error);
      const entry=entries.find(e=>e.pc.connectionState==='connected'&&e.receiver.track.readyState==='live');
      if(!entry||!state.frames)return null;state.selectedId=entry.id;return entry.id;
    };
    state.stop=async()=>{
      let timer,summary;
      try{summary=await Promise.race([new Promise(resolve=>{ack=resolve;worker?.postMessage('stop');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Encoded copy stop timed out')),5000);})]);}
      finally{clearTimeout(timer);}
      await pending;
      const streams=[];
      for(const e of entries){const stats=await e.pc.getStats();
        for(const r of stats.values())if(r.type==='inbound-rtp'&&r.kind==='audio'&&r.trackIdentifier===e.receiver.track.id)
          streams.push({id:e.id,trackId:e.receiver.track.id,rtp:r,codec:stats.get(r.codecId)});
      }
      return {selectedId:state.selectedId,error:state.error,frames:state.frames,workerFrames:summary.count,workerBytes:summary.bytes,streams};
    };
  },{binding});
  } catch(error) {
    closed=true;fs.closeSync(fd);throw error;
  }
  let stopped;
  return {
    async select(){let id;await waitFor(async()=>{id=await page.evaluate(()=>window.gcEncodedAudio.select());return !!id;},5000,'Encoded audio observer did not start');return id;},
    stop(){return stopped||=(async()=>{
      let browser;
      try{browser=await page.evaluate(()=>window.gcEncodedAudio.stop());}
      finally{closed=true;fs.closeSync(fd);}
      const metadata={scope:'Incoming encoded audio copied by RTCRtpScriptTransform and forwarded unchanged. Worker arrival times are not calibrated sample timestamps.',
        path:path.basename(file),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),frames:count,payloadBytes:bytes,writeError,...browser};
      fs.writeFileSync(path.join(report,'received-opus.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});
      assert(!writeError&&!metadata.error,writeError||metadata.error);assert.equal(metadata.frames,count);assert.equal(metadata.frames,metadata.workerFrames);assert.equal(bytes,metadata.workerBytes);
      assert(metadata.selectedId);return metadata;
    })();}
  };
}
module.exports={install};
