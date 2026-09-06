'use strict';
// Analyze the real OBS recording of audio-test-tone.ps1 (440 Hz, amplitude .08).
// This is artifact analysis for E2E; it does not launch an application itself.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {execFileSync}=require('child_process');
const [ffmpeg,file,report]=process.argv.slice(2);
if(!ffmpeg||!file)throw Error('Usage: analyze-recorded-tone.js ffmpeg.exe recording.mp4 [report.json]');
const pcm=execFileSync(path.resolve(ffmpeg),['-v','error','-i',path.resolve(file),'-map','0:a:0',
  '-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'],{windowsHide:true,maxBuffer:32*1024*1024});
if(pcm.length%4)throw Error('Incomplete decoded PCM sample');
const sampleRate=48000,total=pcm.length/4,trim=sampleRate/2;
if(total<sampleRate*2)throw Error('Recording is too short for tone analysis');
let energy=0,peak=0,crossings=0,clipped=0,windowEnergy=0;
const windows=[],windowSize=sampleRate/10;
for(let i=trim;i<total-trim;i++) {
  const value=pcm.readFloatLE(i*4),previous=pcm.readFloatLE((i-1)*4);
  if(!Number.isFinite(value))throw Error('Non-finite recorded audio sample');
  energy+=value*value;windowEnergy+=value*value;peak=Math.max(peak,Math.abs(value));
  if(Math.abs(value)>=.999)clipped++;
  if(previous<=0&&value>0)crossings++;
  if((i-trim+1)%windowSize===0){windows.push(Math.sqrt(windowEnergy/windowSize));windowEnergy=0;}
}
const samples=total-2*trim,seconds=samples/sampleRate;
const result={file:path.resolve(file),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  recordedSeconds:total/sampleRate,analyzedSeconds:seconds,trimmedSecondsPerEnd:.5,sampleRate,
  rms:Math.sqrt(energy/samples),peak,clippedSamples:clipped,zeroCrossingHz:crossings/seconds,
  rmsWindowMs:100,windowRms:windows};
result.ok=result.rms>.005&&Math.abs(result.zeroCrossingHz-440)<=5&&clipped===0&&windows.every(rms=>rms>.005);
fs.writeFileSync(report||file+'.audio.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,windowRms:undefined,minimumWindowRms:Math.min(...windows)}));
if(!result.ok)process.exitCode=1;
