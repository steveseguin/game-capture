#!/usr/bin/env node
'use strict';
// Independent decode and expected-identity gate for the native x264 experiment.
// This is not a packaged application run or a replay of captured browser pixels.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {decodeAnchoredRows}=require('../e2e/macos-media-receiver');
const root=path.resolve(process.argv[2]||''),ffmpeg=process.argv[3]||'ffmpeg';
if(!process.argv[2])throw Error('Use NATIVE_GATE_DIRECTORY [FFMPEG]');
const out=path.join(root,'independent-analysis');fs.mkdirSync(out);
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={scope:'Native deterministic fixture signal metrics and independent decoder identities; not application testing or a matched live-source quality benchmark',
  scriptSha256:sha(__filename),identityReaderSha256:sha(path.join(__dirname,'../e2e/macos-media-receiver.js')),
  decoderVersion:execFileSync(ffmpeg,['-version'],{encoding:'utf8'}),cases:[],passed:false};
const save=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2)+'\n');
fs.copyFileSync(__filename,path.join(out,path.basename(__filename)));
async function decode(mode) {
  const file=path.join(root,mode,'packets.csv'),lines=fs.readFileSync(file,'utf8').trim().split('\n'),keys=lines.shift().split(',');
  const rows=lines.map(line=>Object.fromEntries(line.split(',').map((v,i)=>[keys[i],Number(v)])));
  if(rows.length!==420||rows.some(r=>!(r.psnr_y>0)||!(r.ssim>0)))throw Error('Missing native reconstruction metrics');
  const entry={mode,bitstreamSha256:sha(path.join(root,mode,'video.h264')),packetCsvSha256:sha(file),phases:[],frames:[],unreadable:0,disagreements:0,wrongIdentity:0,passed:false};
  result.cases.push(entry);
  for(const [name,start,end,seconds] of [['baseline',0,120,2],['slow',120,300,9],['recovery',300,420,2]]) {
    const r=rows.slice(start,end),sum=k=>r.reduce((n,x)=>n+x[k],0);
    entry.phases.push({name,frames:r.length,presentationSeconds:seconds,kbps:8*sum('bytes')/seconds/1000,
      globalPsnrY:10*Math.log10(r.length/r.reduce((n,x)=>n+10**(-x.psnr_y/10),0)),meanSsimY:sum('ssim')/r.length,
      maxDelayedInputs:Math.max(...r.map(x=>x.submitted-x.source_index))});
  }
  const width=3840,height=2160,ys=[.4,.5,.6].map(v=>Math.floor(height*v));
  const filter=`[0:v]format=rgba,split=3[a][b][c];[a]crop=${width}:1:0:${ys[0]}[ra];[b]crop=${width}:1:0:${ys[1]}[rb];[c]crop=${width}:1:0:${ys[2]}[rc];[ra][rb][rc]vstack=inputs=3[out]`;
  const args=['-hide_banner','-loglevel','warning','-threads','2','-i',path.join(root,mode,'video.h264'),'-filter_complex_threads','1','-filter_complex',filter,'-map','[out]','-fps_mode','passthrough','-threads','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'];
  entry.command=[ffmpeg,...args];
  const fd=fs.openSync(path.join(out,mode+'-decode.log'),'wx');
  const child=spawn(ffmpeg,args,{stdio:['ignore','pipe',fd]});fs.closeSync(fd);
  const buffer=Buffer.allocUnsafe(width*3*4);let filled=0,error;
  const timeout=setTimeout(()=>{error=Error('Independent decode exceeded two minutes');child.kill('SIGKILL');},120000);
  child.on('error',e=>{error=e;});
  child.stdout.on('data',chunk=>{
    let offset=0;
    while(offset<chunk.length) {
      const n=Math.min(buffer.length-filled,chunk.length-offset);chunk.copy(buffer,filled,offset,offset+n);filled+=n;offset+=n;
      if(filled<buffer.length)continue;
      const decoded=decodeAnchoredRows([0,1,2].map(y=>buffer.subarray(y*width*4,(y+1)*width*4)),width),index=entry.frames.length;
      const expected=rows[index]?.identity;
      entry.frames.push({index,expected,id:decoded.id,rows:decoded.rows.map(r=>r?.id??null)});
      entry.unreadable+=Number(decoded.unreadable);entry.disagreements+=Number(decoded.disagreement);entry.wrongIdentity+=Number(decoded.id!==null&&decoded.id!==expected);filled=0;
    }
  });
  await new Promise(resolve=>child.on('close',(code,signal)=>{clearTimeout(timeout);entry.exitCode=code;entry.signal=signal;resolve();}));
  entry.decoderComplete=!error&&entry.exitCode===0&&!entry.signal&&!filled&&entry.frames.length===rows.length;
  entry.passed=entry.decoderComplete&&!entry.unreadable&&!entry.disagreements&&!entry.wrongIdentity;
  if(error)entry.error=String(error);save();console.log(JSON.stringify({mode,frames:entry.frames.length,unreadable:entry.unreadable,disagreements:entry.disagreements,wrongIdentity:entry.wrongIdentity,passed:entry.passed,phases:entry.phases}));
}
(async()=>{
 try {
  for(const mode of ['cfr60','vfr60','cfr20'])await decode(mode);
  if(!result.cases.every(c=>JSON.stringify(c.frames.map(f=>f.expected))===JSON.stringify(result.cases[0].frames.map(f=>f.expected))))throw Error('Native inputs have different identity sequences');
  result.passed=result.cases.every(c=>c.passed);
 } catch(e){result.error=String(e);}
 finally{save();process.exitCode=result.passed?0:1;}
})();
