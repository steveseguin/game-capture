'use strict';
// Shared actual Qt controls for packaged external-output GUI workflows.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const {waitFor}=require('./macos-media-receiver');
module.exports=function({exe,report,env,launch,api,title,inputLabel}){
  assert(process.env.GC_QA_PRIVATE_DESKTOP&&process.env.DBUS_SESSION_BUS_ADDRESS,'Use linux-private-desktop.py');
  env.QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1';
  const helper=path.join(report,'linux-ui-control.py');
  fs.copyFileSync(path.join(__dirname,'linux-ui-control.py'),helper);
  const settings=path.join(report,'private-gui-settings'),ini=path.join(settings,'VDO.Ninja/Game Capture.ini');
  const labels={whip:'WHIP',rtmp:'RTMP / RTMPS',srt:'SRT (caller)',rtsp:'RTSP / VRChat (TCP)','rtsp-udp':'RTSP (UDP)',udp:'UDP / MPEG-TS (LAN)',rist:'RIST'};
  const secrets={whip:'WHIP bearer token',srt:'SRT passphrase',rtmp:'RTMP stream key'};
  const sensitive=[];let serial=0,configured=false;
  const reference=()=>{const text=fs.readFileSync(ini,'utf8'),value=text.match(/^profilesEncrypted="?@ByteArray\(([A-Za-z0-9+/=]+)\)"?$/m)?.[1];assert(value,'Missing opaque profile reference');const decoded=Buffer.from(value,'base64').toString();assert(/^linux-secret-service-v1:[0-9a-f-]{36}$/.test(decoded));return value;};
  function privacy(){
    const files=[];function visit(dir){if(!fs.existsSync(dir))return;for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())visit(file);else if(item.isFile())files.push(file);}}
    visit(settings);visit(path.join(report,'private-state'));for(const name of fs.readdirSync(report))if(name.startsWith('gui-')&&name.endsWith('.log'))files.push(path.join(report,name));
    for(const file of files){const data=fs.readFileSync(file,'utf8');assert(!sensitive.some(value=>value&&data.includes(value)),'Output credential/URL in plaintext application settings or log');}
  }
  async function open(){
    const discovery=path.join(report,'gui-'+(++serial)+'-control.json');
    const publisher=launch(exe,['--settings-dir='+settings,'--local-control','--local-control-port=0','--local-control-discovery='+discovery],'gui-'+serial);
    await waitFor(()=>{assert.equal(publisher.exitCode,null);return fs.existsSync(discovery);},15000,'No GUI discovery');
    const control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
    const ui=(...args)=>execFileSync('python3',[helper,String(publisher.pid),...args],{env,encoding:'utf8',timeout:12000,stdio:['ignore','pipe','pipe']});
    await waitFor(()=>{try{return JSON.parse(ui('dump')).some(r=>['Go live','Go live unavailable'].includes(r.name));}catch{return false;}},20000,'GUI not accessible');
    assert(!(await api(control,'/diagnostics')).app.capturing,'Restoring settings started capture');
    return {publisher,control,discovery,ui};
  }
  async function quit(session){await api(session.control,'/commands',{command:'quit'});await waitFor(()=>session.publisher.exitCode!==null,10000,'GUI did not quit');assert.equal(await session.publisher.closed,0);assert(!fs.existsSync(session.discovery));privacy();}
  async function start(protocol,url,secret='',streamId=''){
    sensitive.push(url,secret);let session=await open();let {ui}=session;
    if(!configured){
      ui('press','Show advanced settings');ui('choose','Auto (Hardware, then Software)','Software (x264 / VP9 / AV1 / HEVC)');
      ui('choose','1280x720','960x540');ui('choose','60','30');
      ui('choose-prefix','No microphone',inputLabel);
      const current=JSON.parse(ui('dump')).find(r=>r.role==='combo box'&&['Selected window/app audio','No audio'].includes(r.name));assert(current);
      ui('choose',current.name,'Selected microphone/input');configured=true;
    }
    const current=JSON.parse(ui('dump')).find(r=>r.role==='combo box'&&['VDO.Ninja (default)',...Object.values(labels)].includes(r.name));assert(current);
    if(current.name!==labels[protocol])ui('choose',current.name,labels[protocol]);
    ui('text','Output URL',url);if(secrets[protocol])ui('text',secrets[protocol],secret);
    if(protocol==='srt'){ui('text','Stream ID',streamId);ui('value','SRT latency','420');}
    if(protocol!=='whip'){
      const toggle=JSON.parse(ui('dump')).find(r=>r.name==='Audio encoding');assert(toggle);if(!toggle.states.includes('checked'))ui('press','Audio encoding');
      ui('value','AAC bitrate','192');
    }
    const savedReference=reference();await quit(session);
    session=await open();ui=session.ui;
    assert.equal(reference(),savedReference);assert.equal(JSON.parse(ui('read-text','Output URL')),url);
    if(secrets[protocol]){ui('reveal',secrets[protocol]);assert.equal(JSON.parse(ui('read-text',secrets[protocol])),secret);ui('reveal',secrets[protocol]);}
    if(protocol==='srt'){assert.equal(JSON.parse(ui('read-text','Stream ID')),streamId);assert.equal(JSON.parse(ui('dump')).find(r=>r.name==='SRT latency'&&r.role==='spin button').value,420);}
    if(protocol!=='whip')assert.equal(JSON.parse(ui('dump')).find(r=>r.name==='AAC bitrate'&&r.role==='spin button').value,192);
    ui('source',title);ui('press','Go live');await waitFor(async()=>(await api(session.control,'/diagnostics')).app.live,20000,'GUI did not go live');
    privacy();return {...session,profileRestored:true};
  }
  async function stop(session){session.ui('press','Stop streaming');await waitFor(async()=>{const d=await api(session.control,'/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'GUI did not stop');privacy();}
  async function restart(session){session.ui('press','Go live');await waitFor(async()=>(await api(session.control,'/diagnostics')).app.live,20000,'GUI did not restart');}
  return {start,stop,restart,quit,privacy};
};
