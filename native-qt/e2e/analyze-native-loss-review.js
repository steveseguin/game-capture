'use strict';
// Analyze recordings/screenshots from a completed packaged native OBS workflow.
// This reads E2E evidence; it does not launch the application itself.
const fs=require('fs'),path=require('path');
const {execFileSync}=require('child_process');
const [file]=process.argv.slice(2);
if(!file)throw Error('Usage: analyze-native-loss-review.js review-results.json');
const review=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
if(!review.results?.length)throw Error('Review contains no completed cases');
const ffmpeg=path.join(path.dirname(review.publisher),'ffmpeg/bin/ffmpeg.exe');
const results=review.results.map(r=>{
  if(!r.ok||!r.nativePacketLoss?.nativeDropped||!r.obsAlpha?.cadenceRecordings?.length)
    throw Error('A completed native loss workflow with OBS recordings is required: '+r.name);
  const loss=r.nativePacketLoss,ssrcDrops={};
  for(const relay of loss.after.filter(p=>r.nativeRelayPeers.includes(p.uuid))) {
    if(relay.errors.length)throw Error('Native relay reported socket errors');
    const before=loss.before.find(p=>p.uuid===relay.uuid&&p.session===relay.session&&p.relayPort===relay.relayPort);
    for(const [id,s] of Object.entries(relay.ssrc))
      ssrcDrops[id]=(ssrcDrops[id]||0)+s.dropped-(before?.ssrc[id]?.dropped||0);
  }
  const half=r.obsAlpha.samples.filter(s=>['half-opacity','half-opacity-refresh'].includes(s.label));
  if(half.length!==2||half.some(s=>!s.sequence.ok))throw Error('Both half-opacity checkpoints must pass');
  const halfColors=half.map(s=>{
    const sample=s.samples.find(p=>p.classification==='valid-composite');
    if(!sample)throw Error('No valid half-opacity screenshot');
    const screenshot=sample.screenshot.outputPath,expected=sample.halfCompositeColor;
    const rgb=execFileSync(ffmpeg,['-v','error','-i',screenshot,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],
      {windowsHide:true,maxBuffer:16*1024*1024});
    if(rgb.length!==sample.width*sample.height*3)throw Error('Incomplete half-opacity image');
    const expectedRgb=[expected.r,expected.g,expected.b],sum=[0,0,0],maxChannelError=[0,0,0];
    for(let i=0;i<rgb.length;i++) {
      sum[i%3]+=rgb[i];maxChannelError[i%3]=Math.max(maxChannelError[i%3],Math.abs(rgb[i]-expectedRgb[i%3]));
    }
    return {label:s.label,screenshot,expectedRgb,meanRgb:sum.map(n=>n/(rgb.length/3)),maxChannelError};
  });
  const recordings=r.obsAlpha.cadenceRecordings.map(c=>({file:c.file,edgeChangesPerSecond:c.edgeChangesPerSecond,
    audio:JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'analyze-recorded-tone.js'),ffmpeg,c.file],
      {windowsHide:true,encoding:'utf8'}))}));
  return {name:r.name,ok:r.ok,nativeDropped:loss.nativeDropped,ssrcDrops,halfColors,recordings,shutdown:r.shutdown};
});
const output=path.join(path.dirname(path.resolve(file)),'native-loss-analysis.json');
fs.writeFileSync(output,JSON.stringify(results,null,2));
console.log(JSON.stringify({output,results},null,2));
