#!/usr/bin/env node
'use strict';
// Download the published beta through a real browser. Preserve its original
// quarantine metadata; never synthesize or remove it to make a launch pass.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
if(process.platform!=='darwin'||!opts.reports)throw Error('Use --reports on macOS');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
fs.copyFileSync(__filename,path.join(report,'harness.js'));
const release='https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.62-beta.1';
const filename='game-capture-macos-arm64-0.2.62-beta.1.zip';
const expected='2e51db7ef109e01d7d14b6787fd8d7a6b8bd14e05e725d7185e0cf0fbdec306b';
const result={release,filename,expectedSha256:expected,scope:'Browser download and original quarantine preservation; does not itself launch the app',passed:false};
let browser;
(async()=>{
  console.log('Reports: '+report);
  try {
    const executable=opts['browser-executable']?path.resolve(opts['browser-executable']):chromium.executablePath();
    result.browserExecutable=executable;
    result.browserExecutableSha256=crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    browser=await chromium.launch({headless:false,executablePath:executable,downloadsPath:path.join(report,'browser-temporary-downloads')});
    result.browserVersion=browser.version();
    const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
    await page.goto(release,{waitUntil:'domcontentloaded',timeout:60000});
    const url='https://github.com/steveseguin/game-capture/releases/download/macos-v0.2.62-beta.1/'+filename;
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
    execFileSync('/usr/bin/ditto',['--qtn','--extattr',temporary,output],{timeout:30000});
    result.sha256=crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    if(result.sha256!==expected)throw Error('Downloaded archive differs from the signed beta');
    result.preservedQuarantine=execFileSync('/usr/bin/xattr',['-p','com.apple.quarantine',output],{encoding:'utf8'}).trim();
    if(result.preservedQuarantine!==result.originalQuarantine)throw Error('Quarantine changed while preserving download');
    result.archive=output;result.passed=true;
  }catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;}
  finally{if(browser)await browser.close();fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({report,passed:result.passed}));}
})();
