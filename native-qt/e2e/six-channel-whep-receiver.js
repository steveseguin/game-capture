// Decode the private MediaMTX WHEP output in real Chrome, retaining SDP and tones.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const opts = Object.fromEntries(process.argv.slice(2).map(value => {
  const i = value.indexOf('='); return [value.slice(2, i), value.slice(i + 1)];
}));
const frequencies = require('./six-channel-tone-profiles.json').voice;
const output = path.resolve(opts.output);
const expectedChannels = Number(opts.channels || 6);
assert([2, 6].includes(expectedChannels));
let browser, page;
const report = { passed: false };
(async () => {
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    report.browser = browser.version(); page = await browser.newPage();
    await page.goto(new URL('/', opts.url).href);
    const negotiation = await page.evaluate(async ({ url, expectedChannels }) => {
      const pc = window.pc = new RTCPeerConnection({ iceServers: [] });
      pc.ontrack = event => {
        const element = document.createElement(event.track.kind);
        element.autoplay = true; element.muted = true;
        element.srcObject = new MediaStream([event.track]); document.body.appendChild(element);
        element.play().catch(() => {});
      };
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
      const offer = await pc.createOffer();
      const payload = offer.sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/)[1];
      if (expectedChannels === 6) offer.sdp = offer.sdp.replace(`a=rtpmap:${payload} opus/48000/2`, `a=rtpmap:${payload} multiopus/48000/6`)
        .replace(new RegExp(`(a=fmtp:${payload}[^\\r\\n]*)`), '$1;channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2');
      else offer.sdp = offer.sdp.replace(new RegExp(`(a=fmtp:${payload}[^\\r\\n]*)`), '$1;stereo=1');
      await pc.setLocalDescription(offer);
      const end = Date.now() + 10000;
      while (pc.iceGatheringState !== 'complete' && Date.now() < end) await new Promise(r => setTimeout(r, 50));
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
      const answer = await response.text();
      window.sessionUrl = response.headers.get('location') ? new URL(response.headers.get('location'), url).href : null;
      if (response.status === 201) await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      return { status: response.status, offer: pc.localDescription.sdp, answer };
    }, { url: opts.url, expectedChannels });
    fs.writeFileSync(output + '.offer.sdp', negotiation.offer);
    fs.writeFileSync(output + '.answer.sdp', negotiation.answer);
    assert.equal(negotiation.status, 201, negotiation.answer);
    await page.waitForFunction(() => pc.connectionState === 'connected' && pc.getReceivers().some(r => r.track.kind === 'audio'), null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    Object.assign(report, await page.evaluate(async frequencies => {
      const track = pc.getReceivers().find(r => r.track.kind === 'audio').track.clone();
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      const channels = []; let frames = 0;
      const read = (async () => {
        while (frames < 144000) {
          const { value, done } = await reader.read(); if (done) break;
          for (let ch = 0; ch < value.numberOfChannels; ++ch) {
            const samples = new Float32Array(value.numberOfFrames);
            value.copyTo(samples, { planeIndex: ch, format: 'f32-planar' });
            channels[ch] ||= []; channels[ch].push(...samples);
          }
          frames += value.numberOfFrames; value.close();
        }
      })();
      let readError;
      try { await Promise.race([read, new Promise((_, reject) => setTimeout(() => reject(Error('Decoded audio timed out')), 10000))]); }
      catch (error) { readError = String(error); }
      finally { await reader.cancel(); track.stop(); }
      const matrix = channels.map(samples => frequencies.map(frequency => {
        let real = 0, imag = 0;
        for (let i = 0; i < samples.length; ++i) {
          real += samples[i] * Math.cos(2 * Math.PI * frequency * i / 48000);
          imag += samples[i] * Math.sin(2 * Math.PI * frequency * i / 48000);
        }
        return 2 * Math.hypot(real, imag) / samples.length;
      }));
      const stats = [...(await pc.getStats()).values()];
      const inbound = stats.find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
      return { channels: channels.length, frames, matrix, codec: stats.find(s => s.id === inbound?.codecId), inbound,
        video: stats.find(s => s.type === 'inbound-rtp' && s.kind === 'video'), readError };
    }, frequencies));
    assert.equal(report.channels, expectedChannels); assert(report.frames >= 144000);
    for (let ch = 0; ch < 6; ++ch) {
      if (expectedChannels === 6) {
        assert(report.matrix[ch][ch] > .003, 'Missing source slot ' + (ch + 1));
        assert(report.matrix[ch].every((value, n) => n === ch || value < report.matrix[ch][ch] * .1), 'Source isolation failed');
      } else assert(Math.max(...report.matrix.map(row => row[ch])) > .003, 'Stereo fallback lost source slot ' + (ch + 1));
    }
    report.passed = true;
  } catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    if (page) await page.evaluate(async () => {
      if (window.pc) pc.close();
      if (window.sessionUrl) await fetch(sessionUrl, { method: 'DELETE' });
    }).catch(() => {});
    if (browser) await browser.close();
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, channels: report.channels, error: report.error }));
  }
})();
