/* Bounded remote compatibility: one BrowserStack session at a time. */
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const {chromium} = require('playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function receive(url, output, credentialFile) {
  const credentials = {};
  for (const line of fs.readFileSync(credentialFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(BROWSERSTACK_USERNAME|BROWSERSTACK_ACCESS_KEY)\s*=\s*(.*?)\s*$/);
    if (match) credentials[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const username = credentials.BROWSERSTACK_USERNAME, key = credentials.BROWSERSTACK_ACCESS_KEY;
  assert(username && key, 'BrowserStack credentials are missing from the specified file');
  // Connection errors can contain the complete capabilities URL. Never persist it.
  const sanitize = error => String(error).replace(/wss:\/\/cdp\.browserstack\.com\/\S+/g, '[BrowserStack connection]')
    .split(username).join('[username]').split(key).join('[access key]');
  const result = {started: new Date().toISOString(), sessions: [], limitations:
    'Short remote playback compatibility; not a load run, long soak, recorded-audio analysis, or physical latency measurement.'};
  fs.mkdirSync(output, {recursive:true});
  const save = () => fs.writeFileSync(path.join(output, 'browserstack-results.json'), JSON.stringify(result, null, 2));
  for (const target of [{os:'Windows', os_version:'11', name:'windows-chrome'},
                        {os:'OS X', os_version:'Sequoia', name:'mac-chrome'}]) {
    const report = {name:target.name, samples:[]}; result.sessions.push(report);
    let browser, page;
    try {
      const version = require('playwright/package.json').version;
      const caps = {...target, browser:'chrome', browser_version:'latest', resolution:'1920x1080',
        project:'Game Capture', build:'WHIP release qualification', 'browserstack.video':'true',
        'browserstack.username':username, 'browserstack.accessKey':key,
        'browserstack.playwrightVersion':version, 'client.playwrightVersion':version};
      browser = await chromium.connect('wss://cdp.browserstack.com/playwright?caps='+encodeURIComponent(JSON.stringify(caps)), {timeout:90000});
      report.version = browser.version(); page = await browser.newPage();
      await page.addInitScript(() => {
        window.qaPeers=[]; const Native=window.RTCPeerConnection;
        window.RTCPeerConnection=class extends Native { constructor(...args){super(...args);qaPeers.push(this);} };
        window.qaStats=async()=>{const stats=[];for(const pc of qaPeers)for(const item of(await pc.getStats()).values())
          if(item.type==='inbound-rtp'||item.type==='codec')stats.push(item);return stats;};
      });
      await page.goto(url, {waitUntil:'domcontentloaded', timeout:45000});
      await page.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>v.currentTime>2&&v.videoWidth>0), null, {timeout:45000});
      for(let index=0;index<7;index++){
        report.samples.push({wall:Date.now(), stats:await page.evaluate(()=>qaStats())});save();
        if(index<6)await sleep(5000);
      }
      const first=report.samples[0].stats, last=report.samples.at(-1).stats;
      const before=kind=>first.find(s=>s.type==='inbound-rtp'&&s.kind===kind);
      const after=kind=>last.find(s=>s.type==='inbound-rtp'&&s.kind===kind);
      assert(after('video')?.framesDecoded-before('video')?.framesDecoded>600, 'Remote video did not keep decoding');
      assert(after('audio')?.totalSamplesReceived-before('audio')?.totalSamplesReceived>48000*20, 'Remote audio did not keep decoding');
      assert(after('audio')?.totalAudioEnergy>before('audio')?.totalAudioEnergy, 'Remote decoded audio remained silent');
      report.videoFrames=after('video').framesDecoded-before('video').framesDecoded;
      report.audioSamples=after('audio').totalSamplesReceived-before('audio').totalSamplesReceived;
      report.freezeDelta=(after('video').freezeCount||0)-(before('video').freezeCount||0);
      report.droppedFrameDelta=(after('video').framesDropped||0)-(before('video').framesDropped||0);
      report.concealedSampleDelta=(after('audio').concealedSamples||0)-(before('audio').concealedSamples||0);
      assert.equal(report.freezeDelta,0,'Remote video froze during observation');
      await page.screenshot({path:path.join(output,target.name+'.png')});
      report.passed=true;
    } catch(error) { report.error=sanitize(error); report.passed=false; }
    finally {
      if(page)await page.evaluate('browserstack_executor: '+JSON.stringify({action:'setSessionStatus', arguments:{status:report.passed?'passed':'failed', reason:report.passed?'Continuous decoded WHIP audio and video':'See private local qualification report'}})).catch(()=>{});
      if(browser)await browser.close().catch(()=>{});save();
    }
  }
  result.passed=result.sessions.every(s=>s.passed);save();
  return result;
}
module.exports={receive};
