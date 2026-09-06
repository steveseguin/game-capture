'use strict';
// Native OBS receiver alongside the browser control/format observer.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),net=require('net');
const {spawn,execFile}=require('child_process');
const {promisify}=require('util');
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

exports.start=async function({repo,stream,output,expectedPluginHash,width,height}) {
  repo=path.resolve(repo);
  fs.mkdirSync(output,{recursive:true});
  if(!/^[a-f0-9]{64}$/i.test(expectedPluginHash||''))throw Error('Expected OBS plugin SHA256 is required');
  const checker=path.join(repo,'scripts/obs-websocket-vdoninja-source-check.cjs');
  const {ObsWebSocketClient,analyzeAlphaComposite,analyzeAlphaCompositeSequence}=require(checker);
  const portable=path.join(repo,'_obs-portable'),exe=path.join(portable,'bin/64bit/obs64.exe');
  if(!fs.existsSync(exe))throw Error('Portable OBS executable is missing');
  const running=await exec('powershell.exe',['-NoProfile','-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name='obs64.exe'\" | Select-Object ExecutablePath) | ConvertTo-Json -Compress"],{windowsHide:true});
  const processes=running.stdout.trim()?JSON.parse(running.stdout):[];
  if([].concat(processes).some(p=>p.ExecutablePath?.toLowerCase()===exe.toLowerCase()))throw Error('Isolated OBS is already running');
  // Match the portable workflow's cleanup: stale fixture sentinels otherwise
  // open a recovery dialog before the WebSocket server starts (OBS 32).
  const sentinel=path.join(portable,'config/obs-studio/.sentinel');
  if(fs.existsSync(sentinel))for(const entry of fs.readdirSync(sentinel,{withFileTypes:true})) {
    if(entry.isFile())fs.unlinkSync(path.join(sentinel,entry.name));
  }
  const configPath=path.join(portable,'config/obs-studio/plugin_config/obs-websocket/config.json');
  const originalConfig=fs.readFileSync(configPath,'utf8');
  const config=JSON.parse(originalConfig.replace(/^\uFEFF/,''));
  const port=await new Promise((resolve,reject)=>{
    const server=net.createServer();server.on('error',reject);
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
  });
  fs.writeFileSync(configPath,JSON.stringify({...config,server_enabled:true,auth_required:false,server_port:port}));
  let proc,client,previousScene;
  const stamp=Date.now(),scene=`Capture runtime ${stamp}`,input=`Capture receiver ${stamp}`,background=`Capture background ${stamp}`;
  const evidence={checkerSha256:hash(fs.readFileSync(checker)),samples:[]};
  const log=fs.createWriteStream(path.join(output,'obs-runtime.log'));
  async function close() {
    if(client) {
      for(const name of [input,background])try{await client.request('RemoveInput',{inputName:name});}catch{}
      if(previousScene)try{await client.request('SetCurrentProgramScene',{sceneName:previousScene});}catch{}
      try{await client.request('RemoveScene',{sceneName:scene});}catch{}
      try{await client.close();}catch{}
    }
    if(proc&&proc.exitCode===null) {
      proc.kill();const deadline=Date.now()+5000;
      while(proc.exitCode===null&&proc.signalCode===null&&Date.now()<deadline)await sleep(50);
    }
    fs.writeFileSync(configPath,originalConfig);log.end();
  }
  async function screenshot(label) {
    const startedAt=Date.now();
    const data=await client.request('GetSourceScreenshot',{sourceName:scene,imageFormat:'png',imageWidth:480,imageHeight:300});
    const bytes=Buffer.from(data.imageData.split(',')[1],'base64');
    const outputPath=path.join(output,`${label}.png`);fs.writeFileSync(outputPath,bytes);
    return {outputPath,sha256:hash(bytes),captureStartedAtMs:startedAt};
  }
  try {
    proc=spawn(exe,['--portable'],{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,OBS_PLUGINS_DATA_PATH:path.join(repo,'install/data/obs-plugins')}});
    let spawnError;proc.on('error',error=>{spawnError=error;});
    proc.stdout.pipe(log,{end:false});proc.stderr.pipe(log,{end:false});
    await sleep(8000);
    if(spawnError)throw spawnError;
    if(proc.exitCode!==null)throw Error('OBS exited during startup');
    client=new ObsWebSocketClient(`ws://127.0.0.1:${port}`);await client.connect();
    const modules=await exec('powershell.exe',['-NoProfile','-Command',
      `(Get-Process -Id ${proc.pid}).Modules | Where-Object ModuleName -eq 'obs-vdoninja.dll' | ForEach-Object {$_.FileName}`],{windowsHide:true});
    const loaded=modules.stdout.trim();
    if(!loaded||loaded.split(/\r?\n/).length!==1||hash(fs.readFileSync(loaded))!==expectedPluginHash.toLowerCase())
      throw Error('Loaded OBS plugin does not match the expected artifact');
    evidence.plugin={path:loaded,sha256:hash(fs.readFileSync(loaded)),obsPid:proc.pid};
    previousScene=(await client.request('GetCurrentProgramScene')).currentProgramSceneName;
    const canvas=await client.request('GetVideoSettings');
    await client.request('CreateScene',{sceneName:scene});
    await client.request('SetCurrentProgramScene',{sceneName:scene});
    const kinds=(await client.request('GetInputKindList')).inputKinds;
    const colorKind=kinds.find(k=>k==='color_source_v3')||kinds.find(k=>k.startsWith('color_source'));
    if(!colorKind)throw Error('OBS color source is unavailable');
    async function add(inputName,inputKind,inputSettings) {
      const item=await client.request('CreateInput',{sceneName:scene,inputName,inputKind,inputSettings,sceneItemEnabled:true});
      await client.request('SetSceneItemTransform',{sceneName:scene,sceneItemId:item.sceneItemId,
        sceneItemTransform:{positionX:0,positionY:0,boundsType:'OBS_BOUNDS_STRETCH',boundsWidth:canvas.baseWidth,boundsHeight:canvas.baseHeight}});
    }
    await add(background,colorKind,{width:canvas.baseWidth,height:canvas.baseHeight,color:0xffff00ff});
    await sleep(150);
    const backdrop=await screenshot('obs-background');
    await add(input,'vdoninja_source',{stream_id:stream,password:'false',room_id:'',use_native_receiver:true,
      enable_data_channel:true,auto_reconnect:true,width,height});
    return {evidence,close,async sample(label) {
      const samples=[],deadline=Date.now()+20000;let useful=0,previousStart=0;
      while(useful<10&&Date.now()<deadline) {
        await sleep(Math.max(0,previousStart+80-Date.now()));previousStart=Date.now();
        const shot=await screenshot(`obs-${label}-${samples.length+1}`);
        const analysis=analyzeAlphaComposite(backdrop.outputPath,shot.outputPath,{
          pattern:'alpha-moving-edge',expectedVisualEpoch:'pre',sampleStep:2,throwOnFailure:false});
        samples.push({...analysis,sample:samples.length+1,checkpoint:label,connectionEpoch:'pre',screenshot:shot});
        if(analysis.classification!=='waiting-background')useful++;
      }
      const sequence=analyzeAlphaCompositeSequence(samples,{pattern:'alpha-moving-edge',expectedVisualEpoch:'pre',
        requiredUsefulSampleCount:10,requireEvidenceFiles:true});
      const result={label,sequence,samples};evidence.samples.push(result);
      fs.writeFileSync(path.join(output,'obs-runtime-results.json'),JSON.stringify(evidence,null,2));
      if(!sequence.ok)throw Error('OBS moving alpha failed: '+sequence.failureReasons.join('; '));
      return result;
    }};
  } catch(error) {await close();throw error;}
};
