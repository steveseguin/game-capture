'use strict';
// Runs in the real Chrome receiver. Timings use estimated presentation clocks;
// they are software measurements, not a microphone/photodiode measurement.
exports.install = async (page, {recordTrack = false} = {}) => page.evaluate(async ({recordTrack}) => {
  const pc=window.qualityPeers.find(p=>p.connectionState==='connected'&&p.getReceivers().some(r=>r.track.kind==='audio'));
  const track=pc.getReceivers().find(r=>r.track.kind==='audio').track;
  const ctx=new AudioContext({sampleRate:48000,latencyHint:'interactive'});await ctx.resume();
  const code=`class Observer extends AudioWorkletProcessor {
    constructor(){super();this.frame=0;this.pos=0;this.prev=[0,0];this.rows=[];this.raw=[];this.active=false;
      this.tables=[400,800,2000,3000].map(h=>Array.from({length:480},(_,i)=>[Math.cos(2*Math.PI*h*i/48000),Math.sin(2*Math.PI*h*i/48000)]));
      this.resetWindow();this.port.onmessage=e=>{if(e.data==='start'){this.active=true;this.rows=[];this.raw=[];}else{this.active=false;this.flush();}};}
    resetWindow(){this.energy=[0,0];this.sum=Array.from({length:2},()=>this.tables.map(()=>[0,0]));this.peak=0;this.step=0;this.clips=0;}
    flush(){if(this.rows.length)this.port.postMessage({rows:this.rows,raw:this.raw});this.rows=[];this.raw=[];}
    process(inputs){const input=inputs[0];if(!input?.length)return true;
      for(let i=0;i<input[0].length;i++){
        if(this.pos===0){this.frame=currentFrame+i;this.resetWindow();}
        for(let ch=0;ch<2;ch++){const v=(input[ch]||input[0])[i];this.energy[ch]+=v*v;this.peak=Math.max(this.peak,Math.abs(v));
          this.step=Math.max(this.step,Math.abs(v-this.prev[ch]));this.prev[ch]=v;if(Math.abs(v)>=.999)this.clips++;
          for(let f=0;f<4;f++){this.sum[ch][f][0]+=v*this.tables[f][this.pos][0];this.sum[ch][f][1]+=v*this.tables[f][this.pos][1];}
          if(this.active)this.raw.push(v);
        }
        if(++this.pos===480){if(this.active)this.rows.push({frame:this.frame,rms:this.energy.map(v=>Math.sqrt(v/480)),peak:this.peak,step:this.step,clips:this.clips,
          amplitude:this.sum.map(ch=>ch.map(v=>2*Math.hypot(...v)/480))});this.pos=0;
          if(this.rows.length>=100)this.flush();}
      }return true;}
  }registerProcessor('quality-observer',Observer);`;
  const blob=URL.createObjectURL(new Blob([code],{type:'application/javascript'}));
  await ctx.audioWorklet.addModule(blob);URL.revokeObjectURL(blob);
  const input=ctx.createMediaStreamSource(new MediaStream([track]));
  const node=new AudioWorkletNode(ctx,'quality-observer'),mute=ctx.createGain();mute.gain.value=0;
  input.connect(node);node.connect(mute);mute.connect(ctx.destination);
  const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth);
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=Math.round(640*video.videoHeight/video.videoWidth);
  const g=canvas.getContext('2d',{willReadFrequently:true});
  let active=false,rows=[],audio=[],raw=[],location=null,trackRecorder=null,trackChunks=[],trackRecordingStartWall=null;
  node.port.onmessage=e=>{
    const stamp=ctx.getOutputTimestamp();
    for(const r of e.data.rows)audio.push({...r,wall:performance.timeOrigin+stamp.performanceTime+(r.frame/ctx.sampleRate-stamp.contextTime)*1000});
    raw.push(...e.data.raw);
  };
  function frame(now,m){
    if(active){
      g.drawImage(video,0,0,canvas.width,canvas.height);const p=g.getImageData(0,0,canvas.width,canvas.height).data,w=canvas.width;
      const at=(x,y)=>(Math.round(y)*w+Math.round(x))*4;
      const mag=(x,y)=>{const i=at(x,y);return p[i]>160&&p[i+1]<100&&p[i+2]>160;};
      const cyan=(x,y)=>{const i=at(x,y);return p[i]<100&&p[i+1]>160&&p[i+2]>160;};
      if(!location||!mag(location.x,location.y)){
        location=null;
        for(let y=Math.floor(canvas.height*.65);y<canvas.height-3&&!location;y+=2){
          const runs=[];for(let x=0;x<w;x++)if(mag(x,y)){const start=x;while(x<w&&mag(x,y))x++;if(x-start>=3)runs.push((start+x-1)/2);}
          search:for(const left of runs)for(const right of runs){const cell=(right-left)/51;
            if(cell<3||cell>20||!cyan(left+cell,y)||!cyan(left+50*cell,y))continue;
            location={x:left,y:y+3,cell};break search;}
        }
      }
      let stamp=null,flash=false;
      if(location){let value=0,valid=true;const {x,y,cell}=location;
        for(let b=0;b<24;b++){const a=p[at(x+(b+2)*cell,y)],c=p[at(x+(b+26)*cell,y)];
          const va=a>160?1:a<90?0:-1,vb=c>160?1:c<90?0:-1;if(va<0||vb<0||va===vb){valid=false;break;}value|=va<<b;}
        if(valid)stamp=value;else location=null;
        flash=p[at(x+20*cell,y-36*cell/24)]>160;
      }
      const wall=performance.timeOrigin+m.expectedDisplayTime;
      rows.push({wall,stamp,flash,presented:m.presentedFrames,delayMs:stamp===null?null:((wall%16777216-stamp+16777216)%16777216)});
    }
    video.requestVideoFrameCallback(frame);
  }video.requestVideoFrameCallback(frame);
  const base64=bytes=>{let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);};
  window.qualityObserver={start(){rows=[];audio=[];raw=[];active=true;node.port.postMessage('start');
      if(recordTrack){trackChunks=[];trackRecorder=new MediaRecorder(new MediaStream([track]),
        {mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:192000});
        trackRecorder.ondataavailable=e=>{if(e.data.size)trackChunks.push(e.data);};
        trackRecordingStartWall=performance.timeOrigin+performance.now();trackRecorder.start();}},
    async stop(){active=false;node.port.postMessage('stop');await new Promise(r=>setTimeout(r,200));
      let trackAudioBase64;
      if(trackRecorder){await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Track recorder did not stop')),5000);
        trackRecorder.onstop=()=>{clearTimeout(timeout);resolve();};trackRecorder.stop();});
        trackAudioBase64=base64(new Uint8Array(await new Blob(trackChunks).arrayBuffer()));trackRecorder=null;trackChunks=[];}
      return {video:rows,audio,pcmBase64:base64(new Uint8Array(new Float32Array(raw).buffer)),trackAudioBase64,trackRecordingStartWall,
        sampleRate:ctx.sampleRate,baseLatency:ctx.baseLatency,outputLatency:ctx.outputLatency};},
    async close(){input.disconnect();node.disconnect();await ctx.close();}};
}, {recordTrack});

exports.analyze = data => {
  const median = a => {a=[...a].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
  const valid=data.video.filter(v=>v.stamp!==null),trim=data.audio.slice(100,-20);
  const flashes=data.video.filter((v,i)=>i&&v.flash&&!data.video[i-1].flash).map(v=>v.wall);
  const beeps=trim.filter((a,i)=>i&&a.amplitude[0][2]>.035&&trim[i-1].amplitude[0][2]<=.035).map(a=>a.wall);
  const sync=flashes.map(v=>beeps.map(a=>a-v).sort((a,b)=>Math.abs(a)-Math.abs(b))[0]).filter(v=>Math.abs(v)<500);
  let duplicates=0,gaps=0;for(let i=1;i<valid.length;i++){if(valid[i].stamp===valid[i-1].stamp)duplicates++;if(valid[i].wall-valid[i-1].wall>100)gaps++;}
  return {video:{frames:data.video.length,invalid:data.video.length-valid.length,duplicates,gapsOver100Ms:gaps,
    delayMedianMs:median(valid.map(v=>v.delayMs)),delayP95Ms:[...valid.map(v=>v.delayMs)].sort((a,b)=>a-b)[Math.floor(valid.length*.95)]},
    audio:{peak:Math.max(...trim.map(a=>a.peak)),maxSampleStep:Math.max(...trim.map(a=>a.step)),clippedSamples:trim.reduce((s,a)=>s+a.clips,0),
      silentWindows:trim.filter(a=>Math.max(...a.rms)<.001).length,windows:trim.length,
      medianAmplitudes:[0,1].map(ch=>[0,1,2,3].map(f=>median(trim.map(a=>a.amplitude[ch][f]))))},
    sync:{audioMinusVideoMs:sync,medianMs:median(sync),flashes:flashes.length,beeps:beeps.length},
    timingNote:'Independent decoded audio track through Web Audio; bypasses HTML video audio synchronization. Offset is diagnostic, not browser lip sync. Software clocks, not physical display/speaker measurements.'};
};

// Independent received-track recording, decoded by FFmpeg to 48-kHz stereo.
// Keep its continuity result separate from the Web Audio FIFO/observer path.
exports.analyzeTrackPcm = bytes => {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),frames=bytes.length/8;
  const minimumWindowRms=[Infinity,Infinity];let lowEnergyWindows=0,clippedSamples=0,windows=0;
  // Exclude recorder startup and final codec padding.
  for(let start=48000;start+480<=frames-9600;start+=480){
    const energy=[0,0];
    for(let i=start;i<start+480;i++)for(let ch=0;ch<2;ch++){
      const v=view.getFloat32(i*8+ch*4,true);if(!Number.isFinite(v))throw Error('Non-finite received audio sample');
      energy[ch]+=v*v;if(Math.abs(v)>=.999)clippedSamples++;
    }
    const rms=energy.map(v=>Math.sqrt(v/480));
    for(let ch=0;ch<2;ch++)minimumWindowRms[ch]=Math.min(minimumWindowRms[ch],rms[ch]);
    if(Math.max(...rms)<.02)lowEnergyWindows++;windows++;
  }
  if(!windows)throw Error('Independent audio recording has no usable continuity window');
  return {seconds:frames/48000,windows,minimumWindowRms,lowEnergyWindows,clippedSamples};
};
