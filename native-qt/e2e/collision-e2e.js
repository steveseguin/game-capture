#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = {
    streamId: `collision_${Date.now()}`,
    room: '',
    password: '',
    label: 'collision-e2e',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    startupDelayMs: 7000,
    timeoutMs: 30000,
    publisherPath: '',
    videoEncoder: '',
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
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
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

function spawnPublisher(config, suffix) {
  const command = detectPublisherBinary(config.publisherPath);
  if (!command) {
    throw new Error('Could not find game-capture.exe. Build native-qt first or pass --publisher-path.');
  }

  const durationMs = Math.max(180000, config.startupDelayMs + config.timeoutMs + 60000);
  const args = [
    '--headless',
    `--stream=${config.streamId}`,
    `--password=${config.password}`,
    `--room=${config.room}`,
    `--label=${config.label}-${suffix}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${durationMs}`
  ];
  if (config.videoEncoder) {
    args.push(`--video-encoder=${config.videoEncoder}`);
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      resolve({ exited: false, timedOut: true, code: null, signal: null });
    }, timeoutMs);

    proc.once('exit', (code, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve({ exited: true, timedOut: false, code, signal });
    });
  });
}

function processLogText(publisher) {
  return `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
}

function hasCollisionMessage(text) {
  if (!text) {
    return false;
  }
  return /streamid-already-published|already in use|stream\s+id\s+is\s+already\s+in\s+use|stream.+in use/i.test(text);
}

function stopProcess(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) {
    return;
  }
  proc.kill();
}

async function main() {
  const config = parseArgs(process.argv);
  console.log(`[COLLISION] Stream ID: ${config.streamId}`);
  console.log(`[COLLISION] Room: ${config.room || '(none)'}`);
  console.log(`[COLLISION] Password: ${config.password}`);

  const first = spawnPublisher(config, 'first');
  console.log(`[COLLISION] First publisher: ${first.command} ${first.args.join(' ')}`);
  await wait(config.startupDelayMs);

  if (first.proc.exitCode !== null) {
    throw new Error('First publisher exited early before collision check');
  }

  const second = spawnPublisher(config, 'second');
  console.log(`[COLLISION] Second publisher: ${second.command} ${second.args.join(' ')}`);

  const secondExit = await waitForExit(second.proc, config.timeoutMs);
  if (!secondExit.exited) {
    const secondLogs = processLogText(second);
    throw new Error(`Second publisher did not exit within timeout (${config.timeoutMs}ms)\n${secondLogs}`);
  }

  const secondLogs = processLogText(second);
  if (!hasCollisionMessage(secondLogs)) {
    throw new Error(
      `Second publisher exited without explicit stream-in-use message (exitCode=${secondExit.code})\n${secondLogs}`
    );
  }

  if (first.proc.exitCode !== null) {
    const firstLogs = processLogText(first);
    throw new Error(
      `First publisher terminated unexpectedly during collision test (exitCode=${first.proc.exitCode})\n${firstLogs}`
    );
  }

  console.log('[COLLISION] PASS');
  console.log('[COLLISION] First publisher remained active, second publisher reported stream-in-use and exited.');

  stopProcess(first.proc);
  stopProcess(second.proc);
}

main().catch((err) => {
  console.error('[COLLISION] FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

