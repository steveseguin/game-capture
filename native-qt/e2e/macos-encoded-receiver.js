'use strict';
// Optional evidence probe: copy received H.264 access units before browser
// decoding. The standard receiver transform forwards every frame unchanged.
// https://www.w3.org/TR/webrtc-encoded-transform/
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
async function install(page) {
  await page.addInitScript(()=>{
    const workers=[];
    window.reviewEncoded={errors:[],async drain(){
      const result=[];
      for(const worker of workers) {
        const data=await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(Error('Encoded evidence worker did not respond')),5000);
          worker.addEventListener('message',event=>{clearTimeout(timeout);resolve(event.data);},{once:true});
          worker.postMessage('drain');
        });
        const frames=data.frames.map(frame=>{
          const bytes=new Uint8Array(frame.data);let text='';
          for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
          return {...frame,data:btoa(text)};
        });
        result.push({...data,frames});
      }
      return {streams:result,errors:this.errors};
    }};
    function workerMain() {
      let frames=[],size=0,dropped=0,error=null;
      onrtctransform=event=>{
        const {readable,writable}=event.transformer;
        readable.pipeThrough(new TransformStream({transform(frame,controller){
          if(size+frame.data.byteLength<=64*1024*1024) {
            const data=frame.data.slice(0);size+=data.byteLength;
            frames.push({data,type:frame.type,rtpTimestamp:frame.timestamp,metadata:frame.getMetadata()});
          } else dropped++;
          controller.enqueue(frame);
        }})).pipeTo(writable).catch(e=>{error=String(e);});
      };
      onmessage=()=>{
        postMessage({frames,dropped,error},frames.map(f=>f.data));
        frames=[];size=0;dropped=0;
      };
    }
    const url=URL.createObjectURL(new Blob(['('+workerMain.toString()+')()'],{type:'text/javascript'}));
    window.RTCPeerConnection=new Proxy(window.RTCPeerConnection,{construct(target,args){
      const pc=new target(...args);
      pc.addEventListener('track',event=>{
        if(event.track.kind!=='video')return;
        try {
          if(typeof RTCRtpScriptTransform!=='function')throw Error('Encoded receiver transform unavailable');
          const worker=new Worker(url);workers.push(worker);
          worker.onerror=e=>window.reviewEncoded.errors.push(String(e.message));
          event.receiver.transform=new RTCRtpScriptTransform(worker);
        } catch(e) {window.reviewEncoded.errors.push(String(e));}
      });
      return pc;
    }});
  });
}
async function drain(page,directory,label) {
  const observation=await page.evaluate(()=>window.reviewEncoded.drain());
  const streams=observation.streams.map((stream,index)=>{
    let offset=0;
    const buffers=[],frames=stream.frames.map(({data,...frame})=>{
      const bytes=Buffer.from(data,'base64'),entry={...frame,offset,bytes:bytes.length};
      buffers.push(bytes);offset+=bytes.length;return entry;
    });
    const bytes=Buffer.concat(buffers),file=label+'-'+index+'.h264';
    fs.writeFileSync(path.join(directory,file),bytes);
    return {file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),frames,dropped:stream.dropped,error:stream.error};
  });
  return {streams,errors:observation.errors};
}
module.exports={install,drain};
