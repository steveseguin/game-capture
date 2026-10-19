#!/usr/bin/env node
'use strict';
// Offline verification of screenshots from the packaged GUI workflow.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const assert = require('assert/strict');
const {chromium} = require('playwright');
const directory = path.resolve(process.argv[2]);
const target = path.join(directory, 'pixel-review.json');
assert(!fs.existsSync(target), 'Preserve the previous review');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = fs.readFileSync(path.join(directory, 'results.json'));
const workflow = JSON.parse(bytes);
assert(workflow.finished && workflow.workflowPassed && workflow.fixtureCleanup.pointerRestored);
const result = {scope: 'Color-managed review of native GUI screenshots; selected preview cursor probes and source-list thumbnail presence. Not video quality or thumbnail cursor qualification.',
  executableSha256: workflow.executableSha256, workflowSha256: sha(bytes), reviewerSha256: sha(fs.readFileSync(__filename)), phases: [], passed: false};
fs.copyFileSync(__filename, path.join(directory, path.basename(__filename)));
(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    result.browserVersion = browser.version();
    const page = await browser.newPage();
    for (const phase of workflow.phases) {
      const images = {};
      for (const key of ['screenshot', 'sourceScreenshot']) {
        const image = fs.readFileSync(path.join(directory, phase[key].path));
        assert.equal(sha(image), phase[key].sha256);
        images[key] = 'data:image/png;base64,' + image.toString('base64');
      }
      const review = await page.evaluate(async ({phase, images}) => {
        async function load(data) {
          const img = new Image(); img.src = data; await img.decode();
          const canvas = new OffscreenCanvas(img.width, img.height);
          const ctx = canvas.getContext('2d', {colorSpace: 'srgb', willReadFrequently: true});
          ctx.drawImage(img, 0, 0);
          return {ctx, width: img.width, height: img.height};
        }
        const source = await load(images.sourceScreenshot), gui = await load(images.screenshot);
        const ratioX = gui.width / phase.windowBounds.width, ratioY = gui.height / phase.windowBounds.height;
        const rect = b => [Math.round((b.x - phase.windowBounds.x) * ratioX),
          Math.round((b.y - phase.windowBounds.y) * ratioY), Math.round(b.width * ratioX), Math.round(b.height * ratioY)];
        function redRegion(ctx, bounds) {
          const [x, y, w, h] = bounds, pixels = ctx.getImageData(x, y, w, h).data;
          let left = w, right = -1, top = h, bottom = -1, count = 0; const colors = {};
          for (let i = 0; i < pixels.length; i += 4) {
            const [r, g, b, a] = pixels.slice(i, i + 4);
            if (a !== 255 || r < 180 || g > 110 || b > 90) continue;
            const px = (i / 4) % w, py = Math.floor(i / 4 / w);
            left = Math.min(left, px); right = Math.max(right, px);
            top = Math.min(top, py); bottom = Math.max(bottom, py); count++;
            const key = [r,g,b].join(','); colors[key] = (colors[key] || 0) + 1;
          }
          const dominant = Object.entries(colors).sort((a,b) => b[1]-a[1])[0];
          return {count, bounds: [x + left, y + top, right - left + 1, bottom - top + 1],
            rgb: dominant ? dominant[0].split(',').map(Number) : null};
        }
        const reference = redRegion(source.ctx, [0,0,source.width,source.height]);
        const preview = redRegion(gui.ctx, rect(phase.previewBounds));
        const thumbnail = phase.sourceListBounds ? redRegion(gui.ctx, rect(phase.sourceListBounds)) : null;
        const matches = rgb => rgb && reference.rgb.every((v, i) => Math.abs(v-rgb[i]) <= 3);
        // Infer the fitted source extent from the known opaque right half.
        // Stay well inside flat regions; exclude scaled edges and the moving bar.
        const [rx,ry,rw,rh] = preview.bounds, width = rw * 2, height = width * 360 / 640;
        const originX = rx - rw, originY = ry + rh - height;
        const probes = [80,480].map((x, index) => {
          const cx = originX + x * width / 640, cy = originY + 90 * height / 360;
          const half = Math.max(3, Math.floor(18 * width / 640));
          const bounds = [Math.round(cx)-half, Math.round(cy)-half, half*2, half*2];
          const pixels = gui.ctx.getImageData(...bounds).data, expected = index ? preview.rgb : [0,0,0];
          let unexpected = 0;
          for (let i=0; i<pixels.length; i+=4)
            if (pixels[i+3] !== 255 || expected.some((v,c) => Math.abs(v-pixels[i+c]) > 3)) unexpected++;
          return {bounds, pixels: pixels.length/4, unexpected};
        });
        const geometryPassed = preview.count > 1000 && Math.abs(rh - height*320/360) < 6;
        return {reference, preview, thumbnail, probes, geometryPassed,
          previewColorPassed: !!matches(preview.rgb),
          thumbnailPassed: !!thumbnail && thumbnail.count > 500 && !!matches(thumbnail.rgb),
          selectedPreviewCursorPassed: geometryPassed && probes.every(p=>p.unexpected===0)};
      }, {phase, images});
      result.phases.push({mode: phase.mode, ...review});
    }
    result.passed = result.phases.length === 3 && result.phases.every(p =>
      p.previewColorPassed && p.thumbnailPassed && p.selectedPreviewCursorPassed);
  } catch (error) { result.error = String(error.stack || error); }
  finally {
    await browser.close();
    fs.writeFileSync(target, JSON.stringify(result, null, 2)+'\n');
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  }
})();
