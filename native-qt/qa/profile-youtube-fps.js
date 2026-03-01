#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const args = {
    publisherPath: path.resolve(__dirname, '../build-review2/bin/Release/game-capture.exe'),
    youtubeUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&autoplay=1&mute=1',
    sampleSeconds: 35,
    startupDelayMs: 9000,
    timeoutMs: 120000
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = path.resolve(arg.slice('--publisher-path='.length));
    } else if (arg.startsWith('--youtube-url=')) {
      args.youtubeUrl = arg.slice('--youtube-url='.length);
    } else if (arg.startsWith('--sample-seconds=')) {
      args.sampleSeconds = Math.max(10, Number(arg.slice('--sample-seconds='.length)) || args.sampleSeconds);
    } else if (arg.startsWith('--startup-delay-ms=')) {
      args.startupDelayMs = Math.max(2000, Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs);
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Math.max(20000, Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs);
    }
  }
  return args;
}

function detectQtPluginPath() {
  const candidates = [
    process.env.QT_PLUGIN_PATH,
    'C:/vcpkg/installed/x64-windows/Qt6/plugins',
    'C:/Users/Steve/code/obs-studio/.deps/obs-deps-qt6-2025-08-23-x64/plugins'
  ].filter(Boolean);

  for (const candidate of candidates) {
    const qwindows = path.join(candidate, 'platforms', 'qwindows.dll');
    const qoffscreen = path.join(candidate, 'platforms', 'qoffscreen.dll');
    try {
      if (require('fs').existsSync(qwindows) || require('fs').existsSync(qoffscreen)) {
        return candidate;
      }
    } catch (_) {
      // ignore
    }
  }
  return '';
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

async function waitForViewerVideo(page, timeoutMs) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    const state = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) {
        return { ok: false, reason: 'no_video' };
      }
      return {
        ok: video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0,
        readyState: video.readyState,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        currentTime: video.currentTime || 0
      };
    });
    if (state.ok) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function waitForSessionPeer(page, timeoutMs) {
  const start = Date.now();
  let last = null;
  while ((Date.now() - start) < timeoutMs) {
    last = await page.evaluate(() => {
      const sessionObj = window.session || null;
      if (!sessionObj) {
        return { ready: false, reason: 'no_session' };
      }
      const rpcIds = Object.keys(sessionObj.rpcs || {});
      if (!rpcIds.length) {
        return { ready: false, reason: 'no_rpcs' };
      }
      return { ready: true, uuid: rpcIds[0], hasSendRequest: typeof sessionObj.sendRequest === 'function' };
    });
    if (last && last.ready) {
      return last;
    }
    await sleep(500);
  }
  return last || { ready: false, reason: 'timeout' };
}

async function sendDataMessage(page, payload) {
  return page.evaluate((msg) => {
    const sessionObj = window.session || null;
    if (!sessionObj) return { ok: false, reason: 'no_session' };
    const rpcIds = Object.keys(sessionObj.rpcs || {});
    if (!rpcIds.length) return { ok: false, reason: 'no_rpcs' };
    const uuid = rpcIds[0];
    let sent = false;
    if (typeof sessionObj.sendRequest === 'function') {
      sent = !!sessionObj.sendRequest(msg, uuid);
    } else {
      const rpc = sessionObj.rpcs[uuid];
      const channel = rpc && (rpc.receiveChannel || rpc.sendChannel);
      if (channel && channel.readyState === 'open') {
        channel.send(JSON.stringify(msg));
        sent = true;
      }
    }
    return { ok: sent, uuid };
  }, payload);
}

async function sendViewerInit(page, timeoutMs) {
  const peer = await waitForSessionPeer(page, Math.max(8000, Math.floor(timeoutMs / 2)));
  if (!peer || !peer.ready) {
    return { ok: false, state: peer || { reason: 'no_peer' } };
  }

  const initPayload = {
    init: {
      role: 'viewer',
      room: false,
      video: true,
      audio: true,
      label: 'yt-profile',
      system: {
        app: 'game-capture-profiler',
        version: '1',
        platform: 'playwright',
        browser: 'chromium'
      }
    }
  };

  const start = Date.now();
  let last = null;
  while ((Date.now() - start) < Math.max(8000, Math.floor(timeoutMs / 2))) {
    last = await sendDataMessage(page, initPayload);
    if (last && last.ok) {
      return { ok: true, state: last };
    }
    await sleep(400);
  }
  return { ok: false, state: last || { reason: 'send_failed' } };
}

function computeSummary(samples) {
  const valid = samples.filter((s) => s && s.ok);
  if (valid.length < 2) {
    return {
      sampleCount: samples.length,
      validSamples: valid.length,
      decodedFpsAvg: 0,
      decodedFpsP50: 0,
      decodedFpsP95: 0,
      droppedFramesDelta: 0,
      decodeFramesDelta: 0,
      currentTimeDelta: 0
    };
  }

  const first = valid[0];
  const last = valid[valid.length - 1];
  const totalSeconds = Math.max(0.001, (last.t - first.t) / 1000);
  const decodeFramesDelta = Math.max(0, last.total - first.total);
  const droppedFramesDelta = Math.max(0, last.dropped - first.dropped);
  const currentTimeDelta = Math.max(0, last.ct - first.ct);

  const inst = [];
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    const cur = valid[i];
    const dt = Math.max(0.001, (cur.t - prev.t) / 1000);
    const df = cur.total - prev.total;
    if (df >= 0) {
      inst.push(df / dt);
    }
  }

  const decodedFpsAvg = decodeFramesDelta / totalSeconds;
  return {
    sampleCount: samples.length,
    validSamples: valid.length,
    decodedFpsAvg,
    decodedFpsP50: percentile(inst, 50),
    decodedFpsP95: percentile(inst, 95),
    droppedFramesDelta,
    decodeFramesDelta,
    currentTimeDelta,
    firstWidth: first.w,
    firstHeight: first.h,
    lastWidth: last.w,
    lastHeight: last.h
  };
}

function extractCaptureInfo(logText) {
  const firstWindow = /\[Headless\]\s+Found\s+\d+\s+windows,\s+capturing first:\s+(.+)/i.exec(logText);
  const frameCounts = [];
  const frameRegex = /\[Frame\]\s+Received\s+(\d+)\s+frames in last 5s/ig;
  let m;
  while ((m = frameRegex.exec(logText)) !== null) {
    frameCounts.push(Number(m[1]));
  }

  const captureFpsApprox = frameCounts.length
    ? frameCounts.reduce((a, b) => a + b, 0) / frameCounts.length / 5.0
    : 0;

  return {
    capturedWindowTitle: firstWindow ? firstWindow[1].trim() : '',
    frameSamples5s: frameCounts.length,
    captureFpsApprox
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const streamId = `yt_prof_${Date.now()}`;
  const viewerUrl = `https://vdo.ninja/?view=${streamId}&autostart=&muted=`;

  console.log(`[PROFILE] Starting source browser with YouTube: ${args.youtubeUrl}`);
  let sourceBrowser = null;
  let viewerBrowser = null;
  let publisher = null;
  let pubLog = '';
  try {
    sourceBrowser = await chromium.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required']
    });
    const sourcePage = await sourceBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    await sourcePage.goto(args.youtubeUrl, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs });
    await sourcePage.waitForTimeout(3500);
    await sourcePage.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.muted = true;
        video.play().catch(() => {});
      }
    });
    await sourcePage.bringToFront();
    await sourcePage.waitForTimeout(1500);

    console.log(`[PROFILE] Starting publisher: ${args.publisherPath}`);
    const pubArgs = [
      '--headless',
      `--stream=${streamId}`,
      '--password=',
      '--room=',
      '--label=yt-prof',
      '--server=wss://wss.vdo.ninja:443',
      '--salt=vdo.ninja',
      '--duration-ms=150000'
    ];
    const pubEnv = { ...process.env };
    const qtPluginPath = detectQtPluginPath();
    if (qtPluginPath) {
      pubEnv.QT_PLUGIN_PATH = qtPluginPath;
      pubEnv.QT_QPA_PLATFORM = pubEnv.QT_QPA_PLATFORM || 'offscreen';
    }

    publisher = spawn(args.publisherPath, pubArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pubEnv
    });

    publisher.stdout.on('data', (chunk) => { pubLog += chunk.toString(); });
    publisher.stderr.on('data', (chunk) => { pubLog += chunk.toString(); });

    console.log(`[PROFILE] Waiting for publisher startup (${args.startupDelayMs}ms)`);
    await sleep(args.startupDelayMs);

    viewerBrowser = await chromium.launch({ headless: true });
    const viewerPage = await viewerBrowser.newPage();
    console.log(`[PROFILE] Opening viewer: ${viewerUrl}`);
    await viewerPage.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs });

    const init = await sendViewerInit(viewerPage, args.timeoutMs);
    if (!init.ok) {
      throw new Error(`Viewer init failed: ${JSON.stringify(init.state || {})}`);
    }

    const ready = await waitForViewerVideo(viewerPage, args.timeoutMs);
    if (!ready) {
      throw new Error('Viewer did not reach ready video state in time');
    }

    console.log(`[PROFILE] Sampling decoded FPS for ${args.sampleSeconds}s`);
    const samples = [];
    for (let i = 0; i < args.sampleSeconds; i++) {
      const sample = await viewerPage.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return { ok: false, t: Date.now() };
        let total = 0;
        let dropped = 0;
        if (typeof v.getVideoPlaybackQuality === 'function') {
          const q = v.getVideoPlaybackQuality();
          total = Number(q.totalVideoFrames || 0);
          dropped = Number(q.droppedVideoFrames || 0);
        } else {
          total = Number(v.webkitDecodedFrameCount || 0);
          dropped = Number(v.webkitDroppedFrameCount || 0);
        }
        return {
          ok: true,
          t: Date.now(),
          total,
          dropped,
          ct: Number(v.currentTime || 0),
          w: Number(v.videoWidth || 0),
          h: Number(v.videoHeight || 0),
          rs: Number(v.readyState || 0)
        };
      });
      samples.push(sample);
      await sleep(1000);
    }

    const summary = computeSummary(samples);
    const captureInfo = extractCaptureInfo(pubLog);
    const report = {
      runAt: new Date().toISOString(),
      streamId,
      viewerUrl,
      youtubeUrl: args.youtubeUrl,
      captureInfo,
      viewerSummary: summary
    };

    const outPath = path.resolve(__dirname, 'reports', `youtube-fps-profile-${nowStamp()}.json`);
    require('fs').mkdirSync(path.dirname(outPath), { recursive: true });
    require('fs').writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

    console.log('[PROFILE] RESULT');
    console.log(JSON.stringify(report, null, 2));
    console.log(`[PROFILE] REPORT ${outPath}`);
  } finally {
    if (viewerBrowser) {
      await viewerBrowser.close().catch(() => {});
    }
    if (sourceBrowser) {
      await sourceBrowser.close().catch(() => {});
    }
    if (publisher && !publisher.killed) {
      publisher.kill();
    }
  }
}

main().catch((err) => {
  console.error('[PROFILE] ERROR', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
