import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const obsRuntime = require('../../e2e/obs-alpha-runtime.js');
const dir = path.dirname(fileURLToPath(import.meta.url));
const publisher = process.env.GAME_CAPTURE_MCP_EXECUTABLE;
const senderPath = process.env.GAME_CAPTURE_MCP_SPOUT_FIXTURE;
if (!publisher || !senderPath) throw Error('Set GAME_CAPTURE_MCP_EXECUTABLE and GAME_CAPTURE_MCP_SPOUT_FIXTURE to real packaged app/fixture paths.');
const report = path.resolve(dir, '../../qa/reports/mcp-e2e', String(Date.now()));
await mkdir(report, { recursive: true });
const source = `mcp_spout_${Date.now()}`;
const sender = spawn(senderPath, [`--name=${source}`, '--pattern=alpha-moving-edge', '--width=640', '--height=360', '--fps=30', '--duration-ms=300000'], { windowsHide: true, stdio: 'ignore' });
let senderError; sender.on('error', e => senderError = e);
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(dir, 'server.mjs')],
  env: { ...process.env, GAME_CAPTURE_MCP_EXECUTABLE: path.resolve(publisher) }, stderr: 'pipe' });
const client = new Client({ name: 'packaged-game-capture-e2e', version: '1.0.0' });
let browser, obs, attachedProcess; const evidence = [];
async function call(name, args = {}, expectError = false) {
  const result = await client.callTool({ name: `game_capture_${name}`, arguments: args }, undefined, { timeout: 45000 });
  if (expectError) { assert.equal(result.isError, true); return result; }
  assert(!result.isError, JSON.stringify(result.content));
  return result.structuredContent || JSON.parse(result.content[0].text);
}
async function playing(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.videoWidth === 640 && v.videoHeight === 360 && v.readyState >= 2 && v.currentTime > 1), { timeout: 45000 });
  return page.evaluate(async () => {
    const v = [...document.querySelectorAll('video')].find(v => v.videoWidth === 640 && v.videoHeight === 360);
    const start = v.currentTime, frames = v.getVideoPlaybackQuality().totalVideoFrames;
    await new Promise(r => setTimeout(r, 3000));
    return { width: v.videoWidth, height: v.videoHeight, elapsed: v.currentTime - start,
      frames: v.getVideoPlaybackQuality().totalVideoFrames - frames };
  });
}
try {
  await delay(1500); if (senderError) throw senderError;
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 9);
  assert.equal((await call('firewall')).ok, true);
  const inspection = await call('launch'); assert.equal(inspection.mode, 'inspect');
  const contract = await call('schema'); assert.equal(contract.health.version, '0.2.57');
  for (const kind of ['windows', 'cameras', 'spout', 'audio-inputs']) {
    const data = await call('sources', { kind }); assert(Array.isArray(data.sources));
    if (kind === 'spout') assert(data.sources.some(s => s.name.includes(source)));
  }
  assert((await call('logs')).lines.length > 0);
  const issue = await call('command', { command: 'issue_report', notes: 'MCP packaged E2E inspection' });
  assert(JSON.parse(await readFile(issue.path, 'utf8')));
  await call('command', { command: 'quit' });
  await call('launch', { mode: 'stream' }, true);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const codec of ['h264', 'vp9']) {
    const stream = `mcp_${codec}_${Date.now()}`;
    const started = await call('launch', { mode: 'stream', source: 'spout', sourceName: source, streamId: stream,
      password: 'false', codec, encoder: 'software', width: 640, height: 360, fps: 30, alpha: codec === 'vp9', durationSeconds: 120 });
    assert(started.diagnostics.app.live && started.diagnostics.source.has_frame);
    await call('launch', {}, true);
    const page = await browser.newPage();
    await page.goto(`https://vdo.ninja/?view=${stream}&password=false&autostart&muted&noaudio`, { waitUntil: 'domcontentloaded' });
    const first = await playing(page); assert(first.frames > 45 && first.elapsed > 2);
    const status = await call('status'); assert(status.diagnostics.app.live);
    const samples = await call('monitor', { seconds: 2 }); assert.equal(samples.samples.length, 3);
    if (codec === 'vp9' && process.env.GAME_CAPTURE_MCP_OBS_RUNTIME) {
      obs = await obsRuntime.start({ repo: process.env.GAME_CAPTURE_MCP_OBS_RUNTIME, stream,
        output: path.join(report, 'obs'), expectedPluginHash: process.env.GAME_CAPTURE_MCP_PLUGIN_SHA256,
        width: 640, height: 360, fps: 30, alpha: true });
      await obs.sample('mcp-start-alpha');
      await obs.recordCadence(path.join(path.dirname(publisher), 'ffmpeg/bin/ffmpeg.exe'), 4000);
    }
    const recovery = await call('command', { command: 'refresh_peer_transports' }); assert(recovery.accepted_peer_count > 0);
    await delay(5000);
    const recovered = await playing(page); assert(recovered.frames > 45 && recovered.elapsed > 2);
    if (obs) { await obs.sample('mcp-recovered-alpha'); await obs.close(); obs = undefined; }
    await call('command', { command: 'stop' });
    let stopped;
    for (let i = 0; i < 30; i++) { stopped = await call('status'); if (!stopped.diagnostics.app.live && !stopped.diagnostics.app.capturing) break; await delay(200); }
    assert(!stopped.diagnostics.app.live && !stopped.diagnostics.app.capturing);
    const exp = await call('command', { command: 'export_diagnostics' }); assert(JSON.parse(await readFile(exp.path, 'utf8')));
    await call('command', { command: 'quit' }); await page.close();
    evidence.push({ codec, alpha: codec === 'vp9', first, recovered, stopped: true });
    console.log(`PASS ${codec}: real playback, monitor, transport recovery, stop, export, quit`);
  }
  await call('launch', { mode: 'stream', source: 'spout', sourceName: 'MCP_missing_sender_938671', streamId: source }, true);
  const final = await call('launch', { mode: 'stream', source: 'spout', sourceName: source, streamId: `mcp_disconnect_${Date.now()}`, audio: 'none', durationSeconds: 30 });
  await client.close();
  let exited = false;
  for (let i = 0; i < 50; i++) { try { process.kill(final.pid, 0); } catch { exited = true; break; } await delay(100); }
  assert(exited, 'Owned publisher must exit when MCP disconnects');
  const attachedDiscovery = path.join(report, 'attached-control.json');
  attachedProcess = spawn(publisher, ['--local-control', '--local-control-port=0', `--local-control-discovery=${attachedDiscovery}`],
    { windowsHide: true, stdio: 'ignore' });
  let attachedError; attachedProcess.on('error', e => attachedError = e);
  let discovery;
  for (let i = 0; i < 100; i++) {
    if (attachedError) throw attachedError;
    try { discovery = JSON.parse(await readFile(attachedDiscovery, 'utf8')); break; } catch { await delay(100); }
  }
  assert(discovery);
  const attachedClient = new Client({ name: 'attachment-e2e', version: '1.0.0' });
  try {
    await attachedClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(dir, 'server.mjs')], stderr: 'pipe' }));
    const attachment = await attachedClient.callTool({ name: 'game_capture_attach', arguments: { discovery: attachedDiscovery } });
    assert(!attachment.isError);
    assert(!JSON.stringify(attachment).includes(discovery.token), 'Bearer token must not enter MCP output');
    assert.equal(attachment.structuredContent.pid, attachedProcess.pid);
    const invalid = path.join(report, 'remote-discovery.json');
    await writeFile(invalid, JSON.stringify({ ...discovery, base_url: 'http://example.com:1234' }));
    const rejected = await attachedClient.callTool({ name: 'game_capture_attach', arguments: { discovery: invalid } });
    assert(rejected.isError, 'Non-loopback discovery must be rejected');
  } finally { await attachedClient.close(); }
  process.kill(attachedProcess.pid, 0); // An attached app must survive MCP disconnect.
  await fetch(discovery.base_url + '/commands', { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'quit' }) });
  await writeFile(path.join(report, 'results.json'), JSON.stringify({ publisher: path.resolve(publisher), evidence, disconnectCleanup: exited, attachedProcessPreserved: true }, null, 2));
  console.log(`PASS MCP discovery/source/report/error/ownership workflows. Report: ${report}`);
} finally {
  await client.close().catch(() => {});
  if (obs) await obs.close();
  if (browser) await browser.close();
  if (attachedProcess && attachedProcess.exitCode === null && attachedProcess.signalCode === null) attachedProcess.kill();
  if (sender.exitCode === null && sender.signalCode === null) sender.kill();
}
