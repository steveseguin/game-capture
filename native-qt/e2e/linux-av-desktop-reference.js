'use strict';
// Diagnostic reference only. Capture the owned X11 drawable and its dedicated
// Pulse monitor using one wall-clock origin. Independent calibration is required
// before this reference can qualify application A/V timing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const {spawn, execFileSync} = require('child_process');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function record(file, {pid, title, sink, moduleId, env}) {
  assert.equal(process.platform, 'linux');
  assert(env.GC_QA_PRIVATE_DESKTOP && env.DISPLAY, 'Requires owned X11 desktop');
  assert(Number.isSafeInteger(pid) && pid > 1);
  assert.equal(fs.statSync('/proc/' + pid).uid, process.getuid());
  assert(/^Owned Linux Capture AV [a-f0-9]{16}$/.test(title));
  assert(/^gc_av_[a-f0-9]{16}$/.test(sink));
  assert.equal(sink.slice(6), title.slice(-16));
  const run = (exe, args) => execFileSync(exe, args, {env, encoding:'utf8', timeout:5000}).trim();
  // The pactl JSON module inventory can omit indices. The short inventory
  // includes the explicit ID returned by load-module, name and argument fields.
  // PipeWire modules can have multiline arguments; select only record headers.
  const modules = run('pactl', ['list', 'short', 'modules']).split('\n').filter(line => /^\d+\t/.test(line)).map(line => {
    const [index, name, argument] = line.split('\t');
    assert(name && typeof argument === 'string');
    return {index, name, argument};
  });
  const owned = modules.find(m => String(m.index) === String(moduleId));
  assert(owned && owned.name === 'module-null-sink');
  assert(owned.argument.split(/\s+/).includes('sink_name=' + sink));
  const ids = run('xdotool', ['search', '--onlyvisible', '--pid', String(pid)]).split(/\s+/);
  const windows = ids.filter(id => {
    assert(/^\d+$/.test(id));
    const name = run('xdotool', ['getwindowname', id]);
    return name === title || name === title + ' - Google Chrome';
  });
  assert.equal(windows.length, 1, 'Need one exact owned source window');
  const windowId = windows[0];
  assert.equal(Number(run('xdotool', ['getwindowpid', windowId])), pid);
  const geometry = Object.fromEntries(run('xdotool', ['getwindowgeometry', '--shell', windowId])
    .split('\n').map(line => line.split('=')));
  const width = Number(geometry.WIDTH), height = Number(geometry.HEIGHT);
  assert(Number.isInteger(width) && width >= 1280 && width <= 1920);
  assert(Number.isInteger(height) && height >= 720 && height <= 1080);
  assert(!fs.existsSync(file));
  const ffmpeg = '/usr/bin/ffmpeg';
  const version = run(ffmpeg, ['-version']).split('\n')[0];
  const ffmpegSha256 = digest(ffmpeg);
  const anchorMs = Date.now();
  // FFmpeg 6.1 xcbgrab uses av_gettime(); pulse uses av_gettime() corrected
  // by the Pulse latency estimate. Preserve both original clocks, subtracting
  // only this common muxer offset. Do not normalize each input separately.
  // https://github.com/FFmpeg/FFmpeg/blob/n6.1/libavdevice/xcbgrab.c
  // https://github.com/FFmpeg/FFmpeg/blob/n6.1/libavdevice/pulse_audio_dec.c
  // https://ffmpeg.org/ffmpeg-formats.html#Format-Options
  const args = ['-hide_banner', '-loglevel', 'info', '-n', '-copyts',
    '-thread_queue_size', '16', '-f', 'x11grab', '-framerate', '60',
    '-draw_mouse', '0', '-window_id', windowId, '-video_size', width + 'x' + height,
    '-i', env.DISPLAY,
    '-thread_queue_size', '128', '-f', 'pulse', '-sample_rate', '48000',
    '-channels', '2', '-fragment_size', '1920', '-i', sink + '.monitor',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-crf', '0', '-threads:v', '2', '-pix_fmt', 'yuv444p',
    '-fps_mode', 'passthrough', '-enc_time_base:v', '1:1000000',
    '-c:a', 'pcm_f32le', '-avoid_negative_ts', 'disabled',
    '-output_ts_offset', (-anchorMs / 1000).toFixed(3),
    '-progress', 'pipe:1', '-nostats', '-f', 'matroska', file];
  const metadata = {path:path.basename(file), scope:'Uncalibrated diagnostic X11 drawable/Pulse sink-monitor reference; lossless H264/PCM, common wall-clock origin; excludes physical display/speaker latency',
    calibrated:false, started:anchorMs, anchorMs, windowId, width, height, sourcePid:pid,
    sink, moduleId:String(moduleId), ffmpegVersion:version, ffmpegSha256, args};
  const logFile = file + '.ffmpeg.log';
  const fd = fs.openSync(logFile, 'wx', 0o600);
  let child;
  try { child = spawn(ffmpeg, args, {env, stdio:['pipe', 'pipe', fd]}); }
  finally { fs.closeSync(fd); }
  let closed = false, exitCode, signal, failure, progress = '', frames = 0, stopPromise;
  child.on('error', error => { failure = error; });
  child.stdin.on('error', error => { failure = error; });
  child.stdout.on('data', data => {
    progress += data.toString();
    const lines = progress.split('\n'); progress = lines.pop();
    for(const line of lines) if(/^frame=\d+$/.test(line)) frames = Number(line.slice(6));
  });
  child.once('close', (code, sig) => { closed = true; exitCode = code; signal = sig; });
  async function waitClosed(ms) {
    const deadline = Date.now() + ms;
    while(!closed && Date.now() < deadline) await sleep(50);
    return closed;
  }
  async function stop() {
    if(stopPromise) return stopPromise;
    stopPromise = (async () => {
      let forced = false;
      try {
        if(!closed) child.stdin.end('q\n');
        if(!await waitClosed(10000)) { forced = true; child.kill('SIGTERM'); }
        if(!await waitClosed(3000)) { forced = true; child.kill('SIGKILL'); }
        assert(await waitClosed(3000), 'Reference process did not exit');
        assert(!forced, 'Reference required forced termination');
        assert(!failure, String(failure));
        assert.equal(exitCode, 0, 'Reference failed; inspect ' + path.basename(logFile));
        assert(frames > 0, 'Reference contained no video frames');
      } finally {
        metadata.ended = Date.now(); metadata.exitCode = exitCode; metadata.signal = signal;
        metadata.frames = frames; metadata.closed = closed;
        if(fs.existsSync(file)) { metadata.bytes = fs.statSync(file).size; metadata.sha256 = digest(file); }
        metadata.logSha256 = digest(logFile);
      }
    })();
    return stopPromise;
  }
  try {
    const deadline = Date.now() + 15000;
    while(frames === 0 && !closed && !failure && Date.now() < deadline) await sleep(50);
    assert(!failure, String(failure));
    assert(!closed && frames > 0, 'Reference did not start; inspect ' + path.basename(logFile));
    metadata.ready = Date.now();
    return {metadata, stop};
  } catch(error) {
    try { await stop(); } catch(cleanupError) { error.cleanupError = String(cleanupError); }
    fs.writeFileSync(file + '.failure.json', JSON.stringify({error:String(error), cleanupError:error.cleanupError, metadata}, null, 2) + '\n', {flag:'wx', mode:0o600});
    throw error;
  }
}

module.exports = {record};
