'use strict';
// Shared real browser receiver observations for packaged Mac workflows.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The captured native cursor can cover a single barcode sample. Read the same
// vertically repeated barcode on three separated rows and require two complete
// identities to agree. This changes pixel decoding, not frame-order thresholds.
function decodeAnchoredRows(rows, width) {
  const decoded=rows.map(row=>{
    let cyan=-1,magenta=-1;
    for(let x=0;x<width;x++) {
      const r=row[x*4],g=row[x*4+1],b=row[x*4+2];
      if(cyan<0&&r<70&&g>170&&b>170)cyan=x;
      if(magenta<0&&r>170&&g<70&&b>170)magenta=x;
    }
    if(cyan<0||magenta<=cyan)return null;
    const markerWidth=(magenta-cyan)/.75,left=cyan-markerWidth*.1;let id=0;
    for(let bit=0;bit<16;bit++) {
      const x=Math.round(left+markerWidth*(.2+(bit+.5)*.6/16));
      if(x<0||x>=width)return null;
      if(row[x*4]>127)id|=1<<bit;
    }
    return {id,cyan,magenta};
  });
  const match=decoded.find(row=>row&&decoded.filter(other=>other?.id===row.id).length>=2);
  // Complete loss of all anchors is also a failed fixture observation. Otherwise
  // gray/corrupt frames disappear from the count and can produce a false pass.
  return {id:match?.id??null,rows:decoded,disagreement:!match||decoded.some(row=>row?.id!==match?.id),
    unreadable:!match};
}
async function waitFor(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(200); }
  throw Error(message);
}
async function receiver(browser, stream, publisher, setup) {
  return receiverAt(browser, `https://vdo.ninja/?view=${stream}&password=false&autostart&cleanoutput&stereo=1&ab=510&audiocodec=red`, publisher, setup);
}
async function installReceiverProbe(page) {
  await page.addInitScript({content:'globalThis.reviewDecodeIdentityRows = '+decodeAnchoredRows.toString()+';'});
  await page.addInitScript(() => {
    window.reviewPCs = [];
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {construct(target, args) {
      const pc = new target(...args); window.reviewPCs.push(pc); return pc;
    }});
  });
}
async function receiverAt(browser, url, publisher, setup) {
  const page = await browser.newPage();
  await installReceiverProbe(page);
  if (setup) await setup(page);
  await page.goto(url,
    {waitUntil:'domcontentloaded', timeout:45000});
  await waitFor(async () => {
    if (publisher && (publisher.exitCode !== null || publisher.signalCode))
      throw Error('Publisher exited before receiver decoded media; inspect publisher log');
    return page.evaluate(async () => {
    for (const pc of window.reviewPCs) {
      for (const value of (await pc.getStats()).values())
        if (value.type === 'inbound-rtp' && value.kind === 'video' && value.framesDecoded > 15) return true;
    }
    return false;
    });
  }, 35000, 'Receiver did not decode video');
  return page;
}
async function observe(page, milliseconds, peerUuid = null, readIdentity = true) {
  return page.evaluate(async ({milliseconds, peerUuid, readIdentity}) => {
    const peers = peerUuid ? [window.session?.rpcs?.[peerUuid]] : window.reviewPCs;
    if (peers.some(pc => !pc)) throw Error('Requested receiver peer is absent');
    const video = [...document.querySelectorAll('video')].find(v => v.videoWidth && !v.paused &&
      (!peerUuid || v.dataset.sid === peers[0].streamID || v.id === `videosource_${peerUuid}`));
    if (!video) throw Error('No playing video');
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d', {willReadFrequently:true});
    const observations = [],identityEvidence=[];let identityReadFailures=0,rowDisagreements=0;
    if(readIdentity&&typeof VideoFrame!=='function')throw Error('Presentation observation requires VideoFrame snapshots');
    let callback, stopped = false, observerError=null;
    function frame(now, metadata) {
      if (stopped) return;
      if(!readIdentity) {
        observations.push({time:performance.now(),mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames});
        callback=video.requestVideoFrameCallback(frame);return;
      }
      // Freeze one image: separate drawImage(video) calls can sample different
      // live frames. All rows and retained evidence must refer to one image.
      let snapshot;
      try {
        snapshot=new VideoFrame(video,{timestamp:Math.round(metadata.mediaTime*1000000)});
        const ys=[.4,.5,.6].map(fraction=>Math.floor(snapshot.displayHeight*fraction));
        const stripHeight=ys[2]-ys[0]+1;
        if(canvas.width!==snapshot.displayWidth)canvas.width=snapshot.displayWidth;
        if(canvas.height!==stripHeight)canvas.height=stripHeight;
        // One crop avoids converting the same GPU-backed frame three times.
        context.globalCompositeOperation='copy';
        context.drawImage(snapshot,0,ys[0],canvas.width,stripHeight,0,0,canvas.width,stripHeight);
        const rows=ys.map(y=>context.getImageData(0,y-ys[0],canvas.width,1).data);
        const decoded=window.reviewDecodeIdentityRows(rows,canvas.width);
        identityReadFailures+=Number(decoded.unreadable);rowDisagreements+=Number(decoded.disagreement);
        if(decoded.disagreement&&identityEvidence.length<2) {
          const picture=document.createElement('canvas');picture.width=snapshot.displayWidth;picture.height=snapshot.displayHeight;
          picture.getContext('2d').drawImage(snapshot,0,0);
          identityEvidence.push({mediaTime:metadata.mediaTime,rows:decoded.rows,
            scanlinesRgba:rows.map(row=>Array.from(row)),png:picture.toDataURL('image/png')});
        }
        if(decoded.id!==null) {
          observations.push({id:decoded.id, time:performance.now(), mediaTime:metadata.mediaTime,
            ...(decoded.disagreement?{rowIds:decoded.rows.map(row=>row?.id??null)}: {}),
            presentedFrames:metadata.presentedFrames});
        }
      } catch(error) {observerError=String(error);stopped=true;}
      finally {snapshot?.close();}
      if(!stopped)callback = video.requestVideoFrameCallback(frame);
    }
    const started = performance.timeOrigin + performance.now();
    callback = video.requestVideoFrameCallback(frame);
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    stopped = true; video.cancelVideoFrameCallback(callback);
    const ended = performance.timeOrigin + performance.now();
    const tracks = [];
    for (const pc of peers) {
      const stats = await pc.getStats();
      for (const item of stats.values()) if (item.type === 'inbound-rtp')
        tracks.push({...item, codec:stats.get(item.codecId)?.mimeType});
    }
    return {observations, tracks, width:video.videoWidth, height:video.videoHeight, started, ended,identityReadFailures,rowDisagreements,identityEvidence,identityObserved:readIdentity,observerError};
  }, {milliseconds, peerUuid,readIdentity});
}
function requireMoving(observation, label, expectedCodec = 'video/h264') {
  if(observation.observerError)throw Error(`${label}: ${observation.observerError}`);
  if(observation.identityObserved===false)throw Error(`${label}: presentation timing alone cannot verify moving content`);
  if(observation.identityReadFailures)throw Error(`${label}: ${observation.identityReadFailures} frames have no agreeing barcode rows`);
  const unique = new Set(observation.observations.map(frame => frame.id));
  if (unique.size < 20) throw Error(`${label}: only ${unique.size} distinct decoded fixture identities`);
  for (let index = 1; index < observation.observations.length; ++index) {
    const previous = observation.observations[index - 1], current = observation.observations[index];
    const step = (current.id - previous.id + 65536) % 65536;
    if (step > 90) throw Error(`${label}: reversed/corrupt fixture identity or gap exceeding 90 fixture steps; ` +
      `frame=${index}, ids=${previous.id}->${current.id}, step=${step}, mediaGapMs=${(current.mediaTime-previous.mediaTime)*1000}`);
  }
  if (!observation.tracks.some(track => track.codec?.toLowerCase() === expectedCodec.toLowerCase()))
    throw Error(`${label}: expected received ${expectedCodec}`);
  return unique.size;
}

// Observe actual decoded track frames independently of the HTML video's
// display/compositor cadence. Keep the visible player running alongside it.
// Requires the API provided by the pinned Chromium receiver; no silent fallback
// to presentation callbacks when a decoded-output measurement was requested.
async function observeDecoded(page, milliseconds, peerUuid = null, fixtureLayout = 'camera', captureIdentityFailures = false) {
  if (!['camera', 'syphon'].includes(fixtureLayout)) throw Error('Unknown fixture layout');
  return page.evaluate(async ({milliseconds, peerUuid, fixtureLayout, captureIdentityFailures}) => {
    const peers = peerUuid ? [window.session?.rpcs?.[peerUuid]] : window.reviewPCs;
    if (peers.some(pc => !pc)) throw Error('Requested receiver peer is absent');
    if (typeof MediaStreamTrackProcessor !== 'function') throw Error('Decoded-frame observation requires MediaStreamTrackProcessor');
    const received = peers.filter(pc=>pc.connectionState==='connected')
      .flatMap(pc=>pc.getReceivers()).map(r=>r.track).find(t=>t?.kind==='video'&&t.readyState==='live');
    if (!received) throw Error('No received video track');
    const track=received.clone(),observations=[],identityFailures=[],identityRowDisagreements=[];
    // Keep the browser clock origin and a wall-clock cross-check. Relative
    // performance.now() values alone cannot be compared across source/viewer.
    const clockSample=()=>({epochMs:performance.timeOrigin+performance.now(),wallMs:Date.now()});
    const clock={timeOrigin:performance.timeOrigin,start:clockSample()};
    let reader,timer,width=0,height=0,started,ended,identityReadFailures=0,rowDisagreements=0;
    try {
      reader=new MediaStreamTrackProcessor({track,maxBufferSize:4}).readable.getReader();
      const canvas=new OffscreenCanvas(1,1),context=canvas.getContext('2d',{willReadFrequently:true});
      started=performance.timeOrigin+performance.now();
      timer=setTimeout(()=>reader.cancel().catch(()=>{}),milliseconds);
      while(true) {
        const {done,value:frame}=await reader.read();if(done) break;
        // Timestamp delivery before canvas conversion and barcode processing.
        // This is decoded-track observation, not physical display latency.
        const receivedTime=performance.now();
        try {
          width=frame.displayWidth;height=frame.displayHeight;
          const fractions=fixtureLayout==='syphon'?[20/360]:[.4,.5,.6];
          const ys=fractions.map(fraction=>Math.floor(height*fraction)),stripHeight=ys.at(-1)-ys[0]+1;
          if(canvas.width!==width)canvas.width=width;
          if(canvas.height!==stripHeight)canvas.height=stripHeight;
          context.globalCompositeOperation='copy';
          context.drawImage(frame,0,ys[0],width,stripHeight,0,0,width,stripHeight);
          const rows=ys.map(y=>context.getImageData(0,y-ys[0],width,1).data);
          const row=rows[fixtureLayout==='syphon'?0:1];
          // The Syphon fixture uses an opaque sixteen-bit strip across its top.
          // Camera/window fixtures use the anchored middle scanline below.
          if(fixtureLayout==='syphon') {
            let id=0;
            for(let bit=0;bit<16;bit++)if(row[Math.floor(width*(bit+.5)/16)*4]>127)id|=1<<bit;
            observations.push({id,time:performance.now(),receivedTime,mediaTime:frame.timestamp/1000000});
            continue;
          }
          const decoded=window.reviewDecodeIdentityRows(rows,width),id=decoded.id;
          identityReadFailures+=Number(decoded.unreadable);rowDisagreements+=Number(decoded.disagreement);
          const observation={id,time:performance.now(),receivedTime,mediaTime:frame.timestamp/1000000,
            ...(decoded.disagreement?{rowIds:decoded.rows.map(row=>row?.id??null)}: {})};
          const previous=observations.at(-1),step=previous&&id!==null?(id-previous.id+65536)%65536:0;
          const failure=decoded.unreadable||(previous&&step>90);
          if(captureIdentityFailures&&((failure&&identityFailures.length<2)||
            (decoded.disagreement&&identityRowDisagreements.length<2))) {
            const picture=document.createElement('canvas');picture.width=width;picture.height=height;
            picture.getContext('2d').drawImage(frame,0,0,width,height);
            const evidence={index:observations.length,previous,current:observation,step,rows:decoded.rows,
              scanlineRgba:Array.from(row),png:picture.toDataURL('image/png')};
            if(failure&&identityFailures.length<2)identityFailures.push(evidence);
            if(decoded.disagreement&&identityRowDisagreements.length<2)identityRowDisagreements.push(evidence);
          }
          if(id!==null)observations.push(observation);
        } finally {frame.close();}
      }
      ended=performance.timeOrigin+performance.now();clock.end=clockSample();
    } finally {
      clearTimeout(timer);if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}track.stop();
    }
    const tracks=[];
    for(const pc of peers)if(pc.connectionState==='connected') {
      const stats=await pc.getStats();
      for(const item of stats.values())if(item.type==='inbound-rtp')tracks.push({...item,codec:stats.get(item.codecId)?.mimeType});
    }
    return {observations,tracks,width,height,started,ended,clock,method:'MediaStreamTrackProcessor',
      identityReadFailures,rowDisagreements,
      ...(captureIdentityFailures?{identityFailures,identityRowDisagreements}: {})};
  },{milliseconds, peerUuid, fixtureLayout, captureIdentityFailures});
}

async function observeAudio(page, peerUuid = null) {
  return page.evaluate(async peerUuid => {
    const peers = peerUuid ? [window.session?.rpcs?.[peerUuid]] : window.reviewPCs;
    if (peers.some(pc => !pc)) throw Error('Requested receiver peer is absent');
    // A player can retry before its publisher is ready. Retired peer tracks
    // produce silence even when a later connection is receiving real audio.
    const track = peers.filter(pc => pc.connectionState === 'connected')
      .flatMap(pc => pc.getReceivers()).map(r => r.track).find(t => t?.kind === 'audio' && t.readyState === 'live');
    if (!track) throw Error('No received audio track');
    const context = new AudioContext({sampleRate:48000});
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0;
    const splitter = context.createChannelSplitter(2), channels = [context.createAnalyser(), context.createAnalyser()];
    source.connect(splitter);
    for (let i=0;i<2;i++) { channels[i].fftSize=8192; channels[i].smoothingTimeConstant=0; splitter.connect(channels[i],i); }
    const mute = context.createGain(); mute.gain.value = 0;
    source.connect(analyser); analyser.connect(mute);
    channels.forEach(channel => channel.connect(mute)); mute.connect(context.destination);
    await context.resume();
    const spectra = [], pcm = new Float32Array(analyser.fftSize);
    for (let i = 0; i < 30; ++i) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const bins = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(bins);
      const level = (hz, spectrum = bins) => {
        const bin = Math.round(hz * analyser.fftSize / context.sampleRate);
        return Math.max(...spectrum.slice(bin - 2, bin + 3));
      };
      const channelLevels = channels.map(channel => {
        const spectrum = new Float32Array(channel.frequencyBinCount); channel.getFloatFrequencyData(spectrum);
        return {tone440:level(440,spectrum),tone880:level(880,spectrum)};
      });
      analyser.getFloatTimeDomainData(pcm);
      spectra.push({channels:channelLevels,tone440:level(440),tone880:level(880),microphone1200:level(1200),excluded2000:level(2000),
        rms:Math.sqrt(pcm.reduce((sum,value) => sum + value * value,0) / pcm.length)});
    }
    const tracks = [];
    for (const pc of peers) {
      const stats = await pc.getStats();
      for (const value of stats.values()) if (value.type === 'inbound-rtp' && value.kind === 'audio')
        tracks.push({...value,codec:stats.get(value.codecId)?.mimeType,
          negotiatedCodecs:[...stats.values()].filter(item => item.type === 'codec' && /audio\//i.test(item.mimeType))});
    }
    await context.close(); return {spectra,tracks};
  }, peerUuid);
}
module.exports = {sleep, waitFor, receiver, receiverAt, installReceiverProbe, observe, observeDecoded, requireMoving, observeAudio,decodeAnchoredRows};
