#!/usr/bin/env node
'use strict';
// Packaged macOS close-to-menu-bar and Launch Services reopen, with isolated settings.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process');
const {sleep,waitFor}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');for(const key of ['app','ui-helper','reports'])assert(opts[key],'Missing --'+key);
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture'),helper=path.resolve(opts['ui-helper']);
const closeQuits=opts['close-quits']==='true';
assert(!opts['close-quits']||['true','false'].includes(opts['close-quits']));
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={scope:'Packaged idle main-window native close and Launch Services reopen; menu-bar mode; live media excluded',
  closeQuits,executableSha256:hash(exe),helperSha256:hash(helper),harnessSha256:hash(__filename),cycles:[],passed:false};
for(const name of ['macos-window-reopen.js','macos-ui-control.mm','macos-media-receiver.js'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
const discovery=path.join(report,'control.json'),settings=path.join(report,'settings');
fs.mkdirSync(path.join(settings,'VDO.Ninja'),{recursive:true});
fs.writeFileSync(path.join(settings,'VDO.Ninja/Game Capture.ini'),`[ui]\nminimizeToTrayOnClose=${!closeQuits}\n`);
const args=['--settings-dir='+settings,'--local-control','--local-control-port=0','--local-control-discovery='+discovery];
const log=fs.createWriteStream(path.join(report,'publisher.log'));
let publisher,control;
async function api(route,body){const response=await fetch(control.base_url+route,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,
  signal:AbortSignal.timeout(5000)});assert(response.ok);return response.json();}
const ui=(action,name)=>execFileSync(helper,[String(publisher.pid),action,...(name?[name]:[])],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
function visibleWindow(){try{return Number(ui('window').trim());}catch(error){if(error.status===3)return null;throw error;}}
function publisherPids(){return execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{
  const match=line.trim().match(/^(\d+)\s+(.+)$/);return match && match[2].endsWith('/Game Capture.app/Contents/MacOS/game-capture')?[Number(match[1])]:[];
});}
(async()=>{console.log('Reports: '+report);try{
  assert.equal(publisherPids().length,0,'Another publisher is running; do not redirect its Launch Services reopen');
  publisher=spawn(exe,args,{cwd:report,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k))),stdio:['ignore','pipe','pipe']});
  publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});
  publisher.closed=new Promise(resolve=>publisher.once('close',(code,signal)=>resolve({code,signal})));
  await waitFor(()=>{assert.equal(publisher.exitCode,null);return fs.existsSync(discovery);},15000,'Local control unavailable');
  control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);result.pid=publisher.pid;
  await waitFor(()=>!!visibleWindow(),10000,'Main window unavailable');
  for(let index=0;index<3;index++){
    const cycle={index,passed:false};result.cycles.push(cycle);
    cycle.beforeWindow=visibleWindow();assert(cycle.beforeWindow);
    const before=JSON.parse(ui('dump'));fs.writeFileSync(path.join(report,`before-${index}.json`),JSON.stringify(before,null,2));
    const main=before.find(r=>r.AXRole==='AXWindow'&&String(r.AXTitle).startsWith('Game Capture -'));
    assert(main,'Main native window not found');
    ui('close-window',main.AXTitle);
    if(closeQuits){
      await waitFor(()=>publisher.exitCode!==null,10000,'Close-to-quit preference did not exit');
      result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,0);assert(!fs.existsSync(discovery));
      cycle.passed=true;result.passed=true;return;
    }
    await waitFor(()=>!visibleWindow(),5000,'Native close did not hide the main window');
    assert.equal(publisher.exitCode,null);cycle.hiddenDiagnostics=await api('/diagnostics');assert.equal(cycle.hiddenDiagnostics.app.live,false);
    cycle.hiddenUi=JSON.parse(ui('dump'));assert(cycle.hiddenUi.some(r=>r.AXRole==='AXMenuItem'&&r.AXTitle==='Show'));
    assert.deepEqual(publisherPids(),[publisher.pid]);save();
    const start=Date.now();
    // Same application-opening request used by Finder; arguments preserve
    // isolation even if the OS unexpectedly starts another instance.
    execFileSync('/usr/bin/open',['-a',app,'--args',...args],{timeout:10000,stdio:'pipe'});
    await waitFor(()=>!!visibleWindow(),5000,'macOS reopen did not restore the main window');
    cycle.reopenMs=Date.now()-start;cycle.afterWindow=visibleWindow();
    assert.deepEqual(publisherPids(),[publisher.pid],'Reopen launched a second publisher');
    assert.equal(JSON.parse(fs.readFileSync(discovery)).pid,publisher.pid);
    cycle.passed=true;save();
  }
  ui('press','Quit Game Capture');
  await waitFor(()=>publisher.exitCode!==null,10000,'Native app-menu Quit did not exit');
  result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,0);assert(!fs.existsSync(discovery));result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
  if(publisher?.exitCode===null)try{fs.writeFileSync(path.join(report,'failed-ui.json'),ui('dump'));}catch{}
}finally{
  if(publisher?.exitCode===null){
    if(control)await api('/commands',{command:'quit'}).catch(()=>{});
    await Promise.race([publisher.closed,sleep(3000)]);
    if(publisher.exitCode===null&&!publisher.signalCode)publisher.kill('SIGTERM');
    await publisher.closed;
  }
  log.end();save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
