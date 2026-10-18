'use strict';
// Native GNOME fixture for the common Linux A/V workflow. The source gets a
// temporary monitor large enough for a real 1280x720 client area, with normal
// keyboard movement and the real screen-sharing picker.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process');
const {waitFor,sleep}=require('./macos-media-receiver');
async function create(env,report){
  assert(env.GC_QA_WAYLAND_DESKTOP&&env.QT_QPA_PLATFORM==='wayland');
  const evidence={scope:'Owned native GNOME monitor, disposable source browser and real portal consent; no persistent monitor configuration.',passed:false};
  let keyboard,directory,monitor,selector,closed=false,portalGranted=false;
  const helper=name=>path.join(report,name);
  const owner=()=>execFileSync('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.GetNameOwner','org.freedesktop.impl.portal.desktop.gnome'],{env,encoding:'utf8',timeout:5000}).trim();
  const launch=(command,args,name,stdin='pipe')=>{
    const output=fs.createWriteStream(path.join(report,name+'.log'));
    const child=spawn(command,args,{env,stdio:[stdin,'pipe','pipe']});child.launchError=null;child.on('error',e=>child.launchError=String(e));
    child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});child.closed=new Promise(resolve=>child.once('close',code=>output.end(()=>resolve(code))));return child;
  };
  async function close(){
    if(closed)return;closed=true;const errors=[];
    if(selector&&selector.exitCode===null)try{selector.kill();await selector.closed;}catch(e){errors.push(String(e));}
    if(keyboard)try{keyboard.stdin.end();await waitFor(()=>keyboard.exitCode!==null,10000,'Keyboard did not retire');assert.equal(await keyboard.closed,0);}catch(e){errors.push(String(e));}
    if(directory)try{fs.rmdirSync(directory);}catch(e){errors.push(String(e));}
    if(monitor)try{monitor.stdin.end();await waitFor(()=>monitor.exitCode!==null,12000,'Virtual monitor did not retire');assert.equal(await monitor.closed,0);evidence.monitor=JSON.parse(fs.readFileSync(helper('virtual-monitor.json')));assert(evidence.monitor.passed&&evidence.monitor.layoutRestored);}catch(e){errors.push(String(e));}
    try{assert.equal(owner(),evidence.portalOwner);evidence.portalSurvived=true;}catch(e){errors.push(String(e));}
    evidence.passed=errors.length===0&&!evidence.error;if(errors.length)evidence.cleanupErrors=errors;
    fs.writeFileSync(helper('wayland-av-fixture.json'),JSON.stringify(evidence,null,2)+'\n');assert.equal(errors.length,0,errors.join('\n'));
  }
  try{
    evidence.portalOwner=owner();directory=fs.mkdtempSync(path.join(os.tmpdir(),'gc-wayland-keys-av-'));fs.chmodSync(directory,0o700);env.GC_QA_KEYBOARD_SOCKET=path.join(directory,'input.sock');
    keyboard=launch('sudo',['-n','python3',helper('linux-portal-select.py'),'--keyboard-server='+env.GC_QA_KEYBOARD_SOCKET],'keyboard');let ready='';keyboard.stdout.on('data',d=>ready+=d);
    await waitFor(()=>{assert(!keyboard.launchError,keyboard.launchError);assert.equal(keyboard.exitCode,null);return ready.includes('ready');},10000,'Keyboard not ready');
    monitor=launch('python3',[helper('linux-virtual-monitor.py'),'--report='+report,'--width=1440','--height=1000'],'virtual-monitor');let display='';monitor.stdout.on('data',d=>display+=d);
    await waitFor(()=>{assert(!monitor.launchError,monitor.launchError);assert.equal(monitor.exitCode,null);return display.includes('"ready": true');},15000,'Virtual monitor not ready');
    evidence.monitorReady=JSON.parse(display.trim().split('\n').find(line=>line.includes('"ready": true')));
    return {
      evidence,close,
      async placeSource(page,pid,title){
        await page.bringToFront();
        const client=await page.context().newCDPSession(page),{windowId}=await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});await sleep(300);
        evidence.sourceNormalWindow=(await client.send('Browser.getWindowBounds',{windowId})).bounds;
        evidence.sourcePlacement=JSON.parse(execFileSync('python3',[helper('linux-source-monitor.py'),'--pid='+pid,'--title='+title],{env,encoding:'utf8',timeout:20000}));
        evidence.sourceMovedWindow=(await client.send('Browser.getWindowBounds',{windowId})).bounds;
        for(let n=0;n<4;n++){
          const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));if(size.width===1280&&size.height===720)break;
          const {bounds}=await client.send('Browser.getWindowBounds',{windowId});
          await client.send('Browser.setWindowBounds',{windowId,bounds:{width:bounds.width+1280-size.width,height:bounds.height+720-size.height}});await sleep(300);
        }
        evidence.sourceSize=await page.evaluate(()=>({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,devicePixelRatio}));
        const snapshot=name=>execFileSync('gst-launch-1.0',['-q','pipewiresrc','path='+evidence.monitorReady.node,'!','video/x-raw,width=1440,height=1000,format=BGRx,framerate=0/1','!','videoconvert','!','pngenc','snapshot=true','!','filesink','location='+helper(name)],{env,encoding:'utf8',timeout:10000});
        assert.equal(evidence.sourceSize.width,1280);assert.equal(evidence.sourceSize.height,720);assert.equal(evidence.sourceSize.devicePixelRatio,1);
        snapshot('owned-monitor-before-fit.png');
        evidence.sourceFit=JSON.parse(execFileSync('python3',[helper('linux-source-monitor.py'),'--pid='+pid,'--title='+title,'--fit-image='+helper('owned-monitor-before-fit.png')],{env,encoding:'utf8',timeout:45000}));
        snapshot('owned-monitor-source.png');
        evidence.sourceVisibility=JSON.parse(execFileSync('python3',[helper('linux-source-monitor.py'),'--pid='+pid,'--title='+title,'--verify-image='+helper('owned-monitor-source.png')],{env,encoding:'utf8',timeout:20000}));assert(evidence.sourceVisibility.passed);
        evidence.sourceWindow=(await client.send('Browser.getWindowBounds',{windowId})).bounds;await client.detach();
      },
      selectPortal(title){
        assert(!selector);evidence.portalTitle=title;
        selector=launch('python3',[helper('linux-portal-select.py'),'--title='+title,'--output='+helper('portal-selection.json')],'portal-selection','ignore');
      },
      async selectedPortal(){
        assert(selector);await waitFor(()=>{assert(!selector.launchError,selector.launchError);return selector.exitCode!==null;},30000,'Portal selection did not complete');
        assert.equal(await selector.closed,0);evidence.selection=JSON.parse(fs.readFileSync(helper('portal-selection.json')));assert(evidence.selection.passed);portalGranted=true;assert.equal(owner(),evidence.portalOwner);
      },
      async cancelPendingPortal(){
        if(!selector||portalGranted)return;
        if(selector.exitCode===null){selector.kill();await selector.closed;}
        // A completed click can race a failed observation. Preserve that grant;
        // otherwise use the real owned picker before the app closes its request.
        const selection=helper('portal-selection.json');
        if(fs.existsSync(selection)&&JSON.parse(fs.readFileSync(selection)).passed){portalGranted=true;return;}
        execFileSync('python3',[helper('linux-portal-select.py'),'--title='+evidence.portalTitle,'--cancel','--output='+helper('portal-cleanup-cancel.json')],{env,encoding:'utf8',timeout:30000});
        evidence.cancelledPendingPortal=JSON.parse(fs.readFileSync(helper('portal-cleanup-cancel.json')));assert(evidence.cancelledPendingPortal.passed);
        execFileSync('python3',[helper('linux-portal-select.py'),'--title='+evidence.portalTitle,'--observe=closed','--output='+helper('portal-cleanup-closed.json')],{env,encoding:'utf8',timeout:15000});
        assert.equal(owner(),evidence.portalOwner);
      }
    };
  }catch(error){evidence.error=String(error.stack||error);try{await close();}catch(cleanup){evidence.cleanupError=String(cleanup);}throw error;}
}
module.exports={create};
