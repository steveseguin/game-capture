/* Isolated portable OBS, actual native/browser sources and recorded output. */
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {spawn,execFileSync}=require('child_process');const WebSocket=require('ws');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Obs {
  constructor(url,password){this.url=url;this.password=password;this.pending=new Map();this.events=[];}
  async connect(){
    this.ws=new WebSocket(this.url,'obswebsocket.json');
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('OBS handshake timed out')),10000);
      this.ws.on('error',reject);
      this.ws.on('message',raw=>{
        const m=JSON.parse(raw);
        if(m.op===0){const d={rpcVersion:1,eventSubscriptions:1|64|128|256|65536};
          if(m.d.authentication){const a=m.d.authentication;
            const secret=crypto.createHash('sha256').update(this.password+a.salt).digest('base64');
            d.authentication=crypto.createHash('sha256').update(secret+a.challenge).digest('base64');}
          this.ws.send(JSON.stringify({op:1,d}));
        }else if(m.op===2){clearTimeout(timeout);resolve();}
        else if(m.op===7){const p=this.pending.get(m.d.requestId);if(p){this.pending.delete(m.d.requestId);clearTimeout(p.timer);m.d.requestStatus.result?p.resolve(m.d.responseData||{}):p.reject(Error(JSON.stringify(m.d.requestStatus)));}}
        else if(m.op===5)this.events.push({time:Date.now(),...m.d});
      });
    });
  }
  request(requestType,requestData={}){return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('OBS request timeout: '+requestType));},15000);this.pending.set(requestId,{resolve,reject,timer});this.ws.send(JSON.stringify({op:6,d:{requestId,requestType,requestData}}));});}
  close(){this.ws?.close();}
}
function setIni(text,section,key,value){
  const regex=new RegExp('(\\['+section+'\\]\\r?\\n)([\\s\\S]*?)(?=\\r?\\n\\[|$)');
  if(!regex.test(text))return text+'\n['+section+']\n'+key+'='+value+'\n';
  return text.replace(regex,(_,heading,body)=>heading+(new RegExp('^'+key+'=.*$','m').test(body)?body.replace(new RegExp('^'+key+'=.*$','m'),key+'='+value):body+'\n'+key+'='+value));
}
async function start(root,output){
  root=path.resolve(root);fs.mkdirSync(output,{recursive:true});
  const config=path.join(root,'config/obs-studio'),configFile=path.join(config,'plugin_config/obs-websocket/config.json');
  // This helper only owns the disposable portable copy under the QA report.
  if(!root.includes(path.join('qa','reports')))throw Error('An isolated QA copy of OBS is required');
  const sentinel=path.join(config,'.sentinel');
  if(fs.existsSync(sentinel))for(const entry of fs.readdirSync(sentinel,{withFileTypes:true}))if(entry.isFile()&&entry.name.startsWith('run_'))fs.unlinkSync(path.join(sentinel,entry.name));
  const password=crypto.randomBytes(18).toString('hex'),port=4458;
  const configJson=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\ufeff/,''));
  Object.assign(configJson,{server_enabled:true,auth_required:true,server_password:password,server_port:port,alerts_enabled:false});
  fs.writeFileSync(configFile,JSON.stringify(configJson));
  const profiles=path.join(config,'basic/profiles');const profile=fs.readdirSync(profiles).map(n=>path.join(profiles,n,'basic.ini')).find(p=>fs.existsSync(p));
  let ini=fs.readFileSync(profile,'utf8');
  for(const [s,k,v] of [['Video','BaseCX',1280],['Video','BaseCY',720],['Video','OutputCX',1280],['Video','OutputCY',720],
    ['Output','Mode','Simple'],['SimpleOutput','FilePath',output.replaceAll('\\','/')],['SimpleOutput','RecFormat2','mkv'],
    ['SimpleOutput','RecQuality','HQ'],['SimpleOutput','RecEncoder','x264'],['SimpleOutput','ABitrate',320]])ini=setIni(ini,s,k,v);
  fs.writeFileSync(profile,ini);
  const exe=path.join(root,'bin/64bit/obs64.exe'),log=fs.createWriteStream(path.join(output,'obs-process.log'));
  const proc=spawn(exe,['--portable','--disable-shutdown-check','--disable-updater'],{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe']});
  proc.stdout.pipe(log);proc.stderr.pipe(log);const closed=new Promise(r=>proc.once('close',r));
  let client;
  try{
    for(let i=0;i<40;i++){try{client=new Obs('ws://127.0.0.1:'+port,password);await client.connect();break;}catch(e){client?.close();if(proc.exitCode!==null)throw Error('OBS exited '+proc.exitCode);if(i===39)throw e;await sleep(500);}}
    const version=await client.request('GetVersion');
    await client.request('SetRecordDirectory',{recordDirectory:output});
    const modules=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${proc.pid}).Modules | Where-Object { $_.ModuleName -match 'obs-vdoninja|obs.dll|obs64|obs-browser' } | Select-Object ModuleName,FileName | ConvertTo-Json`],{encoding:'utf8',windowsHide:true}));
    const plugin=modules.find(m=>m.ModuleName==='obs-vdoninja.dll');if(!plugin||!plugin.FileName.toLowerCase().startsWith(root.toLowerCase()))throw Error('Wrong OBS plugin module path');
    fs.writeFileSync(path.join(output,'obs-identity.json'),JSON.stringify({pid:proc.pid,exe,version,modules,pluginSha256:crypto.createHash('sha256').update(fs.readFileSync(plugin.FileName)).digest('hex')},null,2));
    // Silence unrelated global OBS inputs in this disposable profile. Monitoring
    // stays off so the receiver cannot feed back into publisher loopback audio.
    const inputs=await client.request('GetInputList');for(const input of inputs.inputs)await client.request('SetInputMute',{inputName:input.inputName,inputMuted:true}).catch(()=>{});
    return {client,proc,closed,log,root,output};
  }catch(e){proc.kill();await closed;throw e;}
}
async function receive(obs,c,dir,url,seconds,source){
  const client=obs.client,scene='Quality-'+c.id,input=scene+'-receiver',r={case:c,seconds};
  const viewer=new URL(url);const stream=viewer.searchParams.get('view');
  try{
    const existingScenes=await client.request('GetSceneList');
    if(existingScenes.scenes.some(s=>s.sceneName===scene))await client.request('RemoveScene',{sceneName:scene});
    await client.request('CreateScene',{sceneName:scene});await client.request('SetCurrentProgramScene',{sceneName:scene});
    // Retain actual viewer startup as well as steady playback in the recording.
    r.before=await client.request('GetStats');r.recordStart=Date.now();r.recordingIncludesInputStartup=true;
    await client.request('StartRecord');await sleep(500);
    if(!(await client.request('GetRecordStatus')).outputActive)throw Error('OBS recording did not remain active');
    const settings=c.direct?{method:2,capture_cursor:false}:c.obsBrowser?{url:url+'&autostart&cleanoutput',width:1280,height:720,reroute_audio:true,shutdown:true}:
      {stream_id:stream,password:'false',room_id:'',use_native_receiver:true,enable_data_channel:true,auto_reconnect:true,width:1280,height:720};
    const created=await client.request('CreateInput',{sceneName:scene,inputName:input,inputKind:c.direct?'window_capture':c.obsBrowser?'browser_source':'vdoninja_source',inputSettings:settings,sceneItemEnabled:true});
    if(c.direct){
      const items=await client.request('GetInputPropertiesListPropertyItems',{inputName:input,propertyName:'window'});
      const item=items.propertyItems.find(i=>i.itemName.includes('Game Capture Quality Source'));if(!item)throw Error('OBS cannot find calibration fixture');
      await client.request('SetInputSettings',{inputName:input,inputSettings:{window:item.itemValue,method:2,capture_cursor:false},overlay:true});
      await client.request('CreateInput',{sceneName:scene,inputName:input+'-audio',inputKind:'wasapi_output_capture',inputSettings:{device_id:'default'},sceneItemEnabled:true});
      await client.request('SetInputAudioMonitorType',{inputName:input+'-audio',monitorType:'OBS_MONITORING_TYPE_NONE'});
    }
    await client.request('SetSceneItemTransform',{sceneName:scene,sceneItemId:created.sceneItemId,sceneItemTransform:{positionX:0,positionY:0,boundsType:'OBS_BOUNDS_SCALE_INNER',boundsWidth:1280,boundsHeight:720}});
    if(!c.direct){await client.request('SetInputMute',{inputName:input,inputMuted:false});
    await client.request('SetInputAudioMonitorType',{inputName:input,monitorType:'OBS_MONITORING_TYPE_NONE'});}
    await sleep(16000);
    r.settings=await client.request('GetInputSettings',{inputName:input});
    console.log(c.id,'OBS recording',seconds+'s');await sleep(seconds*1000);
    r.recordStop=Date.now();const recording=await client.request('StopRecord');r.recording=recording.outputPath;
    // StopRecord can return while the muxer is still draining. Closing OBS then
    // opens its active-output confirmation instead of completing shutdown.
    const stopDeadline=Date.now()+30000;
    while((await client.request('GetRecordStatus')).outputActive){
      if(Date.now()>stopDeadline)throw Error('OBS recording did not stop');
      await sleep(100);
    }
    await client.request('SaveSourceScreenshot',{sourceName:scene,imageFormat:'png',imageFilePath:path.join(dir,'obs-output.png'),imageWidth:1280,imageHeight:720});
    r.after=await client.request('GetStats');
    r.source=await source.evaluate(()=>({epoch:quality.epoch,calibrations:quality.calibrations}));
    r.audioMeters=client.events.filter(e=>e.eventType==='InputVolumeMeters'&&e.time>=r.recordStart&&e.time<=r.recordStop).map(e=>({time:e.time,inputs:e.eventData.inputs.filter(i=>i.inputName===input)}));
    r.ok=true;
  }catch(e){r.error=String(e);throw e;}
  finally{await client.request('RemoveInput',{inputName:input}).catch(()=>{});if(c.direct)await client.request('RemoveInput',{inputName:input+'-audio'}).catch(()=>{});fs.writeFileSync(path.join(dir,'obs-receiver.json'),JSON.stringify(r,null,2));}
  return r;
}
async function stop(obs){
  const started=Date.now();
  obs.client.close();
  const python=path.resolve(__dirname,'../.cache/desktop-ui-python/Scripts/python.exe');
  execFileSync(python,['-c',`import win32gui,win32process,win32con; pid=${obs.proc.pid}\ndef visit(h,_):\n if win32process.GetWindowThreadProcessId(h)[1]==pid and win32gui.GetWindowText(h).startswith('OBS '): win32gui.PostMessage(h,win32con.WM_CLOSE,0,0)\nwin32gui.EnumWindows(visit,None)`],{windowsHide:true});
  await Promise.race([obs.closed,sleep(15000)]);const forced=obs.proc.exitCode===null;
  if(forced)obs.proc.kill();await obs.closed;
  const result={pid:obs.proc.pid,forced,exitCode:obs.proc.exitCode,elapsedMs:Date.now()-started};
  fs.writeFileSync(path.join(obs.output,'shutdown.json'),JSON.stringify(result,null,2));
  if(forced||result.exitCode!==0)throw Error('OBS did not shut down cleanly: '+JSON.stringify(result));
}
module.exports={start,receive,stop,Obs};
