#!/usr/bin/env node
'use strict';

const fs = require('fs');
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
    mediaPlayerPath: detectMediaPlayerPath(),
    mediaFile: path.resolve(__dirname, 'media50fps.mp4'),
    useDefaultOpen: true,
    windowFilter: 'Media Player',
    minFps: 20,
    sampleSeconds: 35,
    startupDelayMs: 9000,
    timeoutMs: 120000
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = path.resolve(arg.slice('--publisher-path='.length));
    } else if (arg.startsWith('--media-player-path=')) {
      args.mediaPlayerPath = path.resolve(arg.slice('--media-player-path='.length));
      args.useDefaultOpen = false;
    } else if (arg.startsWith('--media-file=')) {
      args.mediaFile = path.resolve(arg.slice('--media-file='.length));
    } else if (arg.startsWith('--window-filter=')) {
      args.windowFilter = arg.slice('--window-filter='.length);
    } else if (arg === '--wmplayer') {
      args.useDefaultOpen = false;
    } else if (arg === '--default-player') {
      args.useDefaultOpen = true;
    } else if (arg.startsWith('--min-fps=')) {
      args.minFps = Math.max(1, Number(arg.slice('--min-fps='.length)) || args.minFps);
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

function detectMediaPlayerPath() {
  const candidates = [
    'C:/Program Files (x86)/Windows Media Player/wmplayer.exe',
    'C:/Program Files/Windows Media Player/wmplayer.exe'
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
    const qwindows = path.join(candidate, 'platforms', 'qwindows.dll');
    const qoffscreen = path.join(candidate, 'platforms', 'qoffscreen.dll');
    if (fs.existsSync(qwindows) || fs.existsSync(qoffscreen)) {
      return candidate;
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

async function waitForSessionPeer(page, timeoutMs) {
  const start = Date.now();
  let last = null;
  while ((Date.now() - start) < timeoutMs) {
    last = await page.evaluate(() => {
      const sessionObj = window.session || null;
      if (!sessionObj) return { ready: false, reason: 'no_session' };
      const rpcIds = Object.keys(sessionObj.rpcs || {});
      if (!rpcIds.length) return { ready: false, reason: 'no_rpcs' };
      return { ready: true, uuid: rpcIds[0] };
    });
    if (last.ready) return last;
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
  const payload = {
    init: {
      role: 'viewer',
      room: false,
      video: true,
      audio: true,
      label: 'media-player-profiler',
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
    last = await sendDataMessage(page, payload);
    if (last && last.ok) return { ok: true, state: last };
    await sleep(400);
  }
  return { ok: false, state: last || { reason: 'send_failed' } };
}

async function waitForViewerVideo(page, timeoutMs) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    const ok = await page.evaluate(() => {
      const v = document.querySelector('video');
      return !!(v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
    });
    if (ok) return true;
    await sleep(500);
  }
  return false;
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
    if (df >= 0) inst.push(df / dt);
  }

  return {
    sampleCount: samples.length,
    validSamples: valid.length,
    decodedFpsAvg: decodeFramesDelta / totalSeconds,
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
  const firstWindow = /\[Headless\]\s+Found\s+\d+\s+windows,\s+capturing(?: first)?:\s+(.+)/i.exec(logText);
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
  if (!args.useDefaultOpen && (!args.mediaPlayerPath || !fs.existsSync(args.mediaPlayerPath))) {
    throw new Error(`Media player not found: ${args.mediaPlayerPath}`);
  }
  if (!fs.existsSync(args.mediaFile)) {
    throw new Error(`Media file not found: ${args.mediaFile}`);
  }

  const streamId = `media_prof_${Date.now()}`;
  const viewerUrl = `https://vdo.ninja/?view=${streamId}&autostart=&muted=`;
  let mediaProc = null;
  let publisher = null;
  let viewerBrowser = null;
  let pubLog = '';

  try {
    if (args.useDefaultOpen) {
      console.log(`[PROFILE] Launching default media player for: ${args.mediaFile}`);
      mediaProc = spawn('explorer.exe', [args.mediaFile], {
        windowsHide: false,
        detached: false,
        stdio: 'ignore'
      });
    } else {
      console.log(`[PROFILE] Launching media player: ${args.mediaPlayerPath} ${args.mediaFile}`);
      mediaProc = spawn(args.mediaPlayerPath, ['/play', args.mediaFile], {
        windowsHide: false,
        detached: false,
        stdio: 'ignore'
      });
    }
    await sleep(5000);

    console.log(`[PROFILE] Starting publisher: ${args.publisherPath}`);
    const pubArgs = [
      '--headless',
      `--stream=${streamId}`,
      '--password=',
      '--room=',
      '--label=media-prof',
      '--server=wss://wss.vdo.ninja:443',
      '--salt=vdo.ninja',
      `--window=${args.windowFilter}`,
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
          h: Number(v.videoHeight || 0)
        };
      });
      samples.push(sample);
      await sleep(1000);
    }

    const report = {
      runAt: new Date().toISOString(),
      streamId,
      mediaPlayerPath: args.mediaPlayerPath,
      mediaFile: args.mediaFile,
      useDefaultOpen: args.useDefaultOpen,
      windowFilter: args.windowFilter,
      minFps: args.minFps,
      viewerUrl,
      captureInfo: extractCaptureInfo(pubLog),
      viewerSummary: computeSummary(samples)
    };

    const outPath = path.resolve(__dirname, 'reports', `media-player-fps-profile-${nowStamp()}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

    console.log('[PROFILE] RESULT');
    console.log(JSON.stringify(report, null, 2));
    console.log(`[PROFILE] REPORT ${outPath}`);

    if (report.viewerSummary.decodedFpsAvg < args.minFps) {
      throw new Error(
        `Decoded FPS ${report.viewerSummary.decodedFpsAvg.toFixed(2)} below threshold ${args.minFps.toFixed(2)}`
      );
    }
    console.log(`[PROFILE] PASS decodedFpsAvg=${report.viewerSummary.decodedFpsAvg.toFixed(2)} >= ${args.minFps.toFixed(2)}`);
  } finally {
    if (viewerBrowser) {
      await viewerBrowser.close().catch(() => {});
    }
    if (publisher && !publisher.killed) {
      publisher.kill();
    }
    // Best-effort cleanup for media players.
    spawn('taskkill', ['/IM', 'wmplayer.exe', '/F'], { windowsHide: true, stdio: 'ignore' });
    spawn('taskkill', ['/IM', 'MediaPlayer.exe', '/F'], { windowsHide: true, stdio: 'ignore' });
    spawn('taskkill', ['/IM', 'Video.UI.exe', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (mediaProc && !mediaProc.killed) {
      mediaProc.kill();
    }
  }
}

main().catch((err) => {
  console.error('[PROFILE] ERROR', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
