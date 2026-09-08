import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, access, mkdir, mkdtemp } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const server = new McpServer({ name: 'game-capture', version: '0.1.0' });
const defaultDiscovery = process.env.GAME_CAPTURE_MCP_DISCOVERY ||
  path.join(process.env.LOCALAPPDATA || process.cwd(), 'GameCapture', 'control.json');
const executable = process.env.GAME_CAPTURE_MCP_EXECUTABLE ||
  path.join(process.env.ProgramW6432 || 'C:\\Program Files', 'Game Capture', 'game-capture.exe');
let target;
let owned;
let closing = false;
let mutationQueue = Promise.resolve();
const secrets = new Set();
const text = z.string().min(1).max(1024).refine(s => !/[\u0000-\u001f]/u.test(s), 'Control characters are not allowed');
const streamText = text.regex(/^[A-Za-z0-9_-]+$/, 'Use a stream ID, not a viewer URL');
function clean(value) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(token|password|authorization|remote_control_token)$/i.test(k) ? '[redacted]' : clean(v)]));
  return value;
}
function output(value) {
  const data = clean(value);
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}
async function readDiscovery(filename) {
  const c = JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
  const url = new URL(c.base_url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash ||
      !Number.isSafeInteger(c.pid) || c.pid < 1 || typeof c.token !== 'string' || !c.token) {
    throw new Error('Invalid discovery file: expected a token-protected 127.0.0.1 endpoint and PID.');
  }
  secrets.add(c.token);
  return { ...c, base_url: url.origin, discovery: filename };
}
async function request(c, route, body) {
  const response = await fetch(c.base_url + route, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Game Capture HTTP ${response.status}: ${result.error || JSON.stringify(result)}`);
  return result;
}
async function health(c) {
  const response = await fetch(c.base_url + '/health', { redirect: 'error', signal: AbortSignal.timeout(3000) });
  const h = await response.json();
  if (!response.ok || h.pid !== c.pid || h.schema !== 'game-capture-local-control-v1') {
    throw new Error('Discovery is stale or belongs to a different application instance. Attach again.');
  }
  return h;
}
async function current() {
  if (!target) throw new Error('No app selected. Use game_capture_attach or game_capture_launch first.');
  const c = target;
  await health(c);
  return c;
}
function summary(d) {
  return { app: d.app, source: d.source, signaling: d.signaling,
    video: Object.fromEntries(Object.entries(d.video || {}).filter(([key]) => !key.startsWith('ffmpeg_'))),
    audio: d.audio, peers: d.peers, metrics: d.metrics, room_quality: d.room_quality };
}
function register(name, description, inputSchema, readOnly, handler) {
  server.registerTool(`game_capture_${name}`, {
    description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true }
  }, async args => {
    const run = async () => {
      if (closing) throw new Error('MCP server is shutting down.');
      return output(await handler(args));
    };
    try {
      if (readOnly) return await run();
      const pending = mutationQueue.then(run);
      mutationQueue = pending.catch(() => {});
      return await pending;
    } catch (error) {
      return { content: [{ type: 'text', text: clean(error.message) }], isError: true };
    }
  });
}
register('attach', 'Select an already-running app by its local discovery file. Does not start streaming. Never returns its bearer token.', {
  discovery: text.optional()
}, false, async ({ discovery }) => {
  if (owned) throw new Error('Quit the MCP-owned app before attaching to another instance.');
  const c = await readDiscovery(path.resolve(discovery || defaultDiscovery));
  const h = await health(c);
  await request(c, '/schema');
  target = c;
  return { attached: true, owned: false, pid: c.pid, version: h.version };
});
register('schema', 'Read the selected app version and supported HTTP endpoints and commands.', {}, true, async () => {
  const c = await current(); return { health: await health(c), contract: await request(c, '/schema') };
});
register('status', 'Read capture, encoder, audio, signaling, and peer state without screenshots. Full diagnostics optionally include FFmpeg details.', {
  full: z.boolean().default(false)
}, true, async ({ full }) => {
  const c = await current(); const d = await request(c, '/diagnostics');
  return { pid: c.pid, owned: owned?.pid === c.pid, diagnostics: full ? d : summary(d) };
});
register('sources', 'List available windows, cameras, Spout2 senders, or microphones. Use a returned source name when launching a stream.', {
  kind: z.enum(['windows', 'cameras', 'spout', 'audio-inputs'])
}, true, async ({ kind }) => request(await current(), `/sources/${kind}`));
register('logs', 'Read recent application log lines for the selected instance.', {
  lines: z.number().int().min(1).max(2000).default(100)
}, true, async ({ lines }) => request(await current(), `/logs/recent?lines=${lines}`));
register('firewall', 'Read Windows Firewall installer-rule status for GAME_CAPTURE_MCP_EXECUTABLE. Does not modify rules or require an attached app.', {}, true, async () => {
  const script = fileURLToPath(new URL('../check-firewall.ps1', import.meta.url));
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-ExecutablePath', executable], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
});
register('monitor', 'Sample diagnostics over a bounded interval. Publisher state is not proof of receiver playback; inspect receiver statistics when diagnosing quality.', {
  seconds: z.number().int().min(1).max(20).default(5)
}, true, async ({ seconds }) => {
  const c = await current(); const samples = [];
  for (let i = 0; i <= seconds; i++) {
    if (i) await delay(1000);
    await health(c);
    samples.push({ time: new Date().toISOString(), ...summary(await request(c, '/diagnostics')) });
  }
  return { pid: c.pid, samples };
});
register('command', 'Stop, quit, export diagnostics, create an issue report, or rebuild active peer transports. A refresh is asynchronous; monitor the result. Stop does not close the app.', {
  command: z.enum(['stop', 'quit', 'export_diagnostics', 'issue_report', 'refresh_peer_transports']),
  notes: z.string().max(8000).optional()
}, false, async ({ command, notes }) => {
  const c = await current();
  const result = await request(c, '/commands', { command, ...(command === 'issue_report' ? { notes } : {}) });
  if (command === 'quit') {
    if (owned?.pid === c.pid) {
      const child = owned;
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
      if (child.exitCode === null && child.signalCode === null) throw new Error('Quit accepted, but the app has not exited yet. Monitor before launching again.');
      owned = undefined;
    }
    target = undefined;
  }
  return result;
});
register('launch', 'Launch the configured packaged executable. Inspect mode opens the app without broadcasting; stream mode requires an explicit source and stream ID. Only one MCP-owned app may run at a time. To change settings, quit the owned app and launch again. Owned apps are closed when MCP disconnects.', {
  mode: z.enum(['inspect', 'stream']).default('inspect'),
  source: z.enum(['window', 'camera', 'spout']).optional(),
  sourceName: text.optional(), streamId: streamText.optional(),
  password: z.string().max(512).refine(s => !/[\u0000-\u001f]/u.test(s)).optional(),
  room: streamText.optional(),
  codec: z.enum(['h264', 'vp9', 'h265', 'av1']).default('h264'),
  encoder: z.enum(['auto', 'software', 'nvenc', 'qsv', 'amf']).default('auto'),
  width: z.number().int().min(320).max(3840).multipleOf(2).default(1280),
  height: z.number().int().min(240).max(2160).multipleOf(2).default(720),
  fps: z.number().int().min(1).max(120).default(30),
  bitrateKbps: z.number().int().min(250).max(100000).default(6000),
  audio: z.enum(['none', 'selected-window', 'default-output', 'communications-output', 'default-microphone']).default('none'),
  alpha: z.boolean().default(false),
  durationSeconds: z.number().int().min(10).max(86400).default(3600)
}, false, async opts => {
  if (owned) throw new Error('An MCP-owned app is already running. Quit it before launching another.');
  if (opts.mode === 'stream' && (!opts.source || !opts.sourceName || !opts.streamId)) {
    throw new Error('Stream mode requires source, sourceName, and streamId; automatic capture of an arbitrary window is not allowed.');
  }
  if (opts.alpha && opts.codec !== 'vp9') throw new Error('Use VP9 for the supported native OBS alpha workflow.');
  await access(executable);
  await access(path.join(path.dirname(executable), 'platforms', 'qwindows.dll'));
  const dir = path.join(process.env.LOCALAPPDATA || process.cwd(), 'GameCapture', 'mcp');
  await mkdir(dir, { recursive: true });
  const runDir = await mkdtemp(path.join(dir, 'session-'));
  const discovery = path.join(runDir, 'control.json');
  const token = randomBytes(32).toString('hex'); secrets.add(token);
  const args = ['--local-control', '--local-control-port=0', `--local-control-discovery=${discovery}`];
  if (opts.mode === 'stream') {
    if (opts.password && opts.password !== 'false') secrets.add(opts.password);
    const sourceFlag = { window: 'window', camera: 'camera', spout: 'spout-sender' }[opts.source];
    args.push('--headless', `--source=${opts.source}`, `--${sourceFlag}=${opts.sourceName}`,
      `--stream=${opts.streamId}`, `--password=${opts.password ?? ''}`, `--room=${opts.room || ''}`,
      `--video-codec=${opts.codec}`, `--video-encoder=${opts.encoder}`, `--resolution=${opts.width}x${opts.height}`,
      `--fps=${opts.fps}`, `--bitrate-kbps=${opts.bitrateKbps}`, `--audio-source=${opts.audio}`,
      `--duration-ms=${opts.durationSeconds * 1000}`, ...(opts.alpha ? ['--alpha-workflow'] : []));
  }
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GAME_CAPTURE_LOCAL_CONTROL_TOKEN: token } });
  owned = child;
  let tail = ''; let spawnError;
  const capture = chunk => { tail = (tail + chunk.toString()).slice(-16000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('error', error => { spawnError = error; });
  child.on('exit', () => { if (owned === child) owned = undefined; });
  try {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (closing) throw new Error('Launch cancelled by MCP shutdown.');
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Publisher startup failed (${spawnError?.code ?? child.exitCode ?? child.signalCode}). ${tail}`);
      }
      let c;
      try { c = await readDiscovery(discovery); } catch { await delay(150); continue; }
      if (c.pid !== child.pid) throw new Error('Publisher discovery PID mismatch.');
      await health(c);
      const d = await request(c, '/diagnostics');
      if (opts.mode === 'inspect' || (d.app?.live && d.app?.capturing && d.source?.has_frame)) {
        target = c;
        return { pid: child.pid, owned: true, mode: opts.mode, discovery, diagnostics: summary(d) };
      }
      await delay(200);
    }
    throw new Error(`Publisher did not reach ${opts.mode === 'stream' ? 'live capture with a source frame' : 'control readiness'} within 25 seconds. ${tail}`);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (let i = 0; i < 20 && !spawnError && child.exitCode === null && child.signalCode === null; i++) await delay(50);
    if (owned === child && (spawnError || child.exitCode !== null || child.signalCode !== null)) owned = undefined;
    throw error;
  }
});

async function shutdown() {
  if (closing) return;
  closing = true;
  await mutationQueue;
  const child = owned;
  if (child && child.exitCode === null && child.signalCode === null) {
    try { if (target?.pid === child.pid) await request(target, '/commands', { command: 'quit' }); } catch {}
    for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await server.close();
}
process.stdin.on('end', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
await server.connect(new StdioServerTransport());
