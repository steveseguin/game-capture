// Receive the stream started by desktop-ui-e2e.py; never launch a publisher.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const [stream, report] = process.argv.slice(2);
  assert(stream && report, 'Stream ID and report directory are required');
  fs.mkdirSync(report, { recursive: true });
  const browser = await chromium.launch({
    headless: true, args: ['--autoplay-policy=no-user-gesture-required']
  });
  let page;
  try {
    page = await browser.newPage();
    const params = new URLSearchParams({ view: stream, password: 'false', autostart: '', muted: '', noaudio: '' });
    await page.goto(`https://vdo.ninja/?${params}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v =>
      v.videoWidth === 960 && v.videoHeight === 540 && v.readyState >= 2 && v.currentTime > 1),
    null, { timeout: 40000 });
    const playback = await page.evaluate(async () => {
      const v = [...document.querySelectorAll('video')].find(v => v.videoWidth === 960 && v.videoHeight === 540);
      const start = v.currentTime, frames = v.getVideoPlaybackQuality().totalVideoFrames;
      await new Promise(r => setTimeout(r, 3000));
      return { width: v.videoWidth, height: v.videoHeight, elapsed: v.currentTime - start,
        frames: v.getVideoPlaybackQuality().totalVideoFrames - frames, paused: v.paused, ended: v.ended };
    });
    fs.writeFileSync(path.join(report, 'playback.json'), JSON.stringify(playback, null, 2));
    assert(playback.frames > 30 && playback.elapsed > 2 && !playback.paused && !playback.ended,
      `Playback did not continue: ${JSON.stringify(playback)}`);
    await page.screenshot({ path: path.join(report, 'playback.png') });
    console.log(JSON.stringify(playback));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(report, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
