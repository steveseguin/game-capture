#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function observeNvidiaSession(cfg, streamId, publisherPid) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    const url = new URL('https://vdo.ninja/');
    url.searchParams.set('view', streamId);
    if (cfg.password) url.searchParams.set('password', cfg.password);
    url.searchParams.set('autostart', '');
    url.searchParams.set('muted', '');
    if (cfg.room) url.searchParams.set('room', cfg.room);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some((video) =>
      video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 10
    ), null, { timeout: 20000 });
    const children = await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${publisherPid}' | Select-Object -ExpandProperty ProcessId`
    ], { windowsHide: true, timeout: 5000 });
    const ownedPids = new Set([publisherPid, ...children.stdout.trim().split(/\s+/).map(Number)]);
    const sample = await execFileAsync('nvidia-smi.exe', ['pmon', '-c', '1'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
    });
    const probeOutput = `${sample.stdout || ''}\n${sample.stderr || ''}`.trim();
    const found = probeOutput.split(/\r?\n/).some((line) => {
      const fields = line.trim().split(/\s+/);
      return /^\d+$/.test(fields[0]) && ownedPids.has(Number(fields[1]));
    });
    return { checked: true, found, decodedVideo: true, ownedPids: [...ownedPids], output: probeOutput };
  } catch (error) {
    return { checked: true, found: false, output: '', error: error.message };
  } finally {
    if (browser) await browser.close();
  }
}

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
    videoCodec: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    requireHardware: false,
    expectEncoderName: '',
    expectRequestedEncoder: '',
    expectEncoderCategory: '',
    forbidEncoderName: '',
    expectStartFailure: false,
    requireNvidiaSession: false,
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
    } else if (arg.startsWith('--video-codec=')) {
      args.videoCodec = arg.slice('--video-codec='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg === '--require-hardware') {
      args.requireHardware = true;
    } else if (arg.startsWith('--expect-encoder-name=')) {
      args.expectEncoderName = arg.slice('--expect-encoder-name='.length).trim();
    } else if (arg.startsWith('--expect-requested-encoder=')) {
      args.expectRequestedEncoder = arg.slice('--expect-requested-encoder='.length).trim();
    } else if (arg.startsWith('--expect-encoder-category=')) {
      args.expectEncoderCategory = arg.slice('--expect-encoder-category='.length).trim();
    } else if (arg.startsWith('--forbid-encoder-name=')) {
      args.forbidEncoderName = arg.slice('--forbid-encoder-name='.length).trim();
    } else if (arg === '--expect-start-failure') {
      args.expectStartFailure = true;
    } else if (arg === '--require-nvidia-session') {
      args.requireNvidiaSession = true;
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
    `--duration-ms=${cfg.requireNvidiaSession ? Math.max(60000, cfg.durationMs) : cfg.durationMs}`,
    '--fps=30',
    '--resolution=1280x720',
    `--bitrate-kbps=${bitrate}`
  ];
  if (cfg.videoEncoder) {
    args.push(`--video-encoder=${cfg.videoEncoder}`);
  }
  if (cfg.videoCodec) {
    args.push(`--video-codec=${cfg.videoCodec}`);
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
      env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM ||
        (fs.existsSync(path.join(qtPluginPath, 'platforms', 'qoffscreen.dll')) ? 'offscreen' : 'windows');
    }

    const proc = spawn(cfg.publisherPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });

    let output = '';
    let nvidiaSessionProbeStarted = false;
    let nvidiaSessionProbe = Promise.resolve({ checked: false, found: false, output: '' });
    const probeNvidiaSession = () => {
      if (!cfg.requireNvidiaSession || nvidiaSessionProbeStarted) {
        return;
      }
      nvidiaSessionProbeStarted = true;
      nvidiaSessionProbe = observeNvidiaSession(cfg, streamId, proc.pid);
    };
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      if (/\[Headless\]\s+Stream started/i.test(text)) {
        probeNvidiaSession();
      }
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
      if (/\[Headless\]\s+Stream started/i.test(text)) {
        probeNvidiaSession();
      }
    });
    proc.on('exit', (code) => {
      nvidiaSessionProbe.then((session) => {
        resolve({ code: code ?? 1, output, args, nvidiaSession: session });
      });
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
  const selectionLineMatch = result.output.match(
    /\[App\]\s+Video encoder selected requested=(.+?) active='([^']+)' category=(\S+) fallbackReason='([^']*)'/i
  );
  const legacyActiveLineMatch = result.output.match(
    /\[App\]\s+Video encoder active:\s+(.+?)\s+\(hardware=(true|false)\)/i
  );
  const activeEncoderName = selectionLineMatch
    ? selectionLineMatch[2].trim()
    : (legacyActiveLineMatch ? legacyActiveLineMatch[1].trim() : '');
  const requestedEncoder = selectionLineMatch ? selectionLineMatch[1].trim() : '';
  const activeCategory = selectionLineMatch ? selectionLineMatch[3].trim() : '';
  const hardwareActive = selectionLineMatch
    ? !['software', 'unavailable'].includes(activeCategory.toLowerCase())
    : Boolean(legacyActiveLineMatch && legacyActiveLineMatch[2].toLowerCase() === 'true');
  const hasActiveEncoderLog = Boolean(selectionLineMatch || legacyActiveLineMatch);
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
  const requestedEncoderMatches = !cfg.expectRequestedEncoder ||
    requestedEncoder.toLowerCase() === cfg.expectRequestedEncoder.toLowerCase();
  const encoderCategoryMatches = !cfg.expectEncoderCategory ||
    activeCategory.toLowerCase() === cfg.expectEncoderCategory.toLowerCase();
  const fatalPatterns = [
    /\[Headless\]\s+startCapture failed/i,
    /\[Headless\]\s+goLive failed/i,
    /\[App\]\s+Failed to connect/i,
    /\[App\]\s+Failed to publish stream/i,
    /\[App\]\s+Failed to join room/i
  ];
  const hasFatalError = fatalPatterns.some((re) => re.test(result.output));
  const hasVisibleStrictFailure = /\[App\]\s+Requested .+ encoder could not start with .+\. No different encoder category was selected\./i.test(result.output);
  const nvidiaSessionRequirementMet = !cfg.requireNvidiaSession || Boolean(result.nvidiaSession && result.nvidiaSession.found);
  const pass = cfg.expectStartFailure
    ? result.code !== 0 && hasFatalError && hasVisibleStrictFailure && !hasActiveEncoderLog
    : result.code === 0 &&
    hasMainOverride &&
    hasEncoderInit &&
    hasEncodedOutputEvidence &&
    hasActiveEncoderLog &&
    matchesExpectedEncoder &&
    !hasForbiddenEncoder &&
    hardwareRequirementMet &&
    requestedEncoderMatches &&
    encoderCategoryMatches &&
    nvidiaSessionRequirementMet &&
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
    requestedEncoder,
    activeCategory,
    hardwareActive,
    matchesExpectedEncoder,
    hasForbiddenEncoder,
    hardwareRequirementMet,
    requestedEncoderMatches,
    encoderCategoryMatches,
    hasVisibleStrictFailure,
    nvidiaSessionRequirementMet,
    nvidiaSessionProbe: result.nvidiaSession || { checked: false, found: false, output: '' }
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
    `- Video codec override: ${cfg.videoCodec || '(default)'}`,
    `- FFmpeg path override: ${cfg.ffmpegPath || '(auto)'}`,
    `- Require hardware: ${cfg.requireHardware ? 'yes' : 'no'}`,
    `- Expected encoder name contains: ${cfg.expectEncoderName || '(none)'}`,
    `- Expected requested encoder: ${cfg.expectRequestedEncoder || '(none)'}`,
    `- Expected encoder category: ${cfg.expectEncoderCategory || '(none)'}`,
    `- Forbidden encoder name contains: ${cfg.forbidEncoderName || '(none)'}`,
    `- Expected visible startup failure: ${cfg.expectStartFailure ? 'yes' : 'no'}`,
    `- Require active NVIDIA encoder session: ${cfg.requireNvidiaSession ? 'yes' : 'no'}`,
    '',
    '| Bitrate (kbps) | Attempts | Exit | Requested | Category | Main Override Log | Encoder Init Log | Encoded Output Evidence | Active Encoder Log | Expected Match | Forbidden Match | Hardware Active | NVIDIA Session | Fatal Error Log | Visible Strict Failure | Result |',
    '|---:|---:|---:|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|'
  ];

  for (const row of rows) {
    lines.push(`| ${row.bitrate} | ${row.attempts} | ${row.code} | ${row.requestedEncoder || 'n/a'} | ${row.activeCategory || 'n/a'} | ${row.hasMainOverride ? 'yes' : 'no'} | ${row.hasEncoderInit ? 'yes' : 'no'} | ${row.hasEncodedOutputEvidence ? 'yes' : 'no'} | ${row.hasActiveEncoderLog ? 'yes' : 'no'} | ${row.matchesExpectedEncoder ? 'yes' : 'no'} | ${row.hasForbiddenEncoder ? 'yes' : 'no'} | ${row.hardwareActive ? 'yes' : 'no'} | ${row.nvidiaSessionRequirementMet ? 'yes' : 'no'} | ${row.hasFatalError ? 'yes' : 'no'} | ${row.hasVisibleStrictFailure ? 'yes' : 'no'} | ${row.pass ? 'PASS' : 'FAIL'} |`);
  }

  lines.push('', '## Tail Output', '', '```text');
  for (const row of rows) {
    lines.push(`[${row.bitrate} kbps]`);
    lines.push(...row.output.trim().split(/\r?\n/).slice(-20));
    if (cfg.requireNvidiaSession) {
      lines.push('[nvidia-smi pmon -c 1]');
      lines.push(row.nvidiaSessionProbe.output || row.nvidiaSessionProbe.error || '(no output)');
    }
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

