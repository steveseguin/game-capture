#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeId(value, maxLen, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed.replace(/[^A-Za-z0-9_]/g, '_');
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > maxLen) {
    return normalized.slice(0, maxLen);
  }
  return normalized;
}

function buildRunScopedId(base, maxLen, runIndex, attempt, fallbackPrefix) {
  const suffix = `_r${runIndex}a${attempt}`;
  const baseLimit = Math.max(1, maxLen - suffix.length);
  const fallback = `${fallbackPrefix}_${Date.now()}`;
  const normalizedBase = sanitizeId(base, baseLimit, fallback);
  const scopedBase = normalizedBase.length > baseLimit ? normalizedBase.slice(0, baseLimit) : normalizedBase;
  return `${scopedBase}${suffix}`;
}

function parseArgs(argv) {
  const seed = Date.now();
  const args = {
    durationMin: 30,
    holdMs: 4000,
    joinGapMs: 300,
    leaveGapMs: 300,
    timeoutMs: 60000,
    startupDelayMs: 7000,
    streamId: `dual_soak_${seed}`,
    room: `dual_soak_room_${seed}`,
    password: '',
    label: 'dual-quality-soak',
    publisherPath: '',
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    runRetries: 1,
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    reportDir: path.resolve(__dirname, '../qa/reports'),
    headful: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--duration-min=')) {
      args.durationMin = Math.max(1, Number(arg.slice('--duration-min='.length)) || args.durationMin);
    } else if (arg.startsWith('--hold-ms=')) {
      args.holdMs = Math.max(0, Number(arg.slice('--hold-ms='.length)) || args.holdMs);
    } else if (arg.startsWith('--join-gap-ms=')) {
      args.joinGapMs = Math.max(0, Number(arg.slice('--join-gap-ms='.length)) || args.joinGapMs);
    } else if (arg.startsWith('--leave-gap-ms=')) {
      args.leaveGapMs = Math.max(0, Number(arg.slice('--leave-gap-ms='.length)) || args.leaveGapMs);
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Math.max(5000, Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs);
    } else if (arg.startsWith('--startup-delay-ms=')) {
      args.startupDelayMs = Math.max(1000, Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs);
    } else if (arg.startsWith('--stream=')) {
      args.streamId = arg.slice('--stream='.length);
    } else if (arg.startsWith('--room=')) {
      args.room = arg.slice('--room='.length);
    } else if (arg.startsWith('--password=')) {
      args.password = arg.slice('--password='.length);
    } else if (arg.startsWith('--label=')) {
      args.label = arg.slice('--label='.length);
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg.startsWith('--run-retries=')) {
      args.runRetries = Math.max(0, Number(arg.slice('--run-retries='.length)) || args.runRetries);
    } else if (arg.startsWith('--screenshot-dir=')) {
      args.screenshotDir = path.resolve(arg.slice('--screenshot-dir='.length));
    } else if (arg.startsWith('--report-dir=')) {
      args.reportDir = path.resolve(arg.slice('--report-dir='.length));
    } else if (arg === '--headful') {
      args.headful = true;
    }
  }

  const fallbackSeed = Date.now();
  args.originalStreamId = args.streamId;
  args.originalRoom = args.room;
  args.streamId = sanitizeId(args.streamId, 64, `dual_soak_${fallbackSeed}`);
  args.room = sanitizeId(args.room, 30, `dual_soak_room_${fallbackSeed}`);
  args.streamIdNormalized = args.streamId !== args.originalStreamId;
  args.roomNormalized = args.room !== args.originalRoom;

  return args;
}

function runChild(args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on('exit', (code) => {
      resolve({
        code: code ?? 1,
        output,
        startedAt,
        endedAt: Date.now()
      });
    });
  });
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateCycles(config, remainingMs) {
  const estimatedCycleMs = Math.max(1200, config.holdMs + config.joinGapMs + config.leaveGapMs + 900);
  const chunkTargetMs = Math.min(Math.max(estimatedCycleMs, remainingMs), 8 * 60 * 1000);
  return Math.max(1, Math.ceil(chunkTargetMs / estimatedCycleMs));
}

function buildChildArgs(config, streamId, room, cycles, runIndex) {
  const args = [
    path.resolve(__dirname, 'dual-quality-churn-e2e.js'),
    `--stream=${streamId}`,
    `--room=${room}`,
    `--password=${config.password}`,
    `--label=${config.label}-run-${runIndex}`,
    `--startup-delay-ms=${config.startupDelayMs}`,
    `--timeout-ms=${config.timeoutMs}`,
    `--hold-ms=${config.holdMs}`,
    `--join-gap-ms=${config.joinGapMs}`,
    `--leave-gap-ms=${config.leaveGapMs}`,
    `--cycles=${cycles}`,
    `--screenshot-dir=${config.screenshotDir}`,
    `--report-dir=${config.reportDir}`
  ];
  if (config.publisherPath) {
    args.push(`--publisher-path=${config.publisherPath}`);
  }
  if (config.videoEncoder) {
    args.push(`--video-encoder=${config.videoEncoder}`);
  }
  if (config.ffmpegPath) {
    args.push(`--ffmpeg-path=${config.ffmpegPath}`);
  }
  if (config.ffmpegOptions) {
    args.push(`--ffmpeg-options=${config.ffmpegOptions}`);
  }
  if (config.headful) {
    args.push('--headful');
  }
  return args;
}

function extractChildReportPath(output) {
  const lines = output.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\[DUAL-CHURN\]\s+Report:\s+(.+)/);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return '';
}

function extractFailureStage(output) {
  const lines = output.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\[DUAL-CHURN\]\s+FAIL at stage\s+(.+)/);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return '';
}

function isRetryableFailure(output, stage) {
  const joined = `${output}\n${stage || ''}`.toLowerCase();
  return joined.includes('no_rpcs') || joined.includes('timeout') || joined.includes('session-peer');
}

function writeReport(config, startedAt, endedAt, runs, failure) {
  fs.mkdirSync(config.reportDir, { recursive: true });
  const reportPath = path.join(config.reportDir, `dual-quality-soak-${nowStamp()}.md`);
  const lines = [
    '# Dual Quality Soak Report',
    '',
    `- Date: ${new Date(startedAt).toISOString()}`,
    `- Result: ${failure ? 'FAIL' : 'PASS'}`,
    `- Duration target (minutes): ${config.durationMin}`,
    `- Duration actual (seconds): ${Math.round((endedAt - startedAt) / 1000)}`,
    `- Base stream: ${config.streamId}`,
    `- Base room: ${config.room}`,
    `- Runs executed: ${runs.length}`,
    `- Hold per cycle (ms): ${config.holdMs}`,
    `- Join gap (ms): ${config.joinGapMs}`,
    `- Leave gap (ms): ${config.leaveGapMs}`,
    `- Timeout per cycle (ms): ${config.timeoutMs}`,
    '',
    '| Run | Attempt | Stream | Room | Cycles | Duration (s) | Result | Churn report |',
    '|---:|---:|---|---|---:|---:|:---:|---|'
  ];

  for (const run of runs) {
    lines.push(
      `| ${run.index} | ${run.attempt} | ${run.streamId} | ${run.room} | ${run.cycles} | ${Math.round(run.durationMs / 1000)} | ${run.code === 0 ? 'PASS' : 'FAIL'} | ${run.childReportPath || '(missing)'} |`
    );
  }

  if (failure) {
    lines.push('', '## Failure', '', `- Stage: ${failure.stage}`, `- Detail: ${failure.detail}`);
  }

  lines.push('', '## Output (tail per run)', '');
  for (const run of runs) {
    lines.push(`### Run ${run.index} Attempt ${run.attempt}`, '', '```text');
    lines.push(...run.output.trim().split(/\r?\n/).slice(-120));
    lines.push('```', '');
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

async function main() {
  const config = parseArgs(process.argv);
  const targetMs = config.durationMin * 60 * 1000;
  console.log(`[DUAL-SOAK] Duration target (min): ${config.durationMin}`);
  console.log(`[DUAL-SOAK] Base stream: ${config.streamId}`);
  console.log(`[DUAL-SOAK] Base room: ${config.room}`);
  if (config.streamIdNormalized || config.roomNormalized) {
    console.log(
      `[DUAL-SOAK] Normalized IDs from stream='${config.originalStreamId}' room='${config.originalRoom}'`
    );
  }

  const startedAt = Date.now();
  const runs = [];
  let failure = null;

  while ((Date.now() - startedAt) < targetMs) {
    const runIndex = runs.length + 1;
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(0, targetMs - elapsedMs);
    const cycles = estimateCycles(config, remainingMs);
    const maxAttempts = 1 + config.runRetries;
    let runPassed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const streamId = buildRunScopedId(config.streamId, 64, runIndex, attempt, 'dual_soak_stream');
      const room = buildRunScopedId(config.room, 30, runIndex, attempt, 'dual_soak_room');
      const childArgs = buildChildArgs(config, streamId, room, cycles, runIndex);

      console.log(
        `[DUAL-SOAK] Run ${runIndex} attempt ${attempt}/${maxAttempts} (remaining=${Math.round(remainingMs / 1000)}s, cycles=${cycles})`
      );

      // eslint-disable-next-line no-await-in-loop
      const result = await runChild(childArgs);
      const durationMs = result.endedAt - result.startedAt;
      const childReportPath = extractChildReportPath(result.output);
      const failureStage = extractFailureStage(result.output);
      runs.push({
        index: runIndex,
        attempt,
        streamId,
        room,
        cycles,
        code: result.code,
        durationMs,
        childReportPath,
        output: result.output
      });

      if (result.code === 0) {
        runPassed = true;
        break;
      }

      const retryable = attempt < maxAttempts && isRetryableFailure(result.output, failureStage);
      if (!retryable) {
        failure = {
          stage: `run-${runIndex}${failureStage ? `-${failureStage}` : ''}`,
          detail: `dual-quality-churn exited with code ${result.code}`
        };
        break;
      }

      console.warn(
        `[DUAL-SOAK] Run ${runIndex} attempt ${attempt} failed at stage '${failureStage || 'unknown'}'; retrying`
      );
      // eslint-disable-next-line no-await-in-loop
      await wait(1500);
    }

    if (failure) {
      break;
    }
    if (!runPassed) {
      failure = {
        stage: `run-${runIndex}`,
        detail: `all ${maxAttempts} attempt(s) failed`
      };
      break;
    }
  }

  const endedAt = Date.now();
  if (!failure && (endedAt - startedAt) < targetMs) {
    failure = {
      stage: 'duration-check',
      detail: `actual=${Math.round((endedAt - startedAt) / 1000)}s target=${Math.round(targetMs / 1000)}s`
    };
  }

  const reportPath = writeReport(config, startedAt, endedAt, runs, failure);
  console.log(`[DUAL-SOAK] Report: ${reportPath}`);
  process.exit(failure ? 1 : 0);
}

main().catch((err) => {
  console.error('[DUAL-SOAK] Unhandled error:', err);
  process.exit(1);
});
