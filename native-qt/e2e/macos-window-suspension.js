'use strict';
// Actual decoded audio across minimization of the owned browser source window.
// CDP window operations affect only the target created by the calling workflow:
// https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Browser.pdl
const assert = require('assert/strict');
const {sleep, waitFor, installReceiverProbe, observe, observeAudio} = require('./macos-media-receiver');

function requireRestored(observation, heldId, label, requireMoving) {
  // A queued held image may be presented before the first fresh source frame.
  // The source keeps drawing while minimized, so this single handoff can span
  // the entire suspension. Keep the ordinary moving-frame checks unchanged.
  const frames = observation.observations;
  const firstFresh = frames.findIndex(frame => frame.id !== heldId);
  assert(firstFresh >= 0, `${label}: no fresh image after restoration`);
  const heldPrefixMs = frames[firstFresh].time - frames[0].time;
  assert(heldPrefixMs <= 1000, `${label}: held image persisted after restoration`);
  assert(frames.slice(firstFresh).every(frame => frame.id !== heldId),
    `${label}: returned to the held image after fresh video`);
  for (let index = 1; index < frames.length; ++index)
    assert(frames[index].mediaTime > frames[index - 1].mediaTime,
      `${label}: output timestamps did not advance`);
  requireMoving({...observation, observations:frames.slice(firstFresh)}, label);
  return {heldId, heldPrefixFrames:firstFresh, heldPrefixMs, firstFreshId:frames[firstFresh].id};
}

async function audioContinuityStart(page) {
  await page.evaluate(async () => {
    const pc = window.reviewPCs.find(pc => pc.connectionState === 'connected' &&
      pc.getReceivers().some(r => r.track?.kind === 'audio' && r.track.readyState === 'live'));
    const track = pc?.getReceivers().find(r => r.track?.kind === 'audio')?.track;
    if (!track) throw Error('No live audio for continuity measurement');
    const context = new AudioContext({sampleRate:48000});
    const code = `class Continuity extends AudioWorkletProcessor {
      constructor() {
        super(); this.warmup = sampleRate / 2; this.frames = 0; this.blocks = 0;
        this.energy = [0,0]; this.silent = [0,0]; this.maxSilent = [0,0];
        this.clipped = [0,0]; this.missingStereoBlocks = 0;
        this.port.onmessage = () => this.port.postMessage({sampleRate,frames:this.frames,
          blocks:this.blocks,energy:this.energy,maxSilentFrames:this.maxSilent,
          clippedSamples:this.clipped,missingStereoBlocks:this.missingStereoBlocks});
      }
      process(inputs,outputs) {
        const channels = inputs[0], frames = outputs[0][0].length;
        if(this.warmup > 0) {this.warmup -= frames; return true;}
        this.frames += frames; ++this.blocks;
        if(channels.length !== 2) ++this.missingStereoBlocks;
        for(let channel=0;channel<2;channel++) {
          let energy=0;
          for(const value of channels[channel] || []) {
            energy += value*value; if(Math.abs(value)>=.999) ++this.clipped[channel];
          }
          this.energy[channel] += energy;
          this.silent[channel] = Math.sqrt(energy/frames)<.001 ? this.silent[channel]+frames : 0;
          this.maxSilent[channel] = Math.max(this.maxSilent[channel],this.silent[channel]);
        }
        return true;
      }
    }; registerProcessor('owned-audio-continuity',Continuity);`;
    const url = URL.createObjectURL(new Blob([code], {type:'application/javascript'}));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const node = new AudioWorkletNode(context, 'owned-audio-continuity',
      {channelCount:2,channelCountMode:'explicit',outputChannelCount:[2]});
    const source = context.createMediaStreamSource(new MediaStream([track]));
    source.connect(node); node.connect(context.destination); // Processor emits silence, observes real input.
    await context.resume();
    window.__gcAudioContinuity = {context,node,source,pc,track,started:performance.now()};
  });
  await sleep(1000);
}

async function audioContinuityStop(page) {
  return page.evaluate(async () => {
    const probe = window.__gcAudioContinuity;
    if (!probe) throw Error('Audio continuity probe missing');
    try {
      const data = await new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(Error('Audio continuity processor did not respond')),3000);
        probe.node.port.onmessage = event => {clearTimeout(timer);resolve(event.data);};
        probe.node.port.postMessage('report');
      });
      return {...data,wallSeconds:(performance.now()-probe.started)/1000,
        mediaSeconds:data.frames/data.sampleRate,
        maxSilentMs:data.maxSilentFrames.map(n=>n*1000/data.sampleRate),
        rms:data.energy.map(n=>Math.sqrt(n/data.frames)),
        sameTrackLive:probe.pc.connectionState==='connected' && probe.track.readyState==='live' &&
          probe.pc.getReceivers().some(r=>r.track===probe.track)};
    } finally {
      probe.source.disconnect();probe.node.disconnect();await probe.context.close();delete window.__gcAudioContinuity;
    }
  });
}

async function receiverCounters(page) {
  return page.evaluate(async () => {
    const result = {audio:[],video:[]};
    for (const pc of window.reviewPCs) if (pc.connectionState==='connected') {
      for (const item of (await pc.getStats()).values()) if(item.type==='inbound-rtp') {
        if(item.kind==='audio') result.audio.push({id:item.id,packetsReceived:item.packetsReceived,
          totalSamplesReceived:item.totalSamplesReceived,concealedSamples:item.concealedSamples,
          concealmentEvents:item.concealmentEvents});
        if(item.kind==='video') result.video.push({id:item.id,framesDecoded:item.framesDecoded||0});
      }
    }
    return result;
  });
}

async function exerciseWindowSuspension({source,browser,stream,page,diagnostics,requireAudio,requireMoving,result}) {
  const cdp = await source.context().newCDPSession(source);
  const original = await cdp.send('Browser.getWindowForTarget');
  const {windowId} = original;
  let latePage, observing = false;
  result.passed = false;
  try {
    result.sourceWindow = original;
    result.before = await diagnostics();
    await audioContinuityStart(page); observing = true;
    result.baselineAudio = await observeAudio(page); requireAudio(result.baselineAudio);
    result.receiverBefore = await receiverCounters(page);
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
    await waitFor(async () => (await cdp.send('Browser.getWindowBounds',{windowId})).bounds.windowState==='minimized',
      5000,'Owned source window did not minimize');
    await waitFor(async () => (await diagnostics()).source.suspended===true,5000,'Minimized source did not suspend');
    await sleep(1000);
    result.minimizedWindow = await cdp.send('Browser.getWindowBounds',{windowId});
    result.suspended = await diagnostics();
    assert(result.suspended.app.live && result.suspended.app.capturing);
    result.suspendedAudio = await observeAudio(page); requireAudio(result.suspendedAudio);
    result.suspendedAfter = await diagnostics();
    assert.equal(result.suspended.video.frames_captured,result.suspendedAfter.video.frames_captured,'Capture advanced during suspension');
    assert(result.suspendedAfter.video.frames_sent>result.suspended.video.frames_sent,'Held image stopped being sent');
    result.heldVideo=await observe(page,2000);
    assert(result.heldVideo.observations.length>=15&&new Set(result.heldVideo.observations.map(f=>f.id)).size===1,'Suspended viewer did not retain one paced image');
    assert(result.suspendedAfter.metrics.audio_packets_sent>result.suspended.metrics.audio_packets_sent,
      'Audio packets stopped while video was suspended');

    latePage = await browser.newPage();await installReceiverProbe(latePage);
    await latePage.goto(`https://vdo.ninja/?view=${stream}&password=false&autostart&cleanoutput&stereo=1&ab=510&audiocodec=red`,
      {waitUntil:'domcontentloaded',timeout:45000});
    await waitFor(() => latePage.evaluate(() => window.reviewPCs.some(pc=>pc.connectionState==='connected' &&
      pc.getReceivers().some(r=>r.track?.kind==='audio' && r.track.readyState==='live'))),25000,'Late audio viewer did not connect');
    result.lateAudioWhileSuspended = await observeAudio(latePage);requireAudio(result.lateAudioWhileSuspended);
    result.lateCountersWhileSuspended = await receiverCounters(latePage);
    assert(result.lateCountersWhileSuspended.audio.some(t=>t.packetsReceived>20));
    assert(result.lateCountersWhileSuspended.video.some(t=>t.framesDecoded>15),'Late viewer did not receive the held image');
    result.lateHeldVideo=await observe(latePage,2000);
    assert(result.lateHeldVideo.observations.length>=15&&new Set(result.lateHeldVideo.observations.map(f=>f.id)).size===1,'Late suspended viewer did not retain one paced image');
    assert.equal(result.lateHeldVideo.observations[0].id,result.heldVideo.observations[0].id,'Late viewer received a different held image');
    assert.equal((await diagnostics()).source.suspended,true);

    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
    await source.bringToFront();
    await waitFor(async () => !(await diagnostics()).source.suspended,5000,'Restored source stayed suspended');
    result.restoredWindow = await cdp.send('Browser.getWindowForTarget');
    assert.equal(result.restoredWindow.windowId,windowId);
    assert.equal(result.restoredWindow.bounds.windowState,'normal');
    await waitFor(async () => (await receiverCounters(latePage)).video.some(t=>t.framesDecoded>15),15000,'Late viewer did not receive restored video');
    [result.restoredVideo,result.lateRestoredVideo,result.restoredAudio] = await Promise.all([
      observe(page,3000),observe(latePage,3000),observeAudio(page)]);
    const heldId = result.heldVideo.observations[0].id;
    result.restoredHandoff = requireRestored(result.restoredVideo,heldId,'Restored source',requireMoving);
    result.lateRestoredHandoff = requireRestored(result.lateRestoredVideo,heldId,'Late restored source',requireMoving);
    requireAudio(result.restoredAudio);
    result.after = await diagnostics();assert.equal(result.after.source.source_id,result.before.source.source_id);
    result.receiverAfter = await receiverCounters(page);
    result.continuity = await audioContinuityStop(page);observing = false;
    assert(result.continuity.sameTrackLive,'Existing audio receiver was replaced');
    assert(result.continuity.mediaSeconds>=10 && result.continuity.mediaSeconds>=result.continuity.wallSeconds-1.5,
      'Decoded audio observation did not span the workflow');
    assert.equal(result.continuity.missingStereoBlocks,0);
    assert(result.continuity.maxSilentMs.every(ms=>ms<=50),'Decoded audio contained a gap exceeding 50 ms');
    assert(result.continuity.clippedSamples.every(n=>n===0),'Decoded audio clipped');
    assert(result.continuity.rms.every(rms=>rms>.001));
    result.passed = true;
  } finally {
    if(observing) result.continuity = await audioContinuityStop(page).catch(error=>({error:String(error)}));
    await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}}).catch(()=>{});
    await cdp.detach();if(latePage) await latePage.close();
  }
}

module.exports = {exerciseWindowSuspension};
