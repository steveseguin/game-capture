#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
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

function parseArgs(argv) {
  const args = {
    publisherPath: '',
    bitrates: [3000, 6000, 12000, 20000],
    password: '',
    room: '',
    durationMs: 15000,
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    requireHardware: false,
    expectEncoderName: '',
    forbidEncoderName: '',
    caseRetries: 0,
    reportDir: path.resolve(__dirname, '../qa/reports')
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--bitrates=')) {
      const values = arg.slice('--bitrates='.length)
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (values.length > 0) {
        args.bitrates = values;
      }
    } else if (arg.startsWith('--password=')) {
      args.password = arg.slice('--password='.length);
    } else if (arg.startsWith('--room=')) {
      args.room = arg.slice('--room='.length);
    } else if (arg.startsWith('--duration-ms=')) {
      args.durationMs = Math.max(5000, Number(arg.slice('--duration-ms='.length)) || args.durationMs);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg === '--require-hardware') {
      args.requireHardware = true;
    } else if (arg.startsWith('--expect-encoder-name=')) {
      args.expectEncoderName = arg.slice('--expect-encoder-name='.length).trim();
    } else if (arg.startsWith('--forbid-encoder-name=')) {
      args.forbidEncoderName = arg.slice('--forbid-encoder-name='.length).trim();
    } else if (arg.startsWith('--case-retries=')) {
      args.caseRetries = Math.max(0, Number(arg.slice('--case-retries='.length)) || args.caseRetries);
    } else if (arg.startsWith('--report-dir=')) {
      args.reportDir = path.resolve(arg.slice('--report-dir='.length));
    }
  }

  args.publisherPath = detectPublisherBinary(args.publisherPath);
  return args;
}

function spawnCase(cfg, bitrate, streamId) {
  const args = [
    '--headless',
    `--stream=${streamId}`,
    `--password=${cfg.password}`,
    `--room=${cfg.room}`,
    `--duration-ms=${cfg.durationMs}`,
    '--fps=30',
    '--resolution=1280x720',
    `--bitrate-kbps=${bitrate}`
  ];
  if (cfg.videoEncoder) {
    args.push(`--video-encoder=${cfg.videoEncoder}`);
  }
  if (cfg.ffmpegPath) {
    args.push(`--ffmpeg-path=${cfg.ffmpegPath}`);
  }
  if (cfg.ffmpegOptions) {
    args.push(`--ffmpeg-options=${cfg.ffmpegOptions}`);
  }

  return new Promise((resolve) => {
    const env = { ...process.env };
    const qtPluginPath = detectQtPluginPath();
    if (qtPluginPath) {
      env.QT_PLUGIN_PATH = qtPluginPath;
      env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM || 'offscreen';
    }

    const proc = spawn(cfg.publisherPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });

    let output = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    proc.on('exit', (code) => {
      resolve({ code: code ?? 1, output, args });
    });
  });
}

function evaluateCase(result, bitrate, cfg) {
  const hasMainOverride = result.output.includes(`bitrate=${bitrate}kbps`);
  const hasEncoderInit = result.output.includes(`@${bitrate}kbps`);
  const hasEncodedOutputEvidence =
    /\[MFEncoder\]\s+First frame encoded successfully/i.test(result.output) ||
    /\[FFmpegEncoder\]\s+First packet encoded successfully/i.test(result.output) ||
    /\[Frame\]\s+sendVideo\s+failed/i.test(result.output);
  const activeLineMatch = result.output.match(/\[App\]\s+Video encoder active:\s+(.+?)\s+\(hardware=(true|false)\)/i);
  const activeEncoderName = activeLineMatch ? activeLineMatch[1].trim() : '';
  const hardwareActive = activeLineMatch ? activeLineMatch[2].toLowerCase() === 'true' : false;
  const hasActiveEncoderLog = Boolean(activeLineMatch);
  const expectedEncoderNames = String(cfg.expectEncoderName || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const matchesExpectedEncoder = expectedEncoderNames.length === 0 ||
    expectedEncoderNames.some((name) => activeEncoderName.toLowerCase().includes(name));
  const forbiddenEncoderNames = String(cfg.forbidEncoderName || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const hasForbiddenEncoder = forbiddenEncoderNames.some((name) =>
    activeEncoderName.toLowerCase().includes(name));
  const hardwareRequirementMet = !cfg.requireHardware || hardwareActive;
  const fatalPatterns = [
    /\[Headless\]\s+startCapture failed/i,
    /\[Headless\]\s+goLive failed/i,
    /\[App\]\s+Failed to connect/i,
    /\[App\]\s+Failed to publish stream/i,
    /\[App\]\s+Failed to join room/i
  ];
  const hasFatalError = fatalPatterns.some((re) => re.test(result.output));
  const pass = result.code === 0 &&
    hasMainOverride &&
    hasEncoderInit &&
    hasEncodedOutputEvidence &&
    hasActiveEncoderLog &&
    matchesExpectedEncoder &&
    !hasForbiddenEncoder &&
    hardwareRequirementMet &&
    !hasFatalError;
  return {
    pass,
    code: result.code,
    hasMainOverride,
    hasEncoderInit,
    hasEncodedOutputEvidence,
    hasFatalError,
    hasActiveEncoderLog,
    activeEncoderName,
    hardwareActive,
    matchesExpectedEncoder,
    hasForbiddenEncoder,
    hardwareRequirementMet
  };
}

function writeReport(cfg, startedAt, finishedAt, rows) {
  fs.mkdirSync(cfg.reportDir, { recursive: true });
  const reportPath = path.join(cfg.reportDir, `bitrate-smoke-${nowStamp()}.md`);
  const allPass = rows.every((r) => r.pass);
  const lines = [
    '# Bitrate Preset Smoke Report',
    '',
    `- Date: ${new Date(startedAt).toISOString()}`,
    `- Result: ${allPass ? 'PASS' : 'FAIL'}`,
    `- Duration (s): ${Math.round((finishedAt - startedAt) / 1000)}`,
    `- Publisher: ${cfg.publisherPath}`,
    `- Video encoder override: ${cfg.videoEncoder || '(default)'}`,
    `- FFmpeg path override: ${cfg.ffmpegPath || '(auto)'}`,
    `- Require hardware: ${cfg.requireHardware ? 'yes' : 'no'}`,
    `- Expected encoder name contains: ${cfg.expectEncoderName || '(none)'}`,
    `- Forbidden encoder name contains: ${cfg.forbidEncoderName || '(none)'}`,
    '',
    '| Bitrate (kbps) | Attempts | Exit | Main Override Log | Encoder Init Log | Encoded Output Evidence | Active Encoder Log | Expected Match | Forbidden Match | Hardware Active | Fatal Error Log | Result |',
    '|---:|---:|---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|'
  ];

  for (const row of rows) {
    lines.push(`| ${row.bitrate} | ${row.attempts} | ${row.code} | ${row.hasMainOverride ? 'yes' : 'no'} | ${row.hasEncoderInit ? 'yes' : 'no'} | ${row.hasEncodedOutputEvidence ? 'yes' : 'no'} | ${row.hasActiveEncoderLog ? 'yes' : 'no'} | ${row.matchesExpectedEncoder ? 'yes' : 'no'} | ${row.hasForbiddenEncoder ? 'yes' : 'no'} | ${row.hardwareActive ? 'yes' : 'no'} | ${row.hasFatalError ? 'yes' : 'no'} | ${row.pass ? 'PASS' : 'FAIL'} |`);
  }

  lines.push('', '## Tail Output', '', '```text');
  for (const row of rows) {
    lines.push(`[${row.bitrate} kbps]`);
    lines.push(...row.output.trim().split(/\r?\n/).slice(-20));
    lines.push('');
  }
  lines.push('```', '');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return { reportPath, allPass };
}

async function main() {
  const cfg = parseArgs(process.argv);
  if (!cfg.publisherPath || !fs.existsSync(cfg.publisherPath)) {
    throw new Error('Could not find game-capture.exe. Build native-qt first or pass --publisher-path.');
  }

  const startedAt = Date.now();
  const rows = [];

  console.log('[BITRATE] Starting bitrate preset smoke checks');
  console.log(`[BITRATE] Publisher: ${cfg.publisherPath}`);
  console.log(`[BITRATE] Cases: ${cfg.bitrates.join(', ')}`);
  if (cfg.videoEncoder) {
    console.log(`[BITRATE] Video encoder override: ${cfg.videoEncoder}`);
  }
  if (cfg.ffmpegPath) {
    console.log(`[BITRATE] FFmpeg path override: ${cfg.ffmpegPath}`);
  }
  if (cfg.caseRetries > 0) {
    console.log(`[BITRATE] Case retries: ${cfg.caseRetries}`);
  }

  for (const bitrate of cfg.bitrates) {
    const maxAttempts = 1 + cfg.caseRetries;
    let finalRow = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const streamId = `bitrate_smoke_${bitrate}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      console.log(`[BITRATE] Running ${bitrate} kbps case (${streamId}) attempt ${attempt}/${maxAttempts}`);
      const result = await spawnCase(cfg, bitrate, streamId);
      const verdict = evaluateCase(result, bitrate, cfg);
      finalRow = {
        bitrate,
        attempts: attempt,
        ...verdict,
        output: result.output
      };
      console.log(`[BITRATE] ${bitrate} kbps: ${verdict.pass ? 'PASS' : 'FAIL'} (attempt=${attempt}/${maxAttempts}, exit=${verdict.code}, encoder='${verdict.activeEncoderName || 'n/a'}', hardware=${verdict.hardwareActive})`);
      if (verdict.pass) {
        break;
      }
      if (attempt < maxAttempts) {
        console.log(`[BITRATE] Retrying ${bitrate} kbps case...`);
      }
    }

    rows.push(finalRow);
    if (!finalRow.pass) {
      break;
    }
  }

  const finishedAt = Date.now();
  const { reportPath, allPass } = writeReport(cfg, startedAt, finishedAt, rows);
  console.log(`[BITRATE] Report: ${reportPath}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('[BITRATE] Unhandled error:', err);
  process.exit(1);
});

