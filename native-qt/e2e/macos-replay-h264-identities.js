#!/usr/bin/env node
'use strict';
// Independently decode a retained, fixed-resolution fixture GOP. This verifies
// saved output; it does not replace running the packaged application workflow.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {decodeAnchoredRows,requireMoving}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(arg=>{
  const at=arg.indexOf('=');return [arg.slice(2,at),arg.slice(at+1)];
}));
const width=Number(opts.width),height=Number(opts.height);
if(!opts.input||!opts.report||![width,height].every(v=>Number.isInteger(v)&&v>=32&&v<=8192))
  throw Error('Use --input=file.h264 --report=new-directory --width=N --height=N [--ffmpeg=path]');
const directory=path.resolve(opts.report),input=path.resolve(opts.input),ffmpeg=opts.ffmpeg||'ffmpeg';
if(fs.existsSync(directory))throw Error('Use a new report directory to preserve earlier evidence');
fs.mkdirSync(directory,{recursive:true});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const ys=[.4,.5,.6].map(y=>Math.floor(height*y)),stripHeight=ys[2]-ys[0]+1,frameBytes=width*stripHeight*4;
const args=['-hide_banner','-loglevel','warning','-threads','4','-i',input,
  '-vf',`format=rgba,crop=${width}:${stripHeight}:0:${ys[0]}`,
  '-fps_mode','passthrough','-threads','1','-f','rawvideo','pipe:1'];
const result={scope:'Independent FFmpeg decode of retained packaged application output, not a new application run or quality score',
  inputSha256:sha(fs.readFileSync(input)),scriptSha256:sha(fs.readFileSync(__filename)),
  identityReaderSha256:sha(fs.readFileSync(path.join(__dirname,'macos-media-receiver.js'))),
  ffmpegVersion:execFileSync(ffmpeg,['-version'],{encoding:'utf8'}),command:[ffmpeg,...args],width,height,
  frames:[],identityReadFailures:0,rowDisagreements:0,passed:false};
fs.copyFileSync(__filename,path.join(directory,path.basename(__filename)));
const log=fs.openSync(path.join(directory,'decode.log'),'wx');
const child=spawn(ffmpeg,args,{stdio:['ignore','pipe',log]});
fs.closeSync(log);
let buffer=Buffer.alloc(0),error;
const timeout=setTimeout(()=>{error=Error('Decode exceeded two minutes');child.kill('SIGKILL');},120000);
child.on('error',e=>{error=e;});
child.stdout.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=frameBytes) {
    const pixels=buffer.subarray(0,frameBytes);
    const rows=ys.map(y=>pixels.subarray((y-ys[0])*width*4,(y-ys[0]+1)*width*4));
    const decoded=decodeAnchoredRows(rows,width);
    result.frames.push({index:result.frames.length,id:decoded.id,rows:decoded.rows});
    result.identityReadFailures+=Number(decoded.unreadable);
    result.rowDisagreements+=Number(decoded.disagreement);
    buffer=buffer.subarray(frameBytes);
  }
});
child.on('close',(code,signal)=>{
  clearTimeout(timeout);result.exitCode=code;result.signal=signal;
  try {
    if(error)throw error;
    if(code!==0||signal||buffer.length)throw Error('Incomplete independent decode');
    requireMoving({observations:result.frames,identityReadFailures:result.identityReadFailures,
      tracks:[{codec:'video/h264'}]},'Retained H.264 fixture');
    result.passed=true;
  } catch(e) {result.error=String(e);}
  fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({report:directory,passed:result.passed,frames:result.frames.length,
    identityReadFailures:result.identityReadFailures,rowDisagreements:result.rowDisagreements,error:result.error}));
  process.exitCode=result.passed?0:1;
});
