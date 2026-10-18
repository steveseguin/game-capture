'use strict';
// Continuous content checks for the owned 440 Hz left / 880 Hz right fixture.
// Only deliberate full-source silence/resume gets a declared 500 ms transition
// allowance. Joins, removals and output moves keep the primary tones continuous.
const audio=require('./macos-continuous-audio');
// The owned fixture emits 0.15-peak sine waves (~0.106 RMS). Flag a
// greater-than-half level loss even when a short interruption is not silent.
const shortWindowRmsFloor=.05;
function analyze(batch,{silent=false,transition=false}={}) {
  const full=audio.analyze(batch,1),errors=[];
  if(batch.error)errors.push(batch.error);
  if(batch.state!=='running'||batch.trackState!=='live')errors.push('Received track or observer stopped');
  if(full.seconds<1||Math.abs(full.seconds-full.wallSeconds)>.35)errors.push('Incomplete audio clock coverage');
  if(full.gaps||full.clippedSamples||full.missingChannelFrames||full.invalidSamples)errors.push('PCM integrity/clock failure');
  const allowance=transition?.5:0;
  const first=batch.rows[0]?.frame;
  const checked=batch.rows.filter(r=>(r.frame-first)/batch.sampleRate>=allowance);
  let contentErrors=0,shortWindows=0;
  const shortContentErrors=[];
  for(const row of checked){
    const valid=silent?row.rms.every(v=>v<.0005):
      row.rms.every(v=>v>=.001)&&row.amplitude[0][0]>=.005&&row.amplitude[1][1]>=.005&&
      row.amplitude[0][0]>=10*row.amplitude[0][1]&&row.amplitude[1][1]>=10*row.amplitude[1][0]&&
      row.amplitude.every((ch,i)=>ch[2]<=ch[i]/Math.pow(10,25/20));
    if(!valid)contentErrors++;
    if(row.shortWindowFrames!==batch.sampleRate/100 || !Array.isArray(row.shortRms) || row.shortRms.length!==10 ||
       row.shortRms.some(ch=>!Array.isArray(ch)||ch.length!==2||ch.some(v=>!Number.isFinite(v)))) {
      errors.push('Missing or invalid 10 ms PCM evidence');continue;
    }
    for(let i=0;i<row.shortRms.length;i++) {
      shortWindows++;
      if(!row.shortRms[i].every(v=>silent?v<.0005:v>=shortWindowRmsFloor))
        shortContentErrors.push({frame:row.frame+i*row.shortWindowFrames,rms:row.shortRms[i]});
    }
  }
  if(!checked.length||contentErrors)errors.push('Unexpected received tone/silence/routing window');
  if(shortContentErrors.length)errors.push('Unexpected received level in 10 ms PCM window');
  return {passed:errors.length===0,expectedSilent:silent,transitionAllowanceMs:allowance*1000,
    seconds:full.seconds,wallSeconds:full.wallSeconds,windows:full.windows,checkedContentWindows:checked.length,
    contentErrors,shortWindowRmsFloor,checkedShortWindows:shortWindows,shortContentErrors,
    gaps:full.gaps,clippedSamples:full.clippedSamples,missingChannelFrames:full.missingChannelFrames,
    invalidSamples:full.invalidSamples,errors};
}
// Keep all summaries, but reserve raw PCM for non-silent bad windows so long
// intentional silence cannot exhaust the budget or delay the next command.
module.exports={start:page=>audio.start(page,{shortWindowRmsFloor,badWindowPcmBudget:4,includeSilentPcm:false}),drain:audio.drain,stop:audio.stop,analyze};
