'use strict';
// Independent browser receiver for linux-arm64-bringup.py. JSON-lines commands
// keep GUI actions in the existing packaged workflow; no publisher internals
// substitute for decoded video and audio observations.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const readline = require('readline');
const crypto = require('crypto');
const {chromium} = require('playwright');
const media = require('./macos-media-receiver');
const [executablePath, stream, report] = process.argv.slice(2);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let browser, page;
let closing = false;
async function closeBrowser() {
  if (closing) return;
  closing = true;
  if (browser) await browser.close();
  browser = null;
}
process.once('SIGTERM', () => { closeBrowser().finally(() => process.exit(143)); });
process.once('SIGINT', () => { closeBrowser().finally(() => process.exit(130)); });
async function connect() {
  if (page) await page.close();
  page = await media.receiver(browser, stream);
  await page.evaluate(() => {
    const video = [...document.querySelectorAll('video')].find(v => v.videoWidth && !v.paused);
    const state = window.reviewContinuity = {frames:0, maxPresentationGapMs:0, maxMediaGapMs:0, started:performance.now()};
    let previous;
    function frame(now, metadata) {
      if (previous) {
        state.maxPresentationGapMs = Math.max(state.maxPresentationGapMs, now - previous.now);
        state.maxMediaGapMs = Math.max(state.maxMediaGapMs, (metadata.mediaTime - previous.mediaTime) * 1000);
      }
      state.frames++; state.lastFrameAt = performance.now();
      previous = {now, mediaTime:metadata.mediaTime};
      video.requestVideoFrameCallback(frame);
    }
    video.requestVideoFrameCallback(frame);
  });
  return {connected:true};
}
async function stats() {
  return page.evaluate(async () => {
    const peers = [];
    for (const pc of window.reviewPCs) {
      if (pc.connectionState !== 'connected') continue;
      const entries = await pc.getStats();
      peers.push({connectionState:pc.connectionState,
        tracks:[...entries.values()].filter(s => s.type === 'inbound-rtp').map(s => ({...s, codec:entries.get(s.codecId)?.mimeType})),
        candidates:[...entries.values()].filter(s => s.type === 'candidate-pair' && s.state === 'succeeded')});
    }
    return {peers, continuity:{...window.reviewContinuity, now:performance.now()}};
  });
}
async function observe(command) {
  assert(/^[a-z0-9-]+$/.test(command.label));
  const result = {label:command.label, passed:false};
  try {
    result.video = await media.observe(page, 4000);
    result.uniqueIdentities = media.requireMoving(result.video, command.label);
    result.audio = await media.observeAudio(page);
    assert(result.audio.tracks.some(t => /audio\/opus/i.test(t.codec) && t.packetsReceived > 20), 'No received Opus');
    // Identical to linux-audio-publish.js routing criteria. The private fixture
    // sends 440 Hz left, 880 Hz right and a 1200 Hz stereo microphone tone.
    result.goodAudioSamples = result.audio.spectra.filter(s =>
      s.rms > .005 && s.channels[0].tone440 > -55 && s.channels[1].tone880 > -55 &&
      s.channels[0].tone440 > s.channels[0].tone880 + 20 && s.channels[1].tone880 > s.channels[1].tone440 + 20 &&
      (command.microphone ? s.microphone1200 > -55 : s.microphone1200 < Math.min(s.tone440, s.tone880) - 25)).length;
    assert(result.goodAudioSamples >= 25, `Decoded stereo/microphone routing differs (${result.goodAudioSamples}/30)`);
    result.stats = await stats();
    result.passed = true;
  } catch (error) { result.error = String(error.stack || error); }
  await page.screenshot({path:path.join(report, command.label + '-browser.png')});
  const file = path.join(report, command.label + '-browser.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  if (!result.passed) throw Error(result.error);
  return {passed:true, report:file, sha256:hash(file), uniqueIdentities:result.uniqueIdentities, goodAudioSamples:result.goodAudioSamples};
}
(async () => {
  browser = await chromium.launch({executablePath, headless:true,
    env:{...process.env, PULSE_SINK:'arm_receiver'},
    args:['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    ignoreDefaultArgs:['--mute-audio']});
  process.stdout.write(JSON.stringify({ready:true, browserVersion:browser.version(), browserSha256:hash(executablePath),
    playwrightVersion:require('playwright/package.json').version, nodeVersion:process.version}) + '\n');
  for await (const line of readline.createInterface({input:process.stdin})) {
    const command = JSON.parse(line);
    try {
      let result;
      if (command.op === 'connect') result = await connect();
      else if (command.op === 'observe') result = await observe(command);
      else if (command.op === 'stats') result = await stats();
      else if (command.op === 'close') { await closeBrowser(); process.stdout.write('{"closed":true}\n'); break; }
      else throw Error('Unknown observer command');
      process.stdout.write(JSON.stringify({ok:true, ...result}) + '\n');
    } catch (error) { process.stdout.write(JSON.stringify({ok:false, error:String(error.stack || error)}) + '\n'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(closeBrowser);
