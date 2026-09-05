'use strict';

const fs = require('fs');
const {promisify} = require('util');
const execFile = promisify(require('child_process').execFile);

// Bake IDs into the source pixels, rather than painting an independently timed
// browser overlay. The 20-second loop has one ID per input frame.
exports.makeClip = async function makeClip(ffmpeg, input, output, fps) {
  const width=464,height=40,frames=Math.round(fps*20),raw=output+'.rgb';
  const fd=fs.openSync(raw,'wx');
  try {
    for(let id=0;id<frames;id++) {
      const pixels=Buffer.alloc(width*height*3);
      for(let cell=0;cell<28;cell++) {
        const value=(((id>>((cell-2+12)%12))&1)^(cell>=14?1:0))?235:20;
        const rgb=(cell===0||cell===27)?[255,0,255]:(cell===1||cell===26)?[0,255,255]:[value,value,value];
        for(let y=8;y<32;y++)for(let x=8+cell*16;x<24+cell*16;x++) {
          const offset=(y*width+x)*3;for(let k=0;k<3;k++)pixels[offset+k]=rgb[k];
        }
      }
      fs.writeSync(fd,pixels);
    }
  } finally {fs.closeSync(fd);}
  try {
    await execFile(ffmpeg,['-hide_banner','-loglevel','error','-stream_loop','-1','-i',input,
      '-f','rawvideo','-pixel_format','rgb24','-video_size',width+'x'+height,'-framerate',String(fps),'-i',raw,
      '-filter_complex',`[0:v]fps=${fps}[source];[source][1:v]overlay=(W-w)/2:H-h-12:shortest=1`,
      '-an','-t','20','-c:v','libvpx-vp9','-deadline','good','-cpu-used','4','-row-mt','1','-threads','4',
      '-lossless','1','-pix_fmt','yuv420p',output],
      {windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  } finally {fs.unlinkSync(raw);}
};

// Track source observer gaps separately; rVFC callbacks are best effort.
exports.sourceScript = `<script>
window.reviewIdentity={callbacks:0,missed:0,last:0};
function stamp(now,m){
 const s=window.reviewIdentity;s.callbacks++;if(s.last)s.missed+=Math.max(0,m.presentedFrames-s.last-1);s.last=m.presentedFrames;
 document.querySelector('video').requestVideoFrameCallback(stamp);
}
document.querySelector('video').requestVideoFrameCallback(stamp);
</script>`;

exports.probe = async function probe(page, ms) {
  return page.evaluate(ms=>new Promise(resolve=>{
    const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth);
    if(!video){resolve({error:'No video'});return;}
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
    const rows=[];let location=null,handle,invalid=0;
    const start=performance.now();
    const mag=(p,i)=>p[i]>160&&p[i+1]<100&&p[i+2]>160;
    const cyan=(p,i)=>p[i]<100&&p[i+1]>160&&p[i+2]>160;
    function read(p,x,y,cell,width){
      let id=0;
      for(let bit=0;bit<12;bit++){
        const a=(Math.round(y)*width+Math.round(x+(bit+2)*cell))*4;
        const b=(Math.round(y)*width+Math.round(x+(bit+14)*cell))*4;
        if(a<0||b+2>=p.length)return null;
        const va=p[a]>160?1:p[a]<90?0:-1, vb=p[b]>160?1:p[b]<90?0:-1;
        if(va<0||vb<0||va===vb)return null;id|=va<<bit;
      }
      return id;
    }
    function sample(now,m){
      let id=null;
      if(!location){
        canvas.width=640;canvas.height=Math.round(640*video.videoHeight/video.videoWidth);
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        const p=ctx.getImageData(0,0,canvas.width,canvas.height).data;
        for(let y=Math.floor(canvas.height*.6);y<canvas.height-2&&!location;y+=2){
          const runs=[];
          for(let x=0;x<640;x++)if(mag(p,(y*640+x)*4)){
            const first=x;while(x<640&&mag(p,(y*640+x)*4))x++;
            if(x-first>=3&&x-first<=20)runs.push((first+x-1)/2);
          }
          pairs: for(const left of runs)for(const right of runs){
            const cell=(right-left)/27;if(cell<3||cell>20)continue;
            if(!cyan(p,(y*640+Math.round(left+cell))*4)||!cyan(p,(y*640+Math.round(left+26*cell))*4))continue;
            const centerY=y+3;
            if(centerY>=canvas.height||!mag(p,(centerY*640+Math.round(left))*4))continue;
            id=read(p,left,centerY,cell,640);
            if(id!==null){location={x:(left-cell/2)/640,y:centerY/canvas.height,w:28*cell/640};break pairs;}
          }
        }
      } else {
        canvas.width=448;canvas.height=4;
        ctx.drawImage(video,location.x*video.videoWidth,location.y*video.videoHeight,
          location.w*video.videoWidth,2,0,0,448,4);
        id=read(ctx.getImageData(0,0,448,4).data,8,1,16,448);
        if(id===null)location=null;
      }
      if(id===null)invalid++;
      rows.push({at:now,id,presented:m.presentedFrames,mediaTime:m.mediaTime,rtp:m.rtpTimestamp});
      handle=video.requestVideoFrameCallback(sample);
    }
    handle=video.requestVideoFrameCallback(sample);
    setTimeout(()=>{
      video.cancelVideoFrameCallback(handle);
      let unique=0,repeats=0,missedCallbacks=0,previous=null,lastValidId=null;
      for(const r of rows){
        if(previous)missedCallbacks+=Math.max(0,r.presented-previous.presented-1);
        if(r.id!==null){if(r.id===lastValidId)repeats++;else unique++;lastValidId=r.id;}
        previous=r;
      }
      const seconds=(performance.now()-start)/1000;
      resolve({seconds,callbacks:rows.length,invalid,unique,repeats,missedCallbacks,uniqueObservedFps:unique/seconds,rows});
    },ms);
  }),ms);
};
