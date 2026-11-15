"""Qualify six-channel candidate outputs against a private MediaMTX receiver.

Synthetic capture-boundary speech-range tones; real packaged encode, WHIP/SRT
transport and recorded decoding. A 5.1 AAC LFE limitation is a content failure,
not a successful six-voice result. Never changes installed application settings.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import threading
import urllib.error
import urllib.request

import numpy as np
import psutil

p = argparse.ArgumentParser()
p.add_argument('--publisher', required=True)
p.add_argument('--mediamtx', required=True)
p.add_argument('--report', required=True)
p.add_argument('--protocol', choices=('both', 'whip', 'srt'), default='both')
p.add_argument('--whip-stereo', action='store_true', help='Restrict the private WHIP endpoint to ordinary stereo Opus')
args = p.parse_args()
native = Path(__file__).resolve().parent.parent
publisher = Path(args.publisher).resolve()
report = Path(args.report).resolve(); report.mkdir(parents=True, exist_ok=False)
ffmpeg = publisher.parent/'ffmpeg/bin/ffmpeg.exe'
python = native/'.cache/desktop-ui-python/Scripts/python.exe'
frequencies = json.loads((native/'e2e/six-channel-tone-profiles.json').read_text())['voice']
results = {'passed': False, 'syntheticCapture': True, 'frequencies': frequencies, 'stereoOnlyWhipEndpoint': args.whip_stereo,
           'publisherSha256': hashlib.sha256(publisher.read_bytes()).hexdigest(), 'cases': []}
children = []; logs = []; app = None; discovery = None
proxy = None


def port(socket_type=socket.SOCK_STREAM):
    with socket.socket(socket.AF_INET, socket_type) as reserve:
        reserve.bind(('127.0.0.1', 0)); return reserve.getsockname()[1]


def launch(argv, name, directory=report):
    log = (directory/(name+'.log')).open('wb'); logs.append(log)
    process = subprocess.Popen(list(map(str, argv)), stdout=log, stderr=log, cwd=publisher.parent,
        env={**os.environ, 'LOCALAPPDATA': str(directory), 'GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING': '1',
             'GC_AUDIO_TEST_PROFILE': 'voice'}, creationflags=subprocess.CREATE_NO_WINDOW)
    children.append(process); return process


def api(route, body=None):
    d = json.loads(discovery.read_text())
    req = urllib.request.Request(d['base_url']+route, data=json.dumps(body).encode() if body else None,
        headers={'Authorization': 'Bearer '+d['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response: return json.load(response)


def until(check, label, seconds=40):
    end = time.monotonic()+seconds
    while time.monotonic() < end:
        if check(): return
        time.sleep(.2)
    raise AssertionError(label)


def run(argv):
    return subprocess.run(list(map(str, argv)), capture_output=True, timeout=50, creationflags=subprocess.CREATE_NO_WINDOW)


class StereoWhipEndpoint(http.server.BaseHTTPRequestHandler):
    """Forward to real MediaMTX while limiting the endpoint's accepted codec."""
    def forward(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.command == 'POST':
            offer = body.decode()
            excluded = set(re.findall(r'a=rtpmap:(\d+) multiopus/48000/\d+', offer))
            assert excluded, 'Publisher did not offer multiopus'
            lines = []
            for line in offer.splitlines():
                if line.startswith('m=audio '):
                    fields = line.split(); line = ' '.join(fields[:3]+[item for item in fields[3:] if item not in excluded])
                match = re.match(r'a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\b', line)
                if match and match[1] in excluded: continue
                lines.append(line)
            body = ('\r\n'.join(lines)+'\r\n').encode()
            (report/'stereo-endpoint-offer.sdp').write_bytes(body)
        req = urllib.request.Request(f'http://127.0.0.1:{whip}'+self.path, method=self.command,
            data=body if self.command == 'POST' else None, headers={'Content-Type': 'application/sdp'})
        try: response = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as error: response = error
        with response:
            data = response.read(); self.send_response(response.status)
            for key in ('Content-Type', 'Location', 'Link', 'Accept-Patch'):
                if response.headers.get(key): self.send_header(key, response.headers[key])
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    do_OPTIONS = do_POST = do_DELETE = forward
    def log_message(self, *_): pass


try:
    rtsp, srt, whip, udp = port(), port(socket.SOCK_DGRAM), port(), port(socket.SOCK_DGRAM)
    assert len({rtsp, srt, whip, udp}) == 4
    config = report/'receiver.yml'
    config.write_text(f'logLevel: warn\nrtspAddress: 127.0.0.1:{rtsp}\nrtspTransports: [tcp]\nrtmp: false\nsrtAddress: 127.0.0.1:{srt}\nhls: false\nmoq: false\nwebrtcAddress: 127.0.0.1:{whip}\nwebrtcLocalUDPAddress: 127.0.0.1:{udp}\nwebrtcIPsFromInterfaces: false\nwebrtcAdditionalHosts: [127.0.0.1]\npaths:\n  all_others:\n')
    mtx = launch([Path(args.mediamtx).resolve(), config], 'mediamtx')
    source = launch([python, native/'e2e/six-channel-source.py'], 'source')
    until(lambda: 'SIX_CHANNEL_SOURCE_READY' in (report/'source.log').read_text(errors='replace'), 'Source ready')
    assert mtx.poll() is None and source.poll() is None
    if args.whip_stereo:
        proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), StereoWhipEndpoint)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
    for protocol in (('whip', 'srt') if args.protocol == 'both' else (args.protocol,)):
        case = {'protocol': protocol, 'passed': False}; results['cases'].append(case)
        directory = report/protocol; directory.mkdir(); discovery = directory/'control.json'
        destination = f'http://127.0.0.1:{proxy.server_port if proxy else whip}/six-whip/whip' if protocol == 'whip' else f'srt://127.0.0.1:{srt}'
        extra = [] if protocol == 'whip' else ['--srt-stream-id=publish:six-srt']
        app = launch([python, native/'e2e/six-channel-instrumented-launch.py', publisher,
            '--headless', '--source=window', '--window=Game Capture Six Channel Source',
            '--audio-source=selected-window', '--audio-channels=6', '--audio-bitrate-kbps=384', '--no-audio-red',
            '--resolution=640x360', '--fps=30', '--video-encoder=software', '--video-codec=h264',
            '--output='+protocol, '--output-url='+destination, '--aac-bitrate-kbps=320', *extra,
            '--ice-mode=host', '--duration-ms=90000', '--local-control', '--local-control-discovery='+str(discovery)], 'publisher', directory)
        try:
            until(lambda: app.poll() is not None or (discovery.exists() and api('/diagnostics').get('output', {}).get('state') == 2), 'Publisher live')
            assert app.poll() is None, (directory/'publisher.log').read_text(errors='replace')[-1200:]
            assert 'synthetic-six-channel-capture' in (directory/'publisher.log').read_text(errors='replace')
            if protocol == 'whip':
                # FFmpeg's RTSP demuxer does not identify this multichannel
                # Opus payload. Decode the real WHEP path in Chrome instead.
                received = run(['node', native/'e2e/six-channel-whep-receiver.js',
                    f'--url=http://127.0.0.1:{whip}/six-whip/whep', '--output='+str(directory/'browser.json'),
                    '--channels='+('2' if args.whip_stereo else '6')])
                browser_result = json.loads((directory/'browser.json').read_text())
                case.update(receiver=browser_result, passed=browser_result['passed'],
                    decodedChannels=browser_result.get('channels'), behavior='stereo-fallback' if args.whip_stereo else 'six-channel-WHEP',
                    diagnostics=api('/diagnostics').get('output'))
                assert received.returncode == 0, received.stdout.decode(errors='replace')
                continue
            for attempt in range(10):
                output = directory/f'received-{attempt}.mkv'
                received = run([ffmpeg, '-v', 'error', '-n', '-rtsp_transport', 'tcp', '-i',
                    f'rtsp://127.0.0.1:{rtsp}/six-{protocol}', '-t', '8', '-map', '0', '-c', 'copy', output])
                if received.returncode == 0: break
                if b'404' not in received.stderr: break
                time.sleep(.3)
            assert received.returncode == 0, received.stderr
            info = run([ffmpeg, '-hide_banner', '-i', output]).stderr.decode(errors='replace')
            (directory/'metadata.txt').write_text(info)
            decoded = run([ffmpeg, '-v', 'error', '-i', output, '-map', '0', '-fps_mode:v', 'passthrough',
                '-enc_time_base:v', '1:1000000', '-f', 'null', '-'])
            assert decoded.returncode == 0 and not decoded.stderr, decoded.stderr
            # Preserve native channels in the raw output; FFmpeg's output header
            # supplies the actual channel count instead of relying on labels.
            raw = run([ffmpeg, '-hide_banner', '-i', output, '-ss', '3', '-map', '0:a:0', '-t', '1', '-ar', '48000', '-f', 'f32le', '-'])
            assert raw.returncode == 0, raw.stderr
            count = len(raw.stdout)//(48000*4)
            assert count in (2, 6) and len(raw.stdout) == count*48000*4, (count, len(raw.stdout))
            samples = np.frombuffer(raw.stdout, np.float32).reshape(-1, count)
            reference = np.exp(-2j*np.pi*np.array(frequencies)[:, None]*np.arange(48000)[None, :]/48000)
            matrix = (abs(reference@samples)*2/48000).T.tolist()
            missing = [n+1 for n in range(6) if (matrix[n][n] if count == 6 else max(row[n] for row in matrix)) < .003]
            leakage = [] if count == 2 else [n+1 for n in range(6) if matrix[n][n] > .003 and
                max(value for other, value in enumerate(matrix[n]) if n != other) > matrix[n][n]*.1]
            case.update(decodedChannels=count, matrix=matrix, missingSourceSlots=missing, crosstalkSlots=leakage,
                actualAudioDescription=next(line.strip() for line in info.splitlines() if 'Audio:' in line),
                fullDecode='clean', recording=output.name, recordingSha256=hashlib.sha256(output.read_bytes()).hexdigest(),
                diagnostics=api('/diagnostics').get('output'), passed=not missing and not leakage)
            case['behavior'] = 'six-channel-AAC' if count == 6 else 'stereo-fallback'
        except Exception as error:
            case['error'] = str(error)
        finally:
            if app.poll() is None:
                api('/commands', {'command': 'quit'}); app.wait(timeout=20)
            case['cleanExit'] = app.returncode == 0
            case['passed'] = case['passed'] and case['cleanExit']
            print(json.dumps({key: case.get(key) for key in ('protocol', 'passed', 'behavior', 'decodedChannels', 'missingSourceSlots', 'cleanExit', 'error')}), flush=True)
    results['passed'] = all(case['passed'] for case in results['cases'])
finally:
    if proxy: proxy.shutdown(); proxy.server_close()
    for process in reversed(children):
        if process.poll() is None:
            descendants = psutil.Process(process.pid).children(recursive=True)
            process.terminate(); process.wait(timeout=15)
            for child in descendants:
                try: child.kill()
                except psutil.NoSuchProcess: pass
            psutil.wait_procs(descendants, timeout=5)
    for log in logs: log.close()
    (report/'results.json').write_text(json.dumps(results, indent=2))
assert results['passed'], 'At least one external output did not preserve all six sources; see results.json'
