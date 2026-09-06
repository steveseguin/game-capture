'use strict';
const fs=require('fs');
const crypto=require('crypto');
const {promisify}=require('util');
const execFile=promisify(require('child_process').execFile);

// Record the media track, independently of requestVideoFrameCallback sampling.
// Source captureStream measures media output, not Windows compositor delivery.
exports.record=async function(page,file,ms,source=false) {
  const result=await page.evaluate(async({ms,source})=>{
    const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth);
    if(!video)throw Error('No playing video to record');
    const stream=source?video.captureStream():video.srcObject;
    const original=stream?.getVideoTracks()[0];
    if(!original)throw Error('No video track to record');
    const track=source?original:original.clone(),chunks=[];
    const recorder=new MediaRecorder(new MediaStream([track]),{
      mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:12000000});
    const counters=async()=>{
      if(source){const q=video.getVideoPlaybackQuality();return [{kind:'source',total:q.totalVideoFrames,dropped:q.droppedVideoFrames}];}
      const rows=[];
      for(const pc of window.reviewPCs||[])if(pc.connectionState!=='closed')
        for(const r of (await pc.getStats()).values())if(r.type==='inbound-rtp'&&r.kind==='video')rows.push({...r});
      return rows;
    };
    const before=await counters();
    const startMs=Date.now();
    try {
      await new Promise((resolve,reject)=>{
        recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
        recorder.onerror=e=>reject(e.error||Error('Recorder failed'));
        recorder.onstop=resolve;
        recorder.start();setTimeout(()=>{if(recorder.state!=='inactive')recorder.stop();},ms);
      });
      const endMs=Date.now();
      // Snapshot before serializing the recording back to Node. Large blobs
      // can take hundreds of ms to transfer while decoding continues.
      const after=await counters();
      const base64=await new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);
        reader.onerror=()=>reject(reader.error);reader.readAsDataURL(new Blob(chunks));
      });
      return {startMs,endMs,before,after,base64};
    } finally {if(recorder.state!=='inactive')recorder.stop();track.stop();}
  },{ms,source});
  const bytes=Buffer.from(result.base64,'base64');delete result.base64;
  fs.writeFileSync(file,bytes);
  return {...result,file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
};

exports.analyze=async function(ffmpeg,recording) {
  // Preserve native timestamps: never synthesize frames with an fps filter.
  const {stdout}=await execFile(ffmpeg,['-hide_banner','-loglevel','error','-i',recording.file,
    '-vf','scale=640:-2,crop=640:80:0:ih-80','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],
    {windowsHide:true,encoding:'buffer',maxBuffer:160*1024*1024,timeout:60000});
  const size=640*80*3;
  if(!stdout.length||stdout.length%size)throw Error('Incomplete recording decode');
  let location=null;
  const ids=[];
  for(let offset=0;offset<stdout.length;offset+=size) {
    const p=stdout.subarray(offset,offset+size);
    const at=(x,y)=>(Math.round(y)*640+Math.round(x))*3;
    const mag=(x,y)=>{const i=at(x,y);return p[i]>160&&p[i+1]<100&&p[i+2]>160;};
    const cyan=(x,y)=>{const i=at(x,y);return p[i]<100&&p[i+1]>160&&p[i+2]>160;};
    const read=(x,y,cell)=>{
      let id=0;
      for(let bit=0;bit<12;bit++) {
        const a=p[at(x+(bit+2)*cell,y)],b=p[at(x+(bit+14)*cell,y)];
        const va=a>160?1:a<90?0:-1,vb=b>160?1:b<90?0:-1;
        if(va<0||vb<0||va===vb)return null;id|=va<<bit;
      }
      return id;
    };
    let id=location&&mag(location.x,location.y)?read(location.x,location.y,location.cell):null;
    if(id===null) {
      location=null;
      for(let y=0;y<76&&!location;y+=2) {
        const runs=[];
        for(let x=0;x<640;x++)if(mag(x,y)) {
          const first=x;while(x<640&&mag(x,y))x++;
          if(x-first>=3&&x-first<=20)runs.push((first+x-1)/2);
        }
        search: for(const left of runs)for(const right of runs) {
          const cell=(right-left)/27;
          if(cell<3||cell>20||!cyan(left+cell,y)||!cyan(left+26*cell,y)||!mag(left,y+3))continue;
          id=read(left,y+3,cell);
          if(id!==null){location={x:left,y:y+3,cell};break search;}
        }
      }
    }
    ids.push(id);
  }
  const seconds=(recording.endMs-recording.startMs)/1000;
  let repeats=0,changes=0;
  for(let i=1;i<ids.length;i++)if(ids[i]!==null&&ids[i-1]!==null){if(ids[i]===ids[i-1])repeats++;else changes++;}
  return {...recording,seconds,frames:ids.length,framesPerSecond:ids.length/seconds,
    changesPerSecond:changes/seconds,repeats,invalid:ids.filter(id=>id===null).length,ids};
};
