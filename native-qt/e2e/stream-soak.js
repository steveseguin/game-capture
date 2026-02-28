#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function timestampFile() {
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
  const args = {
    publisher: 'versus',
    publisherPath: '',
    streamId: `soak_${Date.now()}`,
    room: '',
    password: '',
    label: 'soak',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    durationMin: 30,
    iterations: 0,
    iterationsExplicit: false,
    runRetries: 1,
    timeoutMs: 45000,
    startupDelayMs: 7000,
    holdMs: 15000,
    headful: false,
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    reportDir: path.resolve(__dirname, '../qa/reports')
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--publisher=')) {
      args.publisher = arg.slice('--publisher='.length);
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--stream=')) {
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
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg.startsWith('--duration-min=')) {
      args.durationMin = Math.max(1, Number(arg.slice('--duration-min='.length)) || args.durationMin);
    } else if (arg.startsWith('--iterations=')) {
      args.iterationsExplicit = true;
      args.iterations = Math.max(1, Number(arg.slice('--iterations='.length)) || args.iterations);
    } else if (arg.startsWith('--run-retries=')) {
      args.runRetries = Math.max(0, Number(arg.slice('--run-retries='.length)) || args.runRetries);
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Math.max(1000, Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs);
    } else if (arg.startsWith('--startup-delay-ms=')) {
      args.startupDelayMs = Math.max(0, Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs);
    } else if (arg.startsWith('--hold-ms=')) {
      args.holdMs = Math.max(0, Number(arg.slice('--hold-ms='.length)) || args.holdMs);
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
  args.streamId = sanitizeId(args.streamId, 64, `soak_${fallbackSeed}`);
  args.streamIdNormalized = args.streamId !== args.originalStreamId;

  if (args.room) {
    args.originalRoom = args.room;
    args.room = sanitizeId(args.room, 30, '');
    args.roomNormalized = args.room !== args.originalRoom;
  } else {
    args.originalRoom = '';
    args.roomNormalized = false;
  }

  return args;
}

function computeDurationMs(cfg, iterations) {
  const publisherDurationMs = cfg.startupDelayMs + (iterations * (cfg.timeoutMs + cfg.holdMs + 5000)) + 30000;
  return Math.max(publisherDurationMs, 120000);
}

function estimateIterations(cfg, remainingMs) {
  if (cfg.iterationsExplicit) {
    return Math.max(1, cfg.iterations || 1);
  }
  const estimatedIterationMs = Math.max(2000, cfg.holdMs + 5000);
  const chunkTargetMs = Math.min(Math.max(estimatedIterationMs, remainingMs), 8 * 60 * 1000);
  return Math.max(1, Math.ceil(chunkTargetMs / estimatedIterationMs));
}

function buildStreamArgs(cfg, iterations, durationMs) {
  const args = [
    path.resolve(__dirname, 'stream-e2e.js'),
    `--publisher=${cfg.publisher}`,
    `--stream=${cfg.streamId}`,
    `--room=${cfg.room}`,
    `--password=${cfg.password}`,
    `--label=${cfg.label}`,
    `--server=${cfg.server}`,
    `--salt=${cfg.salt}`,
    `--timeout-ms=${cfg.timeoutMs}`,
    `--startup-delay-ms=${cfg.startupDelayMs}`,
    `--hold-ms=${cfg.holdMs}`,
    `--duration-ms=${durationMs}`,
    `--iterations=${iterations}`,
    `--screenshot-dir=${cfg.screenshotDir}`
  ];
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
  if (cfg.headful) {
    args.push('--headful');
  }
  return args;
}

function runChild(args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
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
    proc.on('exit', (exitCode) => {
      resolve({
        code: exitCode ?? 1,
        output,
        startedAt,
        endedAt: Date.now()
      });
    });
  });
}

function extractFailureStage(output) {
  const lines = output.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\[E2E\]\s+Iteration\s+(\d+):\s+FAIL/i);
    if (match && match[1]) {
      return `iteration-${match[1]}`;
    }
  }
  return '';
}

function isRetryableFailure(output) {
  const lower = output.toLowerCase();
  return lower.includes('iteration') && lower.includes('fail') &&
      (lower.includes('no_session') ||
       lower.includes('no_rpcs') ||
       lower.includes('timeout') ||
       lower.includes('last viewer state'));
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeReport(cfg, startedAt, endedAt, runs, failure) {
  fs.mkdirSync(cfg.reportDir, { recursive: true });
  const reportPath = path.join(cfg.reportDir, `soak-${timestampFile()}.md`);
  const result = failure ? 'FAIL' : 'PASS';
  const elapsedMs = endedAt - startedAt;

  const firstRun = runs[0] || {};
  const commandPreview = firstRun.args ? `node ${firstRun.args.join(' ')}` : '(none)';
  const lines = [
    '# E2E Soak Report',
    '',
    `- Date: ${new Date(startedAt).toISOString()}`,
    `- Result: ${result}`,
    `- Duration (minutes target): ${cfg.durationMin}`,
    `- Duration (seconds actual): ${Math.round(elapsedMs / 1000)}`,
    `- Stream: ${cfg.streamId}`,
    `- Room: ${cfg.room || '(none)'}`,
    `- Password: ${cfg.password}`,
    `- Iterations: ${cfg.iterations}`,
    `- Hold per iteration (ms): ${cfg.holdMs}`,
    `- Video encoder: ${cfg.videoEncoder || '(default)'}`,
    `- FFmpeg path override: ${cfg.ffmpegPath || '(auto)'}`,
    `- Timeout per iteration (ms): ${cfg.timeoutMs}`,
    `- Runs executed: ${runs.length}`,
    `- Run retries: ${cfg.runRetries}`,
    '',
    '## Command',
    '',
    '```text',
    commandPreview,
    '```',
    '',
    '| Run | Attempt | Stream | Room | Iterations | Duration (s) | Result |',
    '|---:|---:|---|---|---:|---:|:---:|'
  ];

  for (const run of runs) {
    lines.push(
      `| ${run.index} | ${run.attempt} | ${run.streamId} | ${run.room || '(none)'} | ${run.iterations} | ${Math.round(run.durationMs / 1000)} | ${run.code === 0 ? 'PASS' : 'FAIL'} |`
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
  const cfg = parseArgs(process.argv);
  const targetMs = cfg.durationMin * 60 * 1000;

  console.log('[SOAK] Starting E2E soak');
  console.log(`[SOAK] Target duration: ${cfg.durationMin} min`);
  if (cfg.iterationsExplicit) {
    console.log(`[SOAK] Fixed iterations per run: ${cfg.iterations}`);
  } else {
    console.log('[SOAK] Iterations: auto-estimated per run');
  }
  console.log(`[SOAK] Hold per iteration: ${cfg.holdMs}ms`);
  console.log(`[SOAK] Base stream: ${cfg.streamId}`);
  console.log(`[SOAK] Base room: ${cfg.room || '(none)'}`);
  if (cfg.streamIdNormalized || cfg.roomNormalized) {
    console.log(
      `[SOAK] Normalized IDs from stream='${cfg.originalStreamId}' room='${cfg.originalRoom || ''}'`
    );
  }
  console.log(`[SOAK] Run retries: ${cfg.runRetries}`);
  if (cfg.videoEncoder) {
    console.log(`[SOAK] Video encoder: ${cfg.videoEncoder}`);
  }
  if (cfg.ffmpegPath) {
    console.log(`[SOAK] FFmpeg path override: ${cfg.ffmpegPath}`);
  }

  const startedAt = Date.now();
  const runs = [];
  let failure = null;
  let runIndex = 0;
  const loopByDuration = !cfg.iterationsExplicit;

  while (true) {
    if (loopByDuration && (Date.now() - startedAt) >= targetMs) {
      break;
    }

    runIndex++;
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(0, targetMs - elapsedMs);
    const iterations = estimateIterations(cfg, remainingMs);
    const durationMs = computeDurationMs(cfg, iterations);
    const maxAttempts = 1 + cfg.runRetries;
    let runPassed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const streamId = buildRunScopedId(cfg.streamId, 64, runIndex, attempt, 'soak_stream');
      const room = cfg.room ? buildRunScopedId(cfg.room, 30, runIndex, attempt, 'soak_room') : '';
      const runCfg = { ...cfg, streamId, room };
      const childArgs = buildStreamArgs(runCfg, iterations, durationMs);

      if (loopByDuration) {
        console.log(
          `[SOAK] Run ${runIndex} attempt ${attempt}/${maxAttempts} (remaining=${Math.round(remainingMs / 1000)}s, iterations=${iterations})`
        );
      } else {
        console.log(`[SOAK] Run ${runIndex} attempt ${attempt}/${maxAttempts} (iterations=${iterations})`);
      }

      // eslint-disable-next-line no-await-in-loop
      const result = await runChild(childArgs);
      const runDurationMs = result.endedAt - result.startedAt;
      const failureStage = extractFailureStage(result.output);
      runs.push({
        index: runIndex,
        attempt,
        streamId,
        room,
        iterations,
        args: childArgs,
        code: result.code,
        durationMs: runDurationMs,
        output: result.output
      });

      if (result.code === 0) {
        runPassed = true;
        break;
      }

      const retryable = attempt < maxAttempts && isRetryableFailure(result.output);
      if (!retryable) {
        failure = {
          stage: `run-${runIndex}${failureStage ? `-${failureStage}` : ''}`,
          detail: `stream-e2e exited with code ${result.code}`
        };
        break;
      }

      console.warn(
        `[SOAK] Run ${runIndex} attempt ${attempt} failed at stage '${failureStage || 'unknown'}'; retrying`
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
    if (!loopByDuration) {
      break;
    }
  }

  const endedAt = Date.now();
  if (loopByDuration && !failure && (endedAt - startedAt) < targetMs) {
    failure = {
      stage: 'duration-check',
      detail: `actual=${Math.round((endedAt - startedAt) / 1000)}s target=${Math.round(targetMs / 1000)}s`
    };
  }

  const reportPath = writeReport(cfg, startedAt, endedAt, runs, failure);
  console.log(`[SOAK] Report: ${reportPath}`);
  process.exit(failure ? 1 : 0);
}

main().catch((err) => {
  console.error('[SOAK] Unhandled error:', err);
  process.exit(1);
});
