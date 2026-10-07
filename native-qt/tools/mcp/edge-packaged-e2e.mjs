import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const dir = path.dirname(fileURLToPath(import.meta.url));
const native = path.resolve(dir, '../..');
const publisher = path.resolve(process.env.GAME_CAPTURE_MCP_EXECUTABLE || '');
const senderPath = process.env.GAME_CAPTURE_MCP_SPOUT_FIXTURE;
if (!process.env.GAME_CAPTURE_MCP_EXECUTABLE || !senderPath) throw Error('Packaged executable and Spout fixture are required');
const report = path.join(native, 'qa/reports/mcp-edge-e2e', String(Date.now()));
await mkdir(report, { recursive: true });
const python = path.join(native, '.cache/desktop-ui-python/Scripts/python.exe');
const settingsFile = path.join(report, 'settings.pickle');
const settingsScript = `import importlib.util,pickle,sys
spec=importlib.util.spec_from_file_location('desktop',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
if sys.argv[3]=='save':
 with open(sys.argv[2],'wb') as f: pickle.dump(m.snapshot(m.SETTINGS_KEY),f)
else:
 with open(sys.argv[2],'rb') as f: saved=pickle.load(f)
 m.restore(m.SETTINGS_KEY,saved)
 assert m.snapshot(m.SETTINGS_KEY)==saved
`;
function settings(action) {
  execFileSync(python, ['-c', settingsScript, path.join(native, 'e2e/desktop-ui-e2e.py'), settingsFile, action], { windowsHide: true });
}
const checks = [];
let browser, sender, failure, restored = false;
const clients = [];
const observedPids = new Set();
function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
}
async function connect(label) {
  const client = new Client({ name: label, version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(dir, 'server.mjs')],
    env: { ...process.env, LOCALAPPDATA: report, GAME_CAPTURE_MCP_EXECUTABLE: publisher, GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING: '1' }, stderr: 'pipe' });
  await client.connect(transport);
  clients.push(client);
  return client;
}
async function call(client, name, args = {}) {
  return client.callTool({ name: 'game_capture_' + name, arguments: args }, undefined, { timeout: 40000 });
}
function value(result) {
  if (result.isError) throw Error(JSON.stringify(result.content));
  return result.structuredContent || JSON.parse(result.content[0].text);
}
async function rejected(client, name, args) {
  try { return (await call(client, name, args)).isError === true; } catch { return true; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function remainingPublishers() {
  const script = `@(Get-CimInstance Win32_Process -Filter "Name='game-capture.exe'" | Where-Object {
    $_.ExecutablePath -eq $env:GC_EDGE_PUBLISHER -and $_.CommandLine.Contains($env:GC_EDGE_REPORT)
  } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
  const text = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8',
    env: { ...process.env, GC_EDGE_PUBLISHER: publisher, GC_EDGE_REPORT: report } }).trim();
  return text ? [].concat(JSON.parse(text)) : [];
}

settings('save');
try {
  const client = await connect('edge-cases');
  check('tool-discovery', (await client.listTools()).tools.length === 9);
  const launches = await Promise.all(Array.from({ length: 4 }, () => call(client, 'launch')));
  check('concurrent-launches-own-one-app', launches.filter(r => !r.isError).length === 1);
  const app = value(launches.find(r => !r.isError));
  observedPids.add(app.pid);
  const discovery = JSON.parse(await readFile(app.discovery, 'utf8'));
  const invalid = [
    ['launch', { width: 321 }], ['launch', { height: 241 }], ['launch', { width: 1e100 }],
    ['launch', { fps: -1 }], ['launch', { durationSeconds: 86401 }], ['launch', { bitrateKbps: 0 }],
    ['launch', { password: 'bad\u0000password' }], ['launch', { sourceName: 'bad\nname' }],
    ['launch', { sourceName: 'x'.repeat(1025) }], ['launch', { streamId: '--not-an-id' + '\r' }],
    ['launch', { codec: 'invalid' }], ['launch', { encoder: 'invalid' }],
    ['logs', { lines: '10' }], ['logs', { lines: 2001 }], ['logs', { lines: -1 }],
    ['monitor', { seconds: 21 }], ['monitor', { seconds: .5 }], ['monitor', { seconds: null }],
    ['command', { command: 'quit\n' }], ['command', { command: 'unknown' }],
    ['command', { command: 'issue_report', notes: 'x'.repeat(8001) }],
    ['sources', { kind: '__proto__' }], ['sources', { kind: {} }], ['status', { full: 'true' }]
  ];
  for (let round = 0; round < 4; round++) {
    for (let index = 0; index < invalid.length; index++) {
      const [name, args] = invalid[(index * 7 + round) % invalid.length];
      check(`invalid-tool-${round}-${index}`, await rejected(client, name, args));
    }
    check('status-after-invalid-input-' + round, value(await call(client, 'status')).pid === app.pid);
  }
  await call(client, 'command', { command: 'quit' });
  check('owned-app-quit', !alive(app.pid));

  // Attach to a separately launched real app to exercise discovery validation.
  const externalPath = path.join(report, 'external-control.json');
  const external = spawn(publisher, ['--local-control', '--local-control-port=0', '--local-control-discovery=' + externalPath],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: report, GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING: '1' } });
  external.on('error', error => { failure = String(error); });
  observedPids.add(external.pid);
  let externalDiscovery;
  for (let i = 0; i < 150; i++) {
    try { externalDiscovery = JSON.parse(await readFile(externalPath, 'utf8')); break; } catch { await delay(100); }
  }
  if (!externalDiscovery) throw Error('External app did not start');
  check('attach-real-app', value(await call(client, 'attach', { discovery: externalPath })).pid === external.pid);
  const badDiscoveries = [
    ['invalid-json', '{'], ['null', 'null'], ['array', '[]'],
    ['missing-token', JSON.stringify({ ...externalDiscovery, token: '' })],
    ['wrong-token', JSON.stringify({ ...externalDiscovery, token: 'wrong' })],
    ['stale-pid', JSON.stringify({ ...externalDiscovery, pid: external.pid + 1 })],
    ...['https://127.0.0.1:9', 'http://localhost:9', 'http://example.com:9',
      'http://127.0.0.1:9@localhost:9', 'http://127.0.0.1:9/path',
      'http://127.0.0.1:9/?token=secret', 'http://127.0.0.1:9/#fragment'].map((base_url, i) =>
      ['invalid-url-' + i, JSON.stringify({ ...externalDiscovery, base_url })]),
    ['oversized-discovery', JSON.stringify({ ...externalDiscovery, padding: 'x'.repeat(128 * 1024) })]
  ];
  for (const [name, contents] of badDiscoveries) {
    const filename = path.join(report, name + '.json');
    await writeFile(filename, contents);
    check(name, await rejected(client, 'attach', { discovery: filename }));
    check(name + '-preserves-target', value(await call(client, 'status')).pid === external.pid);
  }
  const bom = path.join(report, 'bom-discovery.json');
  await writeFile(bom, '\ufeff' + JSON.stringify(externalDiscovery));
  const attachment = await call(client, 'attach', { discovery: bom });
  check('bom-discovery-supported', !attachment.isError);
  check('token-not-in-attachment-output', !JSON.stringify(attachment).includes(externalDiscovery.token));
  const boundary = path.join(report, 'boundary-discovery.json');
  const base = JSON.stringify({ ...externalDiscovery, padding: '' });
  await writeFile(boundary, JSON.stringify({ ...externalDiscovery, padding: 'x'.repeat(16 * 1024 - Buffer.byteLength(base)) }));
  check('discovery-at-size-boundary-supported', !((await call(client, 'attach', { discovery: boundary })).isError));
  await client.close();
  check('attached-app-survives-disconnect', alive(external.pid));
  const closer = await connect('external-cleanup');
  await call(closer, 'attach', { discovery: externalPath });
  await call(closer, 'command', { command: 'quit' });
  await closer.close();

  const streamClient = await connect('stream-under-pressure');
  const source = `MCP edge 'quote' & spaces ${Date.now()}`;
  sender = spawn(senderPath, [`--name=${source}`, '--pattern=alpha-moving-edge', '--width=640', '--height=360', '--fps=30', '--duration-ms=180000'],
    { windowsHide: true, stdio: 'ignore' });
  await delay(1500);
  const stream = 'mcp_edge_' + Date.now();
  const live = value(await call(streamClient, 'launch', { mode: 'stream', source: 'spout', sourceName: source,
    streamId: stream, password: 'false', codec: 'h264', encoder: 'software', width: 640, height: 360, durationSeconds: 120 }));
  observedPids.add(live.pid);
  check('quoted-source-name-real-capture', live.diagnostics.source.has_frame);
  const liveDiscovery = JSON.parse(await readFile(live.discovery, 'utf8'));
  const require = createRequire(import.meta.url);
  browser = await require('playwright').chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto(`https://vdo.ninja/?view=${stream}&password=false&autostart&muted&noaudio`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.videoWidth === 640 && v.currentTime > 1), null, { timeout: 45000 });
  const playback = page.evaluate(async () => {
    const v = [...document.querySelectorAll('video')].find(v => v.videoWidth === 640);
    const start = v.currentTime, frames = v.getVideoPlaybackQuality().totalVideoFrames;
    await new Promise(r => setTimeout(r, 5000));
    return { elapsed: v.currentTime - start, frames: v.getVideoPlaybackQuality().totalVideoFrames - frames };
  });
  const pressure = await Promise.all(Array.from({ length: 8 }, async () => {
    for (let i = 0; i < 32; i++) {
      const response = await fetch(liveDiscovery.base_url + (i % 2 ? '/health' : '/commands'), {
        method: i % 2 ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + liveDiscovery.token },
        ...(i % 2 ? {} : { body: '{broken' }), signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      if (response.status !== (i % 2 ? 200 : 400)) return false;
    }
    return true;
  }));
  check('mixed-http-pressure-while-live', pressure.every(Boolean));
  const decoded = await playback;
  check('browser-decodes-through-pressure', decoded.elapsed > 4 && decoded.frames > 100, decoded);
  await page.screenshot({ path: path.join(report, 'live-pressure.png') });
  const race = await Promise.all([call(streamClient, 'command', { command: 'stop' }),
    call(streamClient, 'monitor', { seconds: 1 }), call(streamClient, 'status')]);
  check('stop-monitor-status-race', race.every(r => !r.isError));
  await streamClient.close();
  check('owned-app-exits-on-disconnect', !alive(live.pid));

  const startupClient = await connect('disconnect-during-startup');
  const sessionDir = path.join(report, 'GameCapture/mcp');
  const previous = new Set(await readdir(sessionDir));
  const pending = call(startupClient, 'launch', { mode: 'stream', source: 'spout', sourceName: 'MCP_edge_missing_sender',
    streamId: 'mcp_cancel_' + Date.now(), durationSeconds: 10 }).catch(() => null);
  for (let i = 0; i < 30; i++) {
    const dirs = (await readdir(sessionDir)).filter(name => !previous.has(name));
    for (const name of dirs) {
      try { observedPids.add(JSON.parse(await readFile(path.join(sessionDir, name, 'control.json'), 'utf8')).pid); } catch {}
    }
    if (dirs.length) { await delay(100); break; }
    await delay(25);
  }
  await startupClient.close();
  await pending;
  await delay(500);
  const remaining = remainingPublishers();
  check('shutdown-leaves-no-owned-publisher', remaining.length === 0, remaining);
} catch (error) {
  failure = String(error.stack || error);
  console.error(failure);
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (browser) await browser.close();
  if (sender && sender.exitCode === null) sender.kill();
  for (const pid of remainingPublishers()) if (alive(pid)) process.kill(pid);
  settings('restore'); restored = true;
  const result = { ok: !failure && checks.every(c => c.passed), error: failure, publisher,
    sha256: createHash('sha256').update(await readFile(publisher)).digest('hex'), settingsRestored: restored, checks };
  await writeFile(path.join(report, 'results.json'), JSON.stringify(result, null, 2));
  console.log('Report: ' + report);
  if (!result.ok) process.exitCode = 1;
}
