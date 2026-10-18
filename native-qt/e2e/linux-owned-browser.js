'use strict';
// A real browser chosen only by the owned desktop's private MIME association.
// QDesktopServices and the system xdg-open/gio executables remain unmodified.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {execFileSync,spawn}=require('child_process'),{chromium}=require('playwright');
const {decodeAnchoredRows,waitFor,sleep}=require('./macos-media-receiver');
async function create(env,report,options={}){
  const purpose=options.purpose||'viewer';assert(['viewer','releases'].includes(purpose));
  const releases='https://github.com/steveseguin/game-capture/releases';
  const matchesPage=url=>purpose==='viewer'||url.toLowerCase()===releases;
  const wrapper=env.GC_QA_WAYLAND_DESKTOP||env.GC_QA_PRIVATE_DESKTOP;assert(wrapper);
  for(const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME'])assert.equal(path.dirname(env[key]),wrapper,'Require isolated desktop directories');
  assert(!env.SNAP&&!fs.existsSync(path.join(env.XDG_RUNTIME_DIR,'flatpak-info')),'Workflow covers native DEB launch');
  const applications=path.join(env.XDG_DATA_HOME,'applications'),mime=path.join(env.XDG_CONFIG_HOME,'mimeapps.list');
  assert(!fs.existsSync(mime));assert(!fs.existsSync(applications));fs.mkdirSync(applications);
  const id='game-capture-owned-'+crypto.randomBytes(8).toString('hex')+'.desktop';
  const handler=path.join(report,'owned-browser-handler.py'),profile=path.join(report,'owned-browser-profile');
  const events=path.join(report,'owned-browser-events.jsonl');
  const config={browser:'/usr/bin/google-chrome',profile,events,purpose,releases};
  fs.writeFileSync(path.join(report,'owned-browser-config.json'),JSON.stringify(config));
  fs.writeFileSync(handler,`import json,subprocess,sys\nfrom pathlib import Path\nfrom urllib.parse import urlsplit\nc=json.loads(Path(__file__).with_name('owned-browser-config.json').read_text())\nassert len(sys.argv)==2\nu=urlsplit(sys.argv[1])\nassert sys.argv[1]==c['releases'] if c['purpose']=='releases' else u.scheme=='https' and u.netloc=='vdo.ninja'\nwith open(c['events'],'a') as f:f.write(json.dumps({'url':sys.argv[1]})+'\\n')\nsubprocess.run([c['browser'],'--user-data-dir='+c['profile'],'--new-window',sys.argv[1]],check=True,timeout=20)\n`);
  // Desktop Exec has its own quoting rules. This generated path is not shell code.
  assert(!/[\s"\\`$%]/.test(handler));
  fs.writeFileSync(path.join(applications,id),`[Desktop Entry]\nType=Application\nName=Game Capture Owned QA Browser\nExec=/usr/bin/python3 ${handler} %u\nTerminal=false\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\n`);
  fs.writeFileSync(mime,`[Default Applications]\nx-scheme-handler/http=${id}\nx-scheme-handler/https=${id}\n`);
  execFileSync('update-desktop-database',[applications],{env,timeout:5000});
  const selected=execFileSync('xdg-mime',['query','default','x-scheme-handler/https'],{env,encoding:'utf8',timeout:5000}).trim();assert.equal(selected,id);
  let browser,child;
  async function release(){if(browser){await browser.close();browser=null;}}
  async function close(){
    await release();
    if(child&&child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([child.closed,sleep(5000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await child.closed;}}
    fs.unlinkSync(mime);fs.rmSync(applications,{recursive:true});
  }
  try{
    const log=fs.createWriteStream(path.join(report,'owned-browser.log'));
    child=spawn(config.browser,['--user-data-dir='+profile,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--password-store=basic',
      ...(env.QT_QPA_PLATFORM==='wayland'?['--ozone-platform=wayland']:[]),'--window-size=720,560','--autoplay-policy=no-user-gesture-required','--mute-audio','about:blank'],{env,stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.closed=new Promise(resolve=>child.once('close',code=>log.end(()=>resolve(code))));
    const portFile=path.join(profile,'DevToolsActivePort');
    await waitFor(()=>{assert.equal(child.exitCode,null);return fs.existsSync(portFile);},15000,'Owned browser did not start');
    const endpoint='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').split('\n')[0];
    return {release,close,evidence:{desktopId:id,privateMimeAssociation:true,systemLaunchersUnmodified:true,nativeBrowserLaunch:true,purpose},
      async opened(url,previous){
        assert(!browser,'Release previous browser observation before the next desktop launch');
        assert(purpose!=='releases'||url===releases,'Only the fixed Releases URL is permitted');
        await waitFor(()=>fs.existsSync(events)&&fs.readFileSync(events,'utf8').trim().split('\n').length>previous,15000,'Open Link did not invoke private default browser');
        const entries=fs.readFileSync(events,'utf8').trim().split('\n').map(JSON.parse);assert.equal(entries.length,previous+1);assert.equal(entries.at(-1).url,url,'Browser received a different URL');
        await waitFor(async()=>{const r=await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(3000)});return (await r.json()).some(t=>t.type==='page'&&(purpose==='releases'?matchesPage(t.url):t.url===url));},20000,'Desktop browser did not open generated URL');
        browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0];
        const page=await waitFor(()=>context.pages().find(p=>purpose==='releases'?matchesPage(p.url()):p.url()===url),15000,'Opened page not observable');
        await page.waitForLoadState('domcontentloaded');
        if(purpose==='releases'){assert(matchesPage(page.url()));return page;}
        // Observe peers created by the hosted page itself; no navigation, role,
        // signaling or media injection is used to make the desktop handoff pass.
        await page.evaluate('globalThis.reviewDecodeIdentityRows = '+decodeAnchoredRows.toString());
        await page.evaluate(()=>Object.defineProperty(window,'reviewPCs',{get:()=>Object.values(window.session?.rpcs||{})}));
        await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://vdo.ninja'});
        return page;
      }};
  }catch(e){await close();throw e;}
}
module.exports={create};
