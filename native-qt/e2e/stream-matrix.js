#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = {
    publisher: '',
    publisherPath: '',
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    screenshotDir: '',
    headful: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--publisher=')) {
      args.publisher = arg.slice('--publisher='.length);
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg.startsWith('--screenshot-dir=')) {
      args.screenshotDir = arg.slice('--screenshot-dir='.length);
    } else if (arg === '--headful') {
      args.headful = true;
    }
  }

  return args;
}

function buildPassThroughArgs(cfg) {
  const args = [];
  if (cfg.publisher) {
    args.push(`--publisher=${cfg.publisher}`);
  }
  if (cfg.publisherPath) {
    args.push(`--publisher-path=${cfg.publisherPath}`);
  }
  if (cfg.videoEncoder) {
    args.push(`--video-encoder=${cfg.videoEncoder}`);
  }
  if (cfg.ffmpegPath) {
    args.push(`--ffmpeg-path=${cfg.ffmpegPath}`);
  }
  if (cfg.ffmpegOptions) {
    args.push(`--ffmpeg-options=${cfg.ffmpegOptions}`);
  }
  if (cfg.screenshotDir) {
    args.push(`--screenshot-dir=${cfg.screenshotDir}`);
  }
  if (cfg.headful) {
    args.push('--headful');
  }
  return args;
}

function runScenario(name, args) {
  return new Promise((resolve) => {
    console.log(`\n[MATRIX] Starting scenario: ${name}`);
    const proc = spawn(process.execPath, [path.resolve(__dirname, 'stream-e2e.js'), ...args], {
      stdio: 'inherit',
      windowsHide: true
    });
    proc.on('exit', (code) => {
      const ok = code === 0;
      console.log(`[MATRIX] Scenario ${name}: ${ok ? 'PASS' : 'FAIL'} (exit=${code ?? -1})`);
      resolve({ name, ok, code: code ?? -1 });
    });
  });
}

async function main() {
  const cliArgs = parseArgs(process.argv);
  const passThroughArgs = buildPassThroughArgs(cliArgs);
  const seed = Date.now();
  const scenarios = [
    {
      name: 'direct-default-password-reconnect',
      args: [
        `--stream=matrix_direct_${seed}`,
        '--password=',
        '--iterations=3',
        '--startup-delay-ms=6000',
        '--timeout-ms=70000',
        ...passThroughArgs
      ]
    },
    {
      name: 'room-default-password',
      args: [
        `--stream=matrix_room_${seed}`,
        `--room=room_${seed}`,
        '--password=',
        '--iterations=1',
        '--startup-delay-ms=7000',
        '--timeout-ms=70000',
        ...passThroughArgs
      ]
    },
    {
      name: 'direct-password-false',
      args: [
        `--stream=matrix_nopw_${seed}`,
        '--password=false',
        '--iterations=1',
        '--startup-delay-ms=7000',
        '--timeout-ms=70000',
        ...passThroughArgs
      ]
    },
    {
      name: 'direct-password-custom',
      args: [
        `--stream=matrix_pw_${seed}`,
        '--password=e2ePass123',
        '--iterations=1',
        '--startup-delay-ms=7000',
        '--timeout-ms=70000',
        ...passThroughArgs
      ]
    }
  ];

  const results = [];
  for (const scenario of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runScenario(scenario.name, scenario.args);
    results.push(result);
    if (!result.ok) {
      break;
    }
  }

  const failed = results.find((r) => !r.ok);
  if (failed) {
    console.error(`\n[MATRIX] FAILED at scenario: ${failed.name}`);
    process.exit(1);
  }

  console.log('\n[MATRIX] All scenarios passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[MATRIX] Unhandled error:', err);
  process.exit(1);
});
