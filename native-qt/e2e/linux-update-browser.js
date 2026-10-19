#!/usr/bin/env node
'use strict';
// Packaged Releases link -> unchanged system launcher -> real private browser.
// Only the private update cache is seeded; no API or browser navigation injection.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process');
const {verify}=require('./linux-room-fixture'),ownedBrowser=require('./linux-owned-browser');
const {waitFor,sleep}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');assert(i>2);return[a.slice(2,i),a.slice(i+1)];}));
const artifact=verify({...opts,gui:'true'}),backend=opts.backend||'x11';
const env={...process.env};
assert(env.GC_QA_PRIVATE_DESKTOP||env.GC_QA_WAYLAND_DESKTOP);
assert.equal(env.QT_QPA_PLATFORM,backend==='wayland'?'wayland':'xcb');
if(backend==='wayland')assert(env.GC_QA_OWNED_WAYLAND&&env.GC_QA_KEYBOARD_SOCKET,'Require owned compositor/input');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const releases='https://github.com/steveseguin/game-capture/releases';
const result={passed:false,artifact,backend,cases:[],harnesses:{},scope:'Packaged Linux GUI with seeded compatible future-release cache. Actual keyboard/mouse link activation, unchanged QDesktopServices/system desktop launcher, private MIME association and real Chrome profile. Browser receives fixed Releases URL and loads public GitHub release content. No installer download or publication, no cold compatible-release network qualification.'};
for(const name of ['linux-update-browser.js','linux-owned-browser.js','linux-room-fixture.js','linux-ui-control.py','linux-portal-select.py','macos-media-receiver.js']){
  fs.copyFileSync(path.join(__dirname,name),path.join(report,name));result.harnesses[name]=sha(path.join(report,name));
}
const settings=path.join(report,'private-settings');fs.mkdirSync(settings);
const cache=path.join(settings,'update-check.ini'),discovery=path.join(report,'private-control.json');
const architecture=JSON.parse(fs.readFileSync(path.resolve(path.dirname(artifact.exe),'../../release-artifact-manifest.json'))).architecture;
assert(['amd64','arm64'].includes(architecture));
const name=`game-capture-99.0.0~linux.2-${architecture}-0123456789ab-abcdef012345.deb`;
const metadata={tag_name:'v99.0.0',draft:false,prerelease:false,assets:[{name,size:1000,state:'uploaded',
  browser_download_url:'https://github.com/steveseguin/game-capture/releases/download/v99.0.0/'+name}]};
const now=Math.floor(Date.now()/1000);
fs.writeFileSync(cache,`[General]\nLastAttempt=${now}\nLastSuccess=${now}\nLastAttemptSucceeded=true\nRelease=${JSON.stringify('@ByteArray('+JSON.stringify(metadata)+')')}\n`);
const originalCacheSha=sha(cache);
let browser,publisher,control;
const checkpoint=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
function ui(...args){return execFileSync('python3',[path.join(report,'linux-ui-control.py'),String(publisher.pid),...args],
  {env,encoding:'utf8',timeout:90000,stdio:['ignore','pipe','pipe']});}
async function diagnostics(){
  const response=await fetch(control.base_url+'/diagnostics',{headers:{Authorization:'Bearer '+control.token},signal:AbortSignal.timeout(5000)});
  assert(response.ok);const d=await response.json();
  assert(!d.app.live&&!d.app.capturing&&!d.source.has_frame);
  assert.equal(d.video.frames_sent,0);assert.equal(d.metrics.audio_packets_sent,0);
  return {live:d.app.live,capturing:d.app.capturing,framesSent:d.video.frames_sent,audioPacketsSent:d.metrics.audio_packets_sent};
}
async function launch(label){
  const log=fs.createWriteStream(path.join(report,label+'-publisher.log'));
  publisher=spawn(artifact.exe,['--settings-dir='+settings,'--local-control','--local-control-port=0','--local-control-discovery='+discovery],
    {env,cwd:report,stdio:['ignore','pipe','pipe']});
  publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});
  publisher.closed=new Promise(resolve=>publisher.once('close',code=>log.end(()=>resolve(code))));
  await waitFor(()=>{assert.equal(publisher.exitCode,null);return fs.existsSync(discovery);},15000,'No app discovery');
  control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
  ui('activate');
  await waitFor(()=>JSON.parse(ui('dump')).some(r=>r.name==='New version available: v99.0.0'),15000,'No compatible-release footer');
}
async function stop(){
  ui('activate');ui('quit-menu');await waitFor(()=>publisher.exitCode!==null,10000,'File-menu Quit failed');
  assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery));publisher=null;
}
(async()=>{console.log('Report: '+report);try{
  browser=await ownedBrowser.create(env,report,{purpose:'releases'});result.browser=browser.evidence;
  const modes=opts.input?[opts.input]:(backend==='x11'?['keyboard','mouse']:['keyboard']);
  assert(modes.every(mode=>['keyboard','mouse'].includes(mode)));
  assert(backend==='x11'||!modes.includes('mouse'));
  for(const [index,mode] of modes.entries()){
    await launch(mode);
    const entry={input:mode,passed:false};result.cases.push(entry);checkpoint();
    ui('activate');
    entry.footer=JSON.parse(ui('footer','New version available: v99.0.0'));
    entry.before=await diagnostics();
    fs.writeFileSync(path.join(report,mode+'-ui.json'),ui('dump'));
    entry.activation=JSON.parse(ui('release-link',mode));
    if(backend==='x11')execFileSync('python3',['-c','from PIL import ImageGrab; import sys; ImageGrab.grab().save(sys.argv[1])',path.join(report,mode+'-activated.png')],{env,timeout:5000});
    const page=await browser.opened(releases,index);
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('a[href]')).some(a=>/\/steveseguin\/game-capture\/releases\/tag\//i.test(a.getAttribute('href'))),null,{timeout:30000});
    entry.browserPage=await page.evaluate(()=>({url:location.href,title:document.title,
      releaseLinks:Array.from(document.querySelectorAll('a[href]')).map(a=>({href:a.getAttribute('href'),text:a.textContent.trim()}))
        .filter(a=>/\/steveseguin\/game-capture\/releases\/tag\//i.test(a.href)).slice(0,12)}));
    assert.equal(entry.browserPage.url.toLowerCase(),releases);
    assert(entry.browserPage.releaseLinks.length>0);
    await page.screenshot({path:path.join(report,mode+'-browser.png')});
    entry.after=await diagnostics();assert.equal(sha(cache),originalCacheSha);
    entry.fixedUrlReceived=true;entry.cacheUnchanged=true;
    await page.close();await browser.release();
    await stop();entry.quitNormally=true;entry.passed=true;checkpoint();
  }
  result.passed=true;
}catch(e){result.error=String(e.stack||e);process.exitCode=1;
  if(publisher&&publisher.exitCode===null){try{fs.writeFileSync(path.join(report,'failure-ui.json'),ui('dump'));}catch{}}
}finally{
  try{
    if(publisher&&publisher.exitCode===null&&!publisher.signalCode){
      publisher.kill('SIGTERM');await Promise.race([publisher.closed,sleep(5000)]);
      if(publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGKILL');await publisher.closed;}
      result.forcedPublisherCleanup=true;
    }
    if(browser)await browser.close();
    result.privateAssociationRemoved=!fs.existsSync(path.join(env.XDG_CONFIG_HOME,'mimeapps.list'))&&!fs.existsSync(path.join(env.XDG_DATA_HOME,'applications'));
    assert(result.privateAssociationRemoved);
  }catch(e){result.cleanupError=String(e.stack||e);result.passed=false;process.exitCode=1;}
  checkpoint();console.log(JSON.stringify({report,passed:result.passed,error:result.error||result.cleanupError}));
}})();
