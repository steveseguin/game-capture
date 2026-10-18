#!/usr/bin/env node
'use strict';
// Download the published beta through a real browser. Preserve its original
// quarantine metadata; never synthesize or remove it to make a launch pass.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const http=require('node:http');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
if(process.platform!=='darwin'||!opts.reports)throw Error('Use --reports on macOS');
const selection=['release-tag','filename','sha256'];
if(opts.delivery&&selection.some(key=>opts[key]))throw Error('Choose a local delivery or a published release');
if(selection.some(key=>opts[key])&&!selection.every(key=>opts[key]))throw Error('Specify --release-tag, --filename and --sha256 together');
const tag=opts['release-tag']||'macos-v0.2.62-beta.1';
const delivery=opts.delivery?path.resolve(opts.delivery):null;
const manifest=delivery?JSON.parse(fs.readFileSync(path.join(delivery,'delivery-manifest.json'))):null;
const filename=manifest?.archive?.name||opts.filename||'game-capture-macos-arm64-0.2.62-beta.1.zip';
const expected=manifest?.archive?.sha256||opts.sha256||'2e51db7ef109e01d7d14b6787fd8d7a6b8bd14e05e725d7185e0cf0fbdec306b';
if(!(/^[a-f0-9]{64}$/).test(expected))throw Error('Invalid expected archive hash');
if(delivery){
  if(manifest.format!==1||manifest.mode!=='distribution'||manifest.architecture!=='arm64'||
      !/^game-capture-macos-arm64-[\w.-]+\.zip$/.test(filename))throw Error('Use an audited distribution delivery');
  const localArchive=fs.realpathSync(path.join(delivery,filename));
  if(path.dirname(localArchive)!==fs.realpathSync(delivery))throw Error('Archive escapes delivery');
  if(crypto.createHash('sha256').update(fs.readFileSync(localArchive)).digest('hex')!==expected)throw Error('Local archive hash mismatch');
}else if(!/^macos-v\d+\.\d+\.\d+-beta\.\d+$/.test(tag)||filename!==`game-capture-macos-arm64-${tag.slice(7)}.zip`)throw Error('Invalid Mac beta artifact selection');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
fs.copyFileSync(__filename,path.join(report,'harness.js'));
const release=delivery?null:'https://github.com/steveseguin/game-capture/releases/tag/'+tag;
const result={release,filename,expectedSha256:expected,harnessSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),scope:delivery?'Browser download from an owned loopback server and original quarantine preservation; excludes public GitHub delivery and does not itself launch the app':'Browser download and original quarantine preservation; does not itself launch the app',passed:false};
if(delivery)result.deliveryManifestSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(delivery,'delivery-manifest.json'))).digest('hex');
let browser,server;
(async()=>{
  console.log('Reports: '+report);
  try {
    const executable=opts['browser-executable']?path.resolve(opts['browser-executable']):chromium.executablePath();
    result.browserExecutable=executable;
    result.browserExecutableSha256=crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    browser=await chromium.launch({headless:false,executablePath:executable,downloadsPath:path.join(report,'browser-temporary-downloads')});
    result.browserVersion=browser.version();
    const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
    let landing=release,url='https://github.com/steveseguin/game-capture/releases/download/'+tag+'/'+filename;
    if(delivery){
      server=http.createServer((req,res)=>{
        if(req.method!=='GET'){res.writeHead(405);res.end();return;}
        if(req.url==='/'){
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
          res.end('<!doctype html><title>Local Game Capture qualification download</title><a href="/download">Download experimental Mac candidate</a>');
        }else if(req.url==='/download'){
          res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${filename}"`});
          const stream=fs.createReadStream(path.join(delivery,filename));
          stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
        }else{res.writeHead(404);res.end();}
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      landing=`http://127.0.0.1:${server.address().port}/`;url=landing+'download';
      result.deliveryOrigin='owned-loopback-http';
    }
    await page.goto(landing,{waitUntil:'domcontentloaded',timeout:60000});
    // GitHub can defer rendering its asset list. The release page remains the
    // navigation/referrer context for a normal browser download request.
    const pending=page.waitForEvent('download',{timeout:60000});
    await page.evaluate(url=>{const a=document.createElement('a');a.href=url;a.textContent='Download Mac beta';document.body.append(a);a.click();},url);
    const download=await pending,error=await download.failure();if(error)throw Error(error);
    const temporary=await download.path();result.suggestedFilename=download.suggestedFilename();
    if(result.suggestedFilename!==filename)throw Error('Unexpected download filename');
    result.originalQuarantine=execFileSync('/usr/bin/xattr',['-p','com.apple.quarantine',temporary],{encoding:'utf8'}).trim();
    if(!result.originalQuarantine)throw Error('Browser did not attach quarantine metadata');
    const output=path.join(report,filename);
    // Both ditto and cp can reserialize the quarantine agent. This completed
    // download and its destination are owned by this workflow, on the same
    // filesystem. Rename the original file without rewriting its metadata;
    // retain the strict quarantine equality check below.
    fs.renameSync(temporary,output);
    result.sha256=crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    if(result.sha256!==expected)throw Error('Downloaded archive differs from the signed beta');
    result.preservedQuarantine=execFileSync('/usr/bin/xattr',['-p','com.apple.quarantine',output],{encoding:'utf8'}).trim();
    if(result.preservedQuarantine!==result.originalQuarantine)throw Error('Quarantine changed while preserving download');
    result.archive=output;result.passed=true;
  }catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;}
  finally{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({report,passed:result.passed}));}
})();
