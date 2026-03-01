#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const args = {
    streamId: `refresh_${Date.now()}`,
    room: '',
    password: '',
    label: 'refresh-e2e',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    startupDelayMs: 7000,
    timeoutMs: 45000,
    reloads: 3,
    joinDelayMs: 0,
    headful: false,
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    publisherPath: '',
    videoEncoder: '',
    maxViewers: 0,
    ffmpegPath: '',
    ffmpegOptions: ''
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--stream=')) {
      args.streamId = arg.slice('--stream='.length);
    } else if (arg.startsWith('--room=')) {
      args.room = arg.slice('--room='.length);
    } else if (arg.startsWith('--password=')) {
      args.password = arg.slice('--password='.length);
    } else if (arg.startsWith('--label=')) {
      args.label = arg.slice('--label='.length);
    } else if (arg.startsWith('--server=')) {
      args.server = arg.slice('--server='.length);
    } else if (arg.startsWith('--salt=')) {
      args.salt = arg.slice('--salt='.length);
    } else if (arg.startsWith('--startup-delay-ms=')) {
      args.startupDelayMs = Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs;
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs;
    } else if (arg.startsWith('--reloads=')) {
      args.reloads = Math.max(1, Number(arg.slice('--reloads='.length)) || args.reloads);
    } else if (arg.startsWith('--join-delay-ms=')) {
      args.joinDelayMs = Math.max(0, Number(arg.slice('--join-delay-ms='.length)) || args.joinDelayMs);
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--max-viewers=')) {
      args.maxViewers = Math.max(0, Number(arg.slice('--max-viewers='.length)) || args.maxViewers);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg.startsWith('--screenshot-dir=')) {
      args.screenshotDir = path.resolve(arg.slice('--screenshot-dir='.length));
    } else if (arg === '--headful') {
      args.headful = true;
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
    if (fs.existsSync(path.join(candidate, 'platforms', 'qwindows.dll')) ||
        fs.existsSync(path.join(candidate, 'platforms', 'qoffscreen.dll'))) {
      return candidate;
    }
  }
  return '';
}

function detectPublisherBinary(explicitPath) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

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

function buildViewerUrl(config) {
  const query = new URLSearchParams();
  query.set('view', config.streamId);
  query.set('autostart', '');
  query.set('muted', '');
  if (config.room) {
    query.set('room', config.room);
    query.set('solo', '');
  }
  if (config.password) {
    query.set('password', config.password);
  }
  return `https://vdo.ninja/?${query.toString()}`;
}

function spawnPublisher(config) {
  const command = detectPublisherBinary(config.publisherPath);
  if (!command) {
    throw new Error('Could not find game-capture.exe. Build native-qt first or pass --publisher-path.');
  }

  const args = [
    '--headless',
    `--stream=${config.streamId}`,
    `--password=${config.password}`,
    `--room=${config.room}`,
    `--label=${config.label}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${Math.max(300000, config.startupDelayMs + config.timeoutMs * (config.reloads + 2))}`
  ];
  if (config.videoEncoder) {
    args.push(`--video-encoder=${config.videoEncoder}`);
  }
  if (config.maxViewers > 0) {
    args.push(`--max-viewers=${config.maxViewers}`);
  }
  if (config.ffmpegPath) {
    args.push(`--ffmpeg-path=${config.ffmpegPath}`);
  }
  if (config.ffmpegOptions) {
    args.push(`--ffmpeg-options=${config.ffmpegOptions}`);
  }

  const env = { ...process.env };
  const qtPluginPath = detectQtPluginPath();
  if (qtPluginPath) {
    env.QT_PLUGIN_PATH = qtPluginPath;
    env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM || 'offscreen';
  }

  const proc = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const stdout = [];
  const stderr = [];
  proc.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  proc.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  return { proc, command, args, stdout, stderr };
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectState(page) {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video')).map((v) => ({
      readyState: v.readyState,
      width: v.videoWidth,
      height: v.videoHeight,
      currentTime: v.currentTime,
      paused: v.paused,
      ended: v.ended
    }));
    return {
      title: document.title,
      videoCount: videos.length,
      hasDecodedVideo: videos.some((v) =>
        v.readyState >= 2 && v.width > 0 && v.height > 0 && v.currentTime > 0 && !v.ended),
      videos
    };
  });
}

async function waitForDecodedVideo(page, timeoutMs, stageLabel) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await collectState(page);
    if (lastState.hasDecodedVideo) {
      return { ok: true, state: lastState };
    }
    await wait(1000);
  }
  return { ok: false, state: lastState, stage: stageLabel };
}

async function main() {
  const config = parseArgs(process.argv);
  const viewerUrl = buildViewerUrl(config);

  console.log(`[REFRESH] Stream ID: ${config.streamId}`);
  console.log(`[REFRESH] Room: ${config.room || '(none)'}`);
  console.log(`[REFRESH] Password: ${config.password}`);
  console.log(`[REFRESH] Reload cycles: ${config.reloads}`);
  if (config.maxViewers > 0) {
    console.log(`[REFRESH] Max viewers: ${config.maxViewers}`);
  }
  if (config.joinDelayMs > 0) {
    console.log(`[REFRESH] Join delay (viewer B): ${config.joinDelayMs}ms`);
  }
  console.log(`[REFRESH] URL: ${viewerUrl}`);

  const publisher = spawnPublisher(config);
  console.log(`[REFRESH] Spawned publisher: ${publisher.command} ${publisher.args.join(' ')}`);
  await wait(config.startupDelayMs);

  const browser = await chromium.launch({
    headless: !config.headful,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    ignoreHTTPSErrors: true
  });

  const pageA = await context.newPage();
  const pageB = await context.newPage();

  let failure = null;
  try {
    await pageA.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let result = await waitForDecodedVideo(pageA, config.timeoutMs, 'initial-pageA');
    if (!result.ok) {
      failure = result;
      return;
    }
    console.log('[REFRESH] Initial viewer A decoded video');

    if (config.joinDelayMs > 0) {
      await wait(config.joinDelayMs);
    }

    await pageB.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    result = await waitForDecodedVideo(pageB, config.timeoutMs, 'initial-pageB');
    if (!result.ok) {
      failure = result;
      return;
    }
    console.log('[REFRESH] Initial viewer B decoded video');

    for (let i = 1; i <= config.reloads; i++) {
      await pageA.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      result = await waitForDecodedVideo(pageA, config.timeoutMs, `reloadA-${i}`);
      if (!result.ok) {
        failure = result;
        return;
      }
      console.log(`[REFRESH] Reload cycle ${i}: viewer A decoded`);

      await pageB.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      result = await waitForDecodedVideo(pageB, config.timeoutMs, `reloadB-${i}`);
      if (!result.ok) {
        failure = result;
        return;
      }
      console.log(`[REFRESH] Reload cycle ${i}: viewer B decoded`);
    }

    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const shotA = path.join(config.screenshotDir, `refresh-pass-a-${config.streamId}-${nowStamp()}.png`);
    const shotB = path.join(config.screenshotDir, `refresh-pass-b-${config.streamId}-${nowStamp()}.png`);
    await pageA.screenshot({ path: shotA, fullPage: true });
    await pageB.screenshot({ path: shotB, fullPage: true });
    console.log(`[REFRESH] PASS screenshots: ${shotA} | ${shotB}`);
    process.exitCode = 0;
  } finally {
    if (failure) {
      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const shotA = path.join(config.screenshotDir, `refresh-fail-a-${config.streamId}-${nowStamp()}.png`);
      const shotB = path.join(config.screenshotDir, `refresh-fail-b-${config.streamId}-${nowStamp()}.png`);
      await pageA.screenshot({ path: shotA, fullPage: true }).catch(() => {});
      await pageB.screenshot({ path: shotB, fullPage: true }).catch(() => {});
      console.error('[REFRESH] FAIL');
      console.error(`[REFRESH] Stage: ${failure.stage}`);
      console.error(`[REFRESH] State: ${JSON.stringify(failure.state)}`);
      console.error(`[REFRESH] Screenshots: ${shotA} | ${shotB}`);
      const stdoutText = publisher.stdout.join('');
      const stderrText = publisher.stderr.join('');
      if (stdoutText.trim()) {
        console.error(`[REFRESH] Publisher stdout:\n${stdoutText}`);
      }
      if (stderrText.trim()) {
        console.error(`[REFRESH] Publisher stderr:\n${stderrText}`);
      }
      process.exitCode = 1;
    }

    if (publisher.proc && !publisher.proc.killed) {
      publisher.proc.kill();
    }
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[REFRESH] Unhandled error:', err);
  process.exit(1);
});

