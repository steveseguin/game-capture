#!/usr/bin/env node
'use strict';
// Real packaged GUI stop/start cycles in the same process, with decoded output.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,spawnSync,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiver,observeDecoded,requireMoving}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');assert(opts.app&&opts.reports&&opts['ui-helper'],'Use --app, --reports and --ui-helper');
const cycles=Number(opts.cycles||10);assert(Number.isInteger(cycles)&&cycles>=1&&cycles<=20);
const encoders=opts.encoder?[opts.encoder]:['videotoolbox','x264'];assert(encoders.every(e=>['videotoolbox','x264','software','auto'].includes(e)));
const codec=opts.codec||'h264';assert(['h264','h265','vp9','av1'].includes(codec));
const expectRefusal=opts['expect-refusal']==='true';
const savedOptions=opts['ffmpeg-options']||'';assert(!/[\r\n]/.test(savedOptions));
const savedAlpha=opts['saved-alpha']==='true';
const sourceSelection=opts['source-selection']||'mouse';assert(['mouse','accessibility'].includes(sourceSelection));
const windowReopen=opts['window-reopen']==='true';
assert(!opts['window-reopen']||['true','false'].includes(opts['window-reopen']));
assert(!expectRefusal||((codec==='h265'&&encoders.every(e=>e==='x264'))||(['vp9','av1'].includes(codec)&&encoders.every(e=>e==='videotoolbox'))),'Refusal workflow requires HEVC/x264 or VP9/AV1 with VideoToolbox');
assert(codec!=='h265'||expectRefusal||encoders.every(e=>e==='videotoolbox'||e==='auto'),'HEVC requires --encoder=videotoolbox or auto');
assert(!['vp9','av1'].includes(codec)||expectRefusal||encoders.every(e=>e==='software'||e==='auto'),'VP9/AV1 requires --encoder=software or auto');
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture'),helper=path.resolve(opts['ui-helper']);
assert(fs.existsSync(path.join(app,'Contents/Frameworks')),'Use the deployed app');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Same-process packaged GUI window start/stop with decoded video; no audio/device, timing or Windows qualification',
  codec,cycles,expectRefusal,sourceSelection,savedOptions,savedAlpha,windowReopen,executableSha256:hash(exe),harnessSha256:hash(__filename),helperSha256:hash(helper),
  receiverHarnessSha256:hash(path.join(__dirname,'macos-media-receiver.js')),cases:[],passed:false};
for(const name of ['macos-gui-lifecycle.js','macos-media-receiver.js','macos-ui-control.mm'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
const children=new Set(),browsers=new Set();
async function api(control,route,body){
  const response=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(response.ok,'Local control HTTP '+response.status);return response.json();
}
const ownedHelpers=pid=>execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{
  const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  return match&&Number(match[2])===pid&&path.basename(match[3])==='ffmpeg'?[Number(match[1])]:[];
});
const isAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const rss=pid=>Number(execFileSync('/bin/ps',['-o','rss=','-p',String(pid)],{encoding:'utf8'}).trim());
(async()=>{console.log('Reports: '+report);try{
  result.sessionState=JSON.parse(execFileSync(helper,[String(process.pid),'session-state'],{encoding:'utf8',timeout:10000}));
  assert.equal(result.sessionState.screenLocked,false,'Unlock the Mac before running native GUI workflows');
  const sourceBrowser=await chromium.launch({headless:false,args:['--window-position=80,80','--disable-background-timer-throttling','--disable-renderer-backgrounding']});browsers.add(sourceBrowser);
  const source=await sourceBrowser.newPage({viewport:{width:960,height:540},deviceScaleFactor:1});
  const title='Mac GUI Lifecycle '+crypto.randomBytes(8).toString('hex');
  await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style><canvas></canvas><script>
    const c=document.querySelector('canvas'),x=c.getContext('2d');let id=0;
    function draw(){c.width=innerWidth;c.height=innerHeight;const w=c.width,h=c.height;id=(id+1)%65536;
      x.fillStyle='#183042';x.fillRect(0,0,w,h);x.fillStyle='#00ffff';x.fillRect(.1*w,.25*h,.05*w,.5*h);
      x.fillStyle='#ff00ff';x.fillRect(.85*w,.25*h,.05*w,.5*h);
      for(let i=0;i<16;i++){x.fillStyle=(id>>i)&1?'white':'black';x.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
      requestAnimationFrame(draw);}draw();</script>`);
  await source.bringToFront();await sleep(1000);
  const viewerBrowser=await chromium.launch({headless:true,...(opts['receiver-executable']?{executablePath:path.resolve(opts['receiver-executable'])}:{}),args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});browsers.add(viewerBrowser);
  result.browserVersions={source:sourceBrowser.version(),receiver:viewerBrowser.version()};
  for(const encoder of encoders){
    const entry={encoder,cycles:[],passed:false};result.cases.push(entry);
    const settings=path.join(report,encoder,'settings'),org=path.join(settings,'VDO.Ninja');fs.mkdirSync(org,{recursive:true});
    fs.writeFileSync(path.join(org,'Game Capture.ini'),`[video]\nsourceMode=window\ncodec=${codec}\nffmpegOptions=${savedOptions}\nalphaWorkflow=${savedAlpha}\nencoderMode=${encoder==='x264'?'software':encoder}\nresolution=960x540\nfps=30\nbitratePresetKbps=4000\n[audio]\nsource=none\nwindowSource=none\nincludeMicrophone=false\nmicrophoneDeviceId=none\n`);
    const discovery=path.join(report,encoder,'control.json'),stream='macgui'+crypto.randomBytes(12).toString('hex');
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
    const child=spawn(exe,[`--settings-dir=${settings}`,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],{cwd:report,env,stdio:['ignore','pipe','pipe']});children.add(child);
    const log=fs.createWriteStream(path.join(report,encoder,'publisher.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
    child.closed=new Promise(resolve=>{child.once('close',code=>{children.delete(child);log.end();resolve(code);});child.once('error',e=>{entry.launchError=String(e);});});
    entry.pid=child.pid;
    await waitFor(()=>{assert(child.exitCode===null&&!child.signalCode,'Publisher exited');return fs.existsSync(discovery);},15000,'No local control');
    const control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,child.pid);
    const ui=(action,name,value)=>execFileSync(helper,[String(child.pid),action,...(name?[name]:[]),...(value===undefined?[]:[value])],{encoding:'utf8',timeout:10000});
    const button=()=>JSON.parse(ui('dump')).find(r=>String(r.AXIdentifier||'').endsWith('.goLiveButton'));
    const ready=()=>{const b=button();return b&&b.AXEnabled===true&&b.AXTitle==='Go live';};
    // Enumeration/preview work is asynchronous. Wait for the owned fixture in
    // both discovery and the actual accessible list instead of a fixed delay.
    await waitFor(async()=>{
      const windows=await api(control,'/sources/windows');
      return windows.sources.some(w=>w.name.includes(title));
    },15000,'Owned fixture did not appear in window discovery');
    entry.activationAttempts=0;
    if(sourceSelection==='mouse') await waitFor(()=>{
        ++entry.activationAttempts;
        return spawnSync(helper,[String(child.pid),'activate'],{timeout:5000,encoding:'utf8'}).status===0;
      },10000,'Target GUI did not become frontmost');
    // Local control/window enumeration can be ready before the native UI tree.
    // Wait for the actual control before issuing a single refresh action.
    await waitFor(()=>JSON.parse(ui('dump')).some(r=>String(r.AXIdentifier||'').endsWith('.refreshSourcesButton')&&r.AXEnabled),
      15000,'Source refresh control did not become accessible');
    ui('press','refreshSourcesButton');
    ui('set','sourceFilterInput',title);
    await waitFor(()=>JSON.parse(ui('dump')).some(r=>Object.values(r).some(v=>typeof v==='string'&&v.includes(title))),
      15000,'Owned fixture did not appear in the accessible source list');
    ui(sourceSelection==='mouse'?'click':'select-source',title);ui('verify-selected',title);
    ui('set','sourceFilterInput','No matching source '+crypto.randomBytes(8).toString('hex'));
    assert.equal(button()?.AXEnabled,false,'Filtering out the selected source must disable Go Live');
    const emptyList=JSON.parse(ui('dump')).find(r=>r.AXRole==='AXList'&&r.AXTitle==='Available capture sources');
    assert(String(emptyList?.AXDescription).includes('No capture sources match the filter'),'Empty source list lacks an accessible explanation');
    entry.emptySourceDescription=emptyList.AXDescription;
    // A different case must find the same source; restoring the filter alone
    // must not silently restore a selection that the user filtered away.
    ui('set','sourceFilterInput',title.toUpperCase());
    assert.equal(button()?.AXEnabled,false,'Cleared selection was silently restored');
    ui(sourceSelection==='mouse'?'click':'select-source',title);ui('verify-selected',title);
    entry.sourceFilterClearsSelection=true;entry.sourceFilterCaseInsensitive=true;
    ui('set','streamIdInput',stream);ui('set','passwordInput','false');
    if(opts['check-codec-controls']==='true') {
      let rows=JSON.parse(ui('dump'));
      const advanced=rows.find(r=>String(r.AXIdentifier||'').endsWith('.advancedToggle'));
      assert(advanced,'Advanced checkbox missing');if(!Number(advanced.AXValue))ui('press','advancedToggle');
      await waitFor(()=>{
        rows=JSON.parse(ui('dump'));
        const fields=rows.filter(r=>/\.(ffmpegPathInput|ffmpegOptionsInput|ffmpegStatusLabel|alphaWorkflowCheck)$/.test(r.AXIdentifier||''));
        entry.codecControls=fields;
        const alpha=fields.find(r=>String(r.AXIdentifier).endsWith('.alphaWorkflowCheck'));
        assert.equal(!!alpha,!['h265','av1'].includes(codec),'Alpha availability differs from the selected Mac codec');
        if(alpha)assert.equal(alpha.AXEnabled,true);
        if(!['vp9','av1'].includes(codec)&&!savedAlpha)return fields.filter(r=>r!==alpha).length===0;
        if(codec==='h265')return fields.length===0;
        const find=name=>fields.find(r=>String(r.AXIdentifier).endsWith('.'+name));
        return find('ffmpegPathInput')?.AXEnabled===true&&(!['vp9','av1'].includes(codec)||find('ffmpegOptionsInput')?.AXEnabled===true)&&
          JSON.stringify(find('ffmpegStatusLabel')||{}).includes(codec==='av1'?'libaom-av1 available':'libvpx-vp9 available');
      },10000,'Codec helper controls did not match the selected Mac codec');
    }
    if(expectRefusal){
      await waitFor(ready,10000,'Go Live button did not become ready');ui('press','goLiveButton');
      const expected=['vp9','av1'].includes(codec)?codec.toUpperCase()+' requires software encoding. Select Software or Auto.':'H.265 requires Apple VideoToolbox. Select Apple VideoToolbox or use H.264 with x264.';
      await waitFor(()=>{
        const rows=JSON.parse(ui('dump')).filter(r=>String(r.AXIdentifier||'').endsWith('.statusLabel'));
        entry.refusalStatus=rows;return rows.some(r=>Object.values(r).includes(expected));
      },5000,'GUI did not explain unsupported codec/encoder combination');
      await sleep(500);entry.refusalDiagnostics=await api(control,'/diagnostics');
      assert(!entry.refusalDiagnostics.app.live&&!entry.refusalDiagnostics.app.capturing&&!entry.refusalDiagnostics.source.has_frame);
      assert.equal(entry.refusalDiagnostics.video.frames_sent,0);assert(ready(),'Go Live did not remain usable after refusal');
      save();console.log(encoder+': unsupported codec selection refused without starting capture');
    }
    for(let index=1;!expectRefusal&&index<=cycles;index++){
      const cycle={index,pid:child.pid,passed:false};entry.cycles.push(cycle);
      await waitFor(ready,10000,'Go Live button did not become ready');
      const start=Date.now();ui('press','goLiveButton');
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.app.live&&d.app.capturing&&d.source.has_frame;},30000,'GUI publisher did not start');
      cycle.startMs=Date.now()-start;
      const page=await receiver(viewerBrowser,stream,child);cycle.video=await observeDecoded(page,4000);requireMoving(cycle.video,encoder+' restart '+index,'video/'+codec);
      assert.equal(cycle.video.width,960);assert.equal(cycle.video.height,540);
      cycle.liveDiagnostics=await api(control,'/diagnostics');
      assert.equal(cycle.liveDiagnostics.video.hardware_encoder,!['vp9','av1'].includes(codec)&&!['x264','software'].includes(encoder));
      assert.equal(cycle.liveDiagnostics.video.active_codec,codec==='av1'?'AV1':codec==='vp9'?'VP9':codec==='h265'?'H.265':'H.264');
      assert.equal(cycle.liveDiagnostics.video.alpha_enabled,savedAlpha&&!['h265','av1'].includes(codec),'Alpha setting differs from supported codec selection');
      assert.equal(cycle.liveDiagnostics.video.encode_failures,0);assert.equal(cycle.liveDiagnostics.video.encode_timeouts,0);
      assert.equal(cycle.liveDiagnostics.metrics.audio_packets_sent,0,'Video-only workflow sent audio');
      cycle.encoderHelperPids=ownedHelpers(child.pid);
      const helperCount=(['vp9','av1'].includes(codec)?1:0)+(savedAlpha&&!['h265','av1'].includes(codec)?1:0);
      assert.equal(cycle.encoderHelperPids.length,helperCount,'Unexpected primary/mask FFmpeg worker ownership');
      cycle.liveRssKiB=rss(child.pid);await page.screenshot({path:path.join(report,encoder,`cycle-${index}.png`)});
      if(windowReopen) {
        const reopen=cycle.reopen={passed:false};
        const visible=()=>{try{return Number(ui('window').trim());}catch(error){if(error.status===3)return null;throw error;}};
        const publisherPids=()=>execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{
          const match=line.trim().match(/^(\d+)\s+(.+)$/);return match&&match[2].endsWith('/Game Capture.app/Contents/MacOS/game-capture')?[Number(match[1])]:[];
        });
        assert.deepEqual(publisherPids(),[child.pid],'Another publisher could receive the reopen request');
        const window=JSON.parse(ui('dump')).find(r=>r.AXRole==='AXWindow'&&String(r.AXTitle).startsWith('Game Capture -'));
        assert(window);reopen.beforeWindow=visible();assert(reopen.beforeWindow);
        ui('close-window',window.AXTitle);await waitFor(()=>!visible(),5000,'Native close did not hide the live publisher');
        await source.bringToFront();
        reopen.hiddenVideo=await observeDecoded(page,3000);requireMoving(reopen.hiddenVideo,'Hidden publisher','video/'+codec);
        reopen.hiddenDiagnostics=await api(control,'/diagnostics');assert(reopen.hiddenDiagnostics.app.live&&reopen.hiddenDiagnostics.app.capturing);
        assert.deepEqual(ownedHelpers(child.pid),cycle.encoderHelperPids,'Hiding restarted encoder workers');
        const start=Date.now();
        execFileSync('/usr/bin/open',['-a',app,'--args',`--settings-dir=${settings}`,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],{timeout:10000,stdio:'pipe'});
        await waitFor(()=>!!visible(),5000,'macOS reopen did not restore the live publisher');
        reopen.reopenMs=Date.now()-start;reopen.afterWindow=visible();assert.deepEqual(publisherPids(),[child.pid]);
        assert.equal(JSON.parse(fs.readFileSync(discovery)).pid,child.pid);ui('verify-selected',title);
        // Keep the generated source drawing; covered-window behavior is a separate workflow.
        await source.bringToFront();
        reopen.restoredVideo=await observeDecoded(page,3000);requireMoving(reopen.restoredVideo,'Reopened publisher','video/'+codec);
        reopen.restoredDiagnostics=await api(control,'/diagnostics');assert(reopen.restoredDiagnostics.app.live&&reopen.restoredDiagnostics.app.capturing);
        assert.equal(reopen.restoredDiagnostics.source.source_id,cycle.liveDiagnostics.source.source_id);
        assert.deepEqual(ownedHelpers(child.pid),cycle.encoderHelperPids,'Reopening restarted encoder workers');
        for(const key of ['encode_failures','encode_timeouts','send_failures','alpha_encode_failures','alpha_send_failures'])assert.equal(reopen.restoredDiagnostics.video[key],0);
        reopen.passed=true;save();
      }
      const stop=Date.now();ui('press','goLiveButton');
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing&&ready();},10000,'GUI publisher did not stop and re-enable Go Live');
      cycle.stopMs=Date.now()-stop;assert(cycle.stopMs<5000,'Normal GUI stop exceeded five seconds');
      const stopped=await api(control,'/diagnostics');await sleep(500);cycle.stoppedDiagnostics=await api(control,'/diagnostics');
      for(const key of ['frames_captured','frames_sent']){assert(Number.isFinite(stopped.video[key]));assert.equal(cycle.stoppedDiagnostics.video[key],stopped.video[key],'Video advanced after GUI stop');}
      assert.equal(cycle.stoppedDiagnostics.metrics.audio_packets_sent,stopped.metrics.audio_packets_sent);
      if(cycle.encoderHelperPids.length) {
        await waitFor(()=>cycle.encoderHelperPids.every(pid=>!isAlive(pid)),3000,'VP9 helper survived GUI stop');
        assert.equal(ownedHelpers(child.pid).length,0,'Stopped GUI still owns an FFmpeg worker');
        cycle.encoderHelpersReaped=true;
      }
      cycle.stoppedRssKiB=rss(child.pid);cycle.readyButton=button();assert.equal(child.exitCode,null,'GUI exited during stop');
      await page.close();cycle.passed=true;save();console.log(`${encoder}: GUI cycle ${index}/${cycles} passed in PID ${child.pid}`);
    }
    const quit=Date.now();await api(control,'/commands',{command:'quit'});await waitFor(()=>child.exitCode!==null,10000,'GUI did not quit');
    assert.equal(await child.closed,0);entry.quitMs=Date.now()-quit;assert(entry.quitMs<5000);assert(!fs.existsSync(discovery));entry.passed=true;save();
  }
  result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
}finally{
  for(const child of children)child.kill('SIGTERM');
  for(const browser of browsers)await browser.close().catch(()=>{});
  await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
  save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
