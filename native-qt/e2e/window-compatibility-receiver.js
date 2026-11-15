// Observe real browser-decoded frames, including source pixels and motion.
const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
(async () => {
  const [stream, out, pattern] = process.argv.slice(2);
  fs.mkdirSync(out, {recursive: true});
  const browser = await chromium.launch({channel: 'chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']});
  try {
    const page = await browser.newPage();
    await page.goto(`https://vdo.ninja/?view=${stream}&password=false&autostart&cleanoutput`,
      {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v =>
      v.videoWidth > 0 && v.currentTime > 1), null, {timeout: 40000});
    const result = await page.evaluate(async () => {
      const v = [...document.querySelectorAll('video')].find(v => v.videoWidth);
      const c = document.createElement('canvas'); c.width = 160; c.height = 90;
      const g = c.getContext('2d', {willReadFrequently: true});
      const samples = [], hashes = new Set();
      const initial = v.getVideoPlaybackQuality().totalVideoFrames;
      for (let n = 0; n < 20; n++) {
        g.drawImage(v, 0, 0, c.width, c.height);
        const data = g.getImageData(0, 0, c.width, c.height).data;
        let cyan = 0, red = 0, green = 0, blue = 0, yellow = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 60 && data[i+1] > 150 && data[i+2] > 150) cyan++;
          if (data[i] > 180 && data[i+1] < 70 && data[i+2] < 70) red++;
          if (data[i] < 60 && data[i+1] > 150 && data[i+2] < 60) green++;
          if (data[i] < 60 && data[i+1] < 60 && data[i+2] > 150) blue++;
          if (data[i] > 150 && data[i+1] > 150 && data[i+2] < 60) yellow++;
        }
        hashes.add(c.toDataURL());
        samples.push({cyan: cyan/(160*90), red: red/(160*90),
          green: green/(160*90), blue: blue/(160*90), yellow: yellow/(160*90)});
        await new Promise(r => setTimeout(r, 500));
      }
      return {width: v.videoWidth, height: v.videoHeight,
        frames: v.getVideoPlaybackQuality().totalVideoFrames - initial,
        distinctImages: hashes.size, samples};
    });
    result.motionPassed = result.frames > 150 && result.distinctImages > 10;
    result.isolationPassed = result.samples.every(s => s.red < (pattern === 'player' ? .5 : .02));
    result.sourceVideoPassed = result.samples.every(s => pattern === 'player'
      ? s.cyan > .03 && s.green > .025 && s.blue > .025 && s.yellow > .025
      : s.cyan > .5);
    fs.writeFileSync(path.join(out, 'playback.json'), JSON.stringify(result, null, 2));
    await page.screenshot({path: path.join(out, 'playback.png')});
    assert(result.motionPassed, 'Video must keep moving');
    assert(result.isolationPassed, 'Capture must exclude the red parent window');
    assert(result.sourceVideoPassed, 'Capture must contain the synthetic video picture');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
