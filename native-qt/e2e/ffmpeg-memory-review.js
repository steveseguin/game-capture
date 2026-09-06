'use strict';
// Encoder isolation experiment; this does not replace packaged application E2E.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {spawn,execFile}=require('child_process'),{promisify}=require('util');
const exec=promisify(execFile);
const opts=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return [arg.slice(2,i),arg.slice(i+1)];}));
async function main() {
  const ffmpeg=path.resolve(opts.ffmpeg),encoder=opts.encoder||'h264_qsv',frames=Number(opts.frames||18000);
  if(!['h264_qsv','h264_nvenc','libvpx-vp9'].includes(encoder)||!Number.isSafeInteger(frames)||frames<1)
    throw Error('Supported encoder and positive frame count required');
  const runtimePath=opts['runtime-path']?path.resolve(opts['runtime-path']):undefined;
  if(runtimePath&&(encoder!=='h264_qsv'||!fs.statSync(runtimePath).isDirectory()||
    !fs.readdirSync(runtimePath).some(name=>/^(libmfx64-gen|libmfxhw64|libvpl.*)\.dll$/i.test(name))))
    throw Error('Runtime priority requires QSV and a directory containing a VPL runtime DLL');
  const upload=opts['hw-upload']==='1';
  if((upload||opts['low-power']!==undefined)&&encoder!=='h264_qsv')throw Error('QSV options require h264_qsv');
  const output=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(output,{recursive:true});
  const args=['-hide_banner','-loglevel',opts['log-level']||'error','-nostats','-progress','pipe:2',
    ...(upload?['-init_hw_device','d3d11va=reviewIntel:,vendor_id=0x8086',
      '-init_hw_device','qsv=review@reviewIntel','-filter_hw_device','review']:[]),'-f','lavfi',
    '-i','testsrc2=size=1280x720:rate=60,format=nv12','-an','-frames:v',String(frames),'-c:v',encoder,
    '-b:v','4000k','-maxrate','8000k','-bufsize','16000k','-g','60'];
  if(encoder==='h264_qsv')args.push('-bf','0','-async_depth','1','-forced_idr','1');
  if(encoder==='h264_nvenc')args.push('-bf','0','-delay','0','-forced-idr','1');
  if(encoder==='libvpx-vp9')args.push('-deadline','realtime','-cpu-used','8','-row-mt','1','-threads','4','-lag-in-frames','0');
  if(opts['low-power']!==undefined)args.push('-low_power',opts['low-power']);
  if(upload)args.push('-vf','setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=smpte170m,hwupload=extra_hw_frames=8');
  if(encoder!=='libvpx-vp9') {
    args.push('-force_key_frames','expr:gte(t,n_forced*2.5)','-pix_fmt',upload?'qsv':'nv12');
    if(!upload)args.push('-colorspace','smpte170m','-color_primaries','bt709','-color_trc','iec61966-2-1','-color_range','tv');
    if(opts.bsf!=='none')args.push('-bsf:v','h264_metadata=aud=insert,dump_extra=freq=keyframe');
  }
  args.push('-f',encoder==='libvpx-vp9'?'ivf':'h264','-y','NUL');
  const result={ffmpeg,sha256:crypto.createHash('sha256').update(fs.readFileSync(ffmpeg)).digest('hex'),
    args,startedMs:Date.now(),requestedFrames:frames,samples:[]};
  const log=fs.createWriteStream(path.join(output,'ffmpeg.log'));
  result.runtimePriorityPath=runtimePath;
  const child=spawn(ffmpeg,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],
    env:{...process.env,...(runtimePath?{ONEVPL_PRIORITY_PATH:runtimePath}:{}),
      ...(opts['dispatcher-log']==='1'?{ONEVPL_DISPATCHER_LOG:'ON',
        ONEVPL_DISPATCHER_LOG_FILE:path.join(output,'dispatcher.log')}:{})}});
  result.pid=child.pid;let pending='',currentFrame=0,spawnError;
  child.on('error',e=>{spawnError=e;});
  child.stderr.on('data',data=>{
    log.write(data);pending+=data.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();
    for(const line of lines)if(/^frame=\d+$/.test(line))currentFrame=Number(line.slice(6));
  });
  const closed=new Promise(resolve=>child.on('close',resolve));
  console.log('Encoder experiment:',output,'PID',child.pid);
  try {
    while(child.exitCode===null&&child.signalCode===null) {
      if(spawnError)throw spawnError;
      if(Date.now()-result.startedMs>300000)throw Error('Encoder experiment exceeded five minutes');
      await Promise.race([closed,new Promise(r=>setTimeout(r,2000))]);
      if(child.exitCode!==null||child.signalCode!==null)break;
      try {
        const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',
          `Get-Process -Id ${child.pid} -ErrorAction Stop | Select-Object PrivateMemorySize64,WorkingSet64,HandleCount | ConvertTo-Json -Compress`],{windowsHide:true,timeout:5000});
        result.samples.push({ms:Date.now()-result.startedMs,frame:currentFrame,...JSON.parse(stdout)});
        if(!result.runtimeModules) {
          const modules=await exec('powershell.exe',['-NoProfile','-Command',
            `(Get-Process -Id ${child.pid}).Modules | Where-Object ModuleName -Match 'mfx|vpl' | Select-Object ModuleName,FileName,@{Name='Version';Expression={$_.FileVersionInfo.FileVersion}} | ConvertTo-Json -Compress`],{windowsHide:true,timeout:5000});
          result.runtimeModules=JSON.parse(modules.stdout||'[]');
        }
      } catch(e){if(child.exitCode===null)throw e;}
    }
    await closed;result.exitCode=child.exitCode;result.frames=currentFrame;
    if(child.exitCode!==0||currentFrame!==frames)throw Error('Encoder did not complete the requested frames');
    result.ok=true;
  } catch(e){result.error=String(e);result.ok=false;throw e;}
  finally {
    if(child.exitCode===null&&child.signalCode===null){child.kill();await closed;}
    log.end();result.completedMs=Date.now();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({ok:result.ok,frames:result.frames,first:result.samples[0],last:result.samples.at(-1)}));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
