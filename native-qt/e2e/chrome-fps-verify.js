#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

function detectPublisherBinary() {
  const candidates = [
    path.resolve(__dirname, '../build-review2/bin/Release/game-capture.exe'),
    path.resolve(__dirname, '../build-test/bin/Release/game-capture.exe'),
    path.resolve(__dirname, '../build/bin/Release/game-capture.exe')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function detectQtPluginPath() {
  const candidates = [
    process.env.QT_PLUGIN_PATH,
    'C:/vcpkg/installed/x64-windows/Qt6/plugins',
    'C:/Users/Steve/code/obs-studio/.deps/obs-deps-qt6-2025-08-23-x64/plugins'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'platforms', 'qwindows.dll')) ||
      fs.existsSync(path.join(candidate, 'platforms', 'qoffscreen.dll'))
    ) {
      return candidate;
    }
  }
  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForLog(procState, needle, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (procState.stdout.includes(needle) || procState.stderr.includes(needle)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() > deadline || procState.exited) {
        clearInterval(timer);
        resolve(false);
      }
    }, 200);
  });
}

async function waitForDecodedVideo(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
        readyState: video.readyState,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
        currentTime: video.currentTime
      }));
      const decoded = videos.find((v) => v.readyState >= 3 && v.width > 0 && v.height > 0);
      return { videos, hasDecoded: Boolean(decoded), decoded };
    });
    if (state.hasDecoded) {
      return state;
    }
    await sleep(500);
  }
  return null;
}

async function measureVideoFps(page, sampleMs) {
  return page.evaluate(async (durationMs) => {
    const video = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const probe = () => {
        const candidates = Array.from(document.querySelectorAll('video'));
        const ready = candidates.find((v) => v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
        if (ready) {
          resolve(ready);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('Timed out waiting for decoded video element'));
          return;
        }
        setTimeout(probe, 200);
      };
      probe();
    });

    try {
      await video.play();
    } catch {
      // ignore autoplay rejections in headless mode.
    }

    const qualityBefore = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const start = performance.now();
    let frameCallbacks = 0;

    if (typeof video.requestVideoFrameCallback === 'function') {
      await new Promise((resolve) => {
        const tick = (now) => {
          frameCallbacks += 1;
          if ((now - start) >= durationMs) {
            resolve();
            return;
          }
          video.requestVideoFrameCallback(tick);
        };
        video.requestVideoFrameCallback(tick);
      });
    } else {
      // Fallback if requestVideoFrameCallback is unavailable.
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    }

    const end = performance.now();
    const elapsedSec = Math.max(0.001, (end - start) / 1000);
    const qualityAfter = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;

    const decodedDelta = qualityBefore && qualityAfter
      ? Math.max(0, (qualityAfter.totalVideoFrames || 0) - (qualityBefore.totalVideoFrames || 0))
      : 0;

    return {
      elapsedSec,
      rvfcFrames: frameCallbacks,
      rvfcFps: frameCallbacks / elapsedSec,
      decodedFramesDelta: decodedDelta,
      decodedFps: decodedDelta / elapsedSec,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight
    };
  }, sampleMs);
}

async function main() {
  const publisherPath = detectPublisherBinary();
  if (!publisherPath) {
    throw new Error('Could not find game-capture.exe. Build first.');
  }

  const id = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const sourceTitle = `GC60 Source ${id}`;
  const sourcePath = path.join(os.tmpdir(), `gc60-source-${id}.html`);
  const streamId = `gc60_verify_${id}`;

  const sourceHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${sourceTitle}</title>
  <style>
    html,body { margin:0; width:100%; height:100%; overflow:hidden; background:#000; color:#0f0; font:600 28px Segoe UI; }
    #wrap { position:fixed; inset:0; display:grid; place-items:center; }
    #fps { position:fixed; top:12px; left:12px; background:#111a; padding:8px 12px; border:1px solid #0f07; border-radius:8px; }
    canvas { width:100vw; height:100vh; display:block; }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div id="fps">starting...</div>
  <script>
    const c = document.getElementById('c');
    const ctx = c.getContext('2d', { alpha: false });
    const fpsNode = document.getElementById('fps');
    function resize(){ c.width = innerWidth; c.height = innerHeight; }
    addEventListener('resize', resize); resize();
    let last = performance.now();
    let acc = 0;
    let frames = 0;
    let x = 0;
    function draw(now){
      const dt = now - last;
      last = now;
      acc += dt;
      frames++;
      if (acc >= 1000) {
        const fps = (frames * 1000 / acc).toFixed(1);
        fpsNode.textContent = 'Source FPS: ' + fps + ' @ ' + c.width + 'x' + c.height;
        acc = 0;
        frames = 0;
      }
      const w = c.width, h = c.height;
      x = (x + 9) % (w + 300);
      ctx.fillStyle = '#05080c';
      ctx.fillRect(0,0,w,h);
      const g = ctx.createLinearGradient(0,0,w,h);
      g.addColorStop(0, '#29d3ff');
      g.addColorStop(1, '#ff4d73');
      ctx.fillStyle = g;
      ctx.fillRect((x - 300), 0, 300, h);
      ctx.fillStyle = '#fff';
      ctx.font = '700 64px Segoe UI';
      ctx.fillText('60 FPS SOURCE', 80, 120);
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  </script>
</body>
</html>`;
  fs.writeFileSync(sourcePath, sourceHtml, 'utf8');

  console.log(`[VERIFY] Publisher: ${publisherPath}`);
  console.log(`[VERIFY] Source file: ${sourcePath}`);
  console.log(`[VERIFY] Stream ID: ${streamId}`);

  let sourceBrowser;
  let viewerBrowser;
  let publisher;
  const pubState = { stdout: '', stderr: '', exited: false };

  try {
    sourceBrowser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    });
    const sourceContext = await sourceBrowser.newContext({ viewport: { width: 1280, height: 720 } });
    const sourcePage = await sourceContext.newPage();
    await sourcePage.goto(`file:///${sourcePath.replace(/\\/g, '/')}`);
    await sourcePage.bringToFront();
    console.log('[VERIFY] Source window opened in Chrome');

    const pubArgs = [
      '--headless',
      `--stream=${streamId}`,
      '--duration-ms=90000',
      '--fps=60',
      '--resolution=1920x1080',
      '--bitrate-kbps=12000',
      '--video-encoder=nvenc',
      `--window=${sourceTitle.toLowerCase()}`
    ];
    const pubEnv = { ...process.env };
    const qtPluginPath = detectQtPluginPath();
    if (qtPluginPath) {
      pubEnv.QT_PLUGIN_PATH = qtPluginPath;
      pubEnv.QT_QPA_PLATFORM = pubEnv.QT_QPA_PLATFORM || 'offscreen';
    }

    publisher = spawn(publisherPath, pubArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pubEnv
    });
    publisher.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      pubState.stdout += text;
      process.stdout.write(text);
    });
    publisher.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      pubState.stderr += text;
      process.stderr.write(text);
    });
    publisher.on('exit', () => {
      pubState.exited = true;
    });

    const started = await waitForLog(pubState, '[Headless] Stream started', 30000);
    if (!started) {
      throw new Error('Publisher did not report stream start within timeout');
    }
    console.log('[VERIFY] Publisher reported stream start');

    viewerBrowser = await chromium.launch({
      channel: 'chrome',
      headless: true
    });
    const viewerContext = await viewerBrowser.newContext();
    const viewerPage = await viewerContext.newPage();
    const viewerUrl = `https://vdo.ninja/?view=${encodeURIComponent(streamId)}&autostart&muted`;
    await viewerPage.goto(viewerUrl, { waitUntil: 'domcontentloaded' });
    console.log(`[VERIFY] Viewer URL opened: ${viewerUrl}`);

    const decoded = await waitForDecodedVideo(viewerPage, 45000);
    if (!decoded) {
      throw new Error('Viewer failed to decode video in Chrome');
    }
    console.log(`[VERIFY] Viewer decoded video: ${decoded.decoded.width}x${decoded.decoded.height}`);

    const fps = await measureVideoFps(viewerPage, 10000);
    console.log(`[VERIFY] Chrome viewer sample: rvfcFps=${fps.rvfcFps.toFixed(2)} decodedFps=${fps.decodedFps.toFixed(2)} frames=${fps.rvfcFrames} size=${fps.videoWidth}x${fps.videoHeight}`);

    const effectiveFps = Math.max(fps.rvfcFps || 0, fps.decodedFps || 0);
    if (effectiveFps < 45) {
      throw new Error(`Chrome FPS below expectation: ${effectiveFps.toFixed(2)} (<45)`);
    }

    console.log('[VERIFY] PASS: Chrome viewer sustained >45fps sample for 1080p60 publish');
  } finally {
    if (publisher && !pubState.exited) {
      publisher.kill();
      await sleep(500);
    }
    if (viewerBrowser) {
      await viewerBrowser.close().catch(() => {});
    }
    if (sourceBrowser) {
      await sourceBrowser.close().catch(() => {});
    }
    try {
      fs.unlinkSync(sourcePath);
    } catch {
      // ignore cleanup errors
    }
  }
}

main().catch((error) => {
  console.error(`[VERIFY] FAIL: ${error.message}`);
  process.exit(1);
});

