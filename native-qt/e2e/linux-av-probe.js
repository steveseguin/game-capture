'use strict';
// Decode the shared A/V fixture's 24-bit pulse/phase and inverse barcode from
// actual received VideoFrames. Kept separate from presentation callback timing.
async function observe(page, milliseconds, {rtpMetadata=false}={}) {
  return page.evaluate(async ({milliseconds,rtpMetadata}) => {
    const track = window.reviewPCs.filter(p => p.connectionState === 'connected')
      .flatMap(p => p.getReceivers()).map(r => r.track).find(t => t?.kind === 'video' && t.readyState === 'live');
    if (!track || typeof MediaStreamTrackProcessor !== 'function') throw Error('No decoded video track/processor');
    const element=rtpMetadata?[...document.querySelectorAll('video')].find(v=>!v.paused&&v.videoWidth):null;
    if(rtpMetadata&&!element)throw Error('No playing video for RTP metadata');
    const clone = track.clone(), reader = new MediaStreamTrackProcessor({track:clone, maxBufferSize:4}).readable.getReader();
    const canvas = new OffscreenCanvas(320,180), g = canvas.getContext('2d',{willReadFrequently:true});
    const observations = []; let invalid = 0, width = 0, height = 0;
    const presentation=[];let presentationCallback,presentationError=null;
    const presented=(now,m)=>{
      if(presentation.length>=1000){presentationError='Presentation metadata bound exceeded';return;}
      if(!Number.isInteger(m.rtpTimestamp)||m.rtpTimestamp<0||m.rtpTimestamp>0xffffffff||!Number.isFinite(m.mediaTime)){
        presentationError='Presentation callback lacks RTP timestamp';return;
      }
      presentation.push({now,mediaTime:m.mediaTime,rtpTimestamp:m.rtpTimestamp,presentedFrames:m.presentedFrames,
        captureTime:m.captureTime,receiveTime:m.receiveTime,presentationTime:m.presentationTime,expectedDisplayTime:m.expectedDisplayTime});
      presentationCallback=element.requestVideoFrameCallback(presented);
    };
    if(element)presentationCallback=element.requestVideoFrameCallback(presented);
    const started = performance.timeOrigin + performance.now();
    const timer = setTimeout(() => reader.cancel().catch(() => {}), milliseconds);
    try {
      while (true) {
        const {done,value:frame} = await reader.read(); if (done) break;
        try {
          width=frame.displayWidth;height=frame.displayHeight;
          g.drawImage(frame,0,0,320,180);
          const data=g.getImageData(0,0,320,180).data;
          let cx0=320,cx1=-1,cy0=180,cy1=-1,mx0=320,mx1=-1;
          for(let y=0;y<180;y++)for(let x=0;x<320;x++) {
            const i=(y*320+x)*4,r=data[i],green=data[i+1],b=data[i+2];
            if(r<70&&green>170&&b>170){cx0=Math.min(cx0,x);cx1=Math.max(cx1,x);cy0=Math.min(cy0,y);cy1=Math.max(cy1,y);}
            if(r>170&&green<70&&b>170){mx0=Math.min(mx0,x);mx1=Math.max(mx1,x);}
          }
          let stamp=0,valid=cx1>cx0&&mx1>mx0&&mx0>cx1;
          if(valid) {
            const w=((mx0+mx1)/2-(cx0+cx1)/2)/.86,h=(cy1-cy0+1)/.6;
            const left=(cx0+cx1)/2-.07*w,top=cy0-.2*h;
            const at=(x,y)=>{
              const ix=Math.round(left+x*w),iy=Math.round(top+y*h);
              return ix>=0&&ix<320&&iy>=0&&iy<180?data[(iy*320+ix)*4]:NaN;
            };
            for(let bit=0;bit<24;bit++) {
              const x=.15+(bit+.5)*.7/24,a=at(x,.5),b=at(x,.7);
              const va=a>170?1:a<85?0:-1,vb=b>170?1:b<85?0:-1;
              if(va<0||vb<0||va===vb){valid=false;break;}stamp|=va<<bit;
            }
            valid=valid&&(stamp%256<200);
          }
          if(!valid)invalid++;
          observations.push({stamp:valid?stamp:null,mediaTime:frame.timestamp/1e6,wall:performance.timeOrigin+performance.now()});
        } finally {frame.close();}
      }
    } finally {clearTimeout(timer);if(element)element.cancelVideoFrameCallback(presentationCallback);await reader.cancel().catch(()=>{});reader.releaseLock();clone.stop();}
    if(presentationError)throw Error(presentationError);
    return {started,ended:performance.timeOrigin+performance.now(),width,height,invalid,observations,
      ...(rtpMetadata?{presentation,pageTimeOrigin:performance.timeOrigin}:{}),method:'MediaStreamTrackProcessor; pulse/phase plus inverse barcode'};
  },{milliseconds,rtpMetadata});
}
module.exports={observe};
