#!/usr/bin/env python3
"""Packaged Linux update footer, cache migration/relaunch, HTTPS and failed refresh.

Run under linux-private-desktop.py on owned Xvfb. Future-release cases seed only
the private QSettings cache; they do not represent published Linux releases.
The production endpoint, TLS trust and executable are unchanged. Failure uses
an HTTP proxy scoped to the child process. No installer is downloaded or run.
"""
import argparse
import ast
import configparser
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

from PIL import ImageGrab

API = 'https://api.github.com/repos/steveseguin/game-capture/releases/latest'
MISSING = 'Latest release has no compatible Linux download'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_cache(path):
    config = configparser.ConfigParser(interpolation=None)
    config.optionxform = str
    config.read(path)
    values = config['General']
    encoded = values['Release']
    if encoded.startswith('"'):
        encoded = ast.literal_eval(encoded)
    assert encoded.startswith('@ByteArray(') and encoded.endswith(')')
    return {'attempt': int(values['LastAttempt']), 'success': int(values['LastSuccess']),
            'succeeded': values['LastAttemptSucceeded'] == 'true',
            'release': json.loads(encoded[len('@ByteArray('):-1])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publisher', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    assert os.getuid() != 0 and os.environ.get('GC_QA_PRIVATE_DESKTOP')
    assert os.environ.get('QT_QPA_PLATFORM') == 'xcb'
    exe = args.publisher.resolve(); bundle = exe.parent.parent.parent
    manifest_path = bundle / 'release-artifact-manifest.json'
    assert sha(manifest_path) == args.manifest_sha256
    manifest = json.loads(manifest_path.read_text())
    assert sha(exe) == manifest['artifact']['sha256']
    for entry in manifest['payload']['files']:
        file = (bundle / entry['relativePath']).resolve()
        assert file.is_relative_to(bundle) and file.stat().st_size == entry['size'] and sha(file) == entry['sha256']
    report = args.reports.resolve() / str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    helper = Path(__file__).with_name('linux-ui-control.py')
    for source in [Path(__file__), helper]: shutil.copyfile(source, report/source.name)
    settings = report/'private-settings'; settings.mkdir()
    cache = settings/'update-check.ini'; discovery = report/'private-control.json'
    result = {'scope': __doc__, 'passed': False, 'cases': [], 'proxyRequests': [],
              'executableSha256': sha(exe), 'manifestSha256': sha(manifest_path),
              'harnessSha256': sha(__file__), 'helperSha256': sha(helper)}
    process = control = None; logs = []
    env = dict(os.environ)
    for name in list(env):
        if name.lower().endswith('_proxy'): env.pop(name)
    # Local control must remain direct even when the child uses a failure proxy.
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    class RejectProxy(http.server.BaseHTTPRequestHandler):
        def do_CONNECT(self):
            result['proxyRequests'].append({'method': 'CONNECT', 'target': self.path})
            self.send_error(503, 'Owned QA proxy rejects this connection')
        def log_message(self, *args): pass

    proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), RejectProxy)
    proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True); proxy_thread.start()

    def save(): (report/'results.json').write_text(json.dumps(result, indent=2)+'\n')
    def wait(check, message, seconds=25):
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            assert process is None or process.poll() is None, 'App exited unexpectedly'
            value = check()
            if value: return value
            time.sleep(.15)
        raise AssertionError(message)
    def ui(*args):
        return subprocess.check_output([sys.executable, str(helper), str(process.pid), *args], text=True, timeout=12)
    def api(route):
        request = urllib.request.Request(control['base_url']+route,
            headers={'Authorization': 'Bearer '+control['token']})
        with direct.open(request, timeout=5) as response: return json.load(response)
    def seed(release):
        now = int(time.time())
        encoded = json.dumps('@ByteArray('+json.dumps(release, separators=(',', ':'))+')')
        cache.write_text(f'[General]\nLastAttempt={now}\nLastSuccess={now}\nLastAttemptSucceeded=true\nRelease={encoded}\n')
        assert read_cache(cache)['release'] == release
    def launch(label, blocked=False):
        nonlocal process, control
        child_env = dict(env)
        if blocked:
            address = f'http://127.0.0.1:{proxy.server_port}'
            child_env.update(http_proxy=address, https_proxy=address, HTTP_PROXY=address, HTTPS_PROXY=address)
        log = (report/(label+'.log')).open('w'); logs.append(log)
        process = subprocess.Popen([str(exe), '--settings-dir='+str(settings), '--local-control',
            '--local-control-port=0', '--local-control-discovery='+str(discovery)], env=child_env,
            stdout=log, stderr=log)
        wait(discovery.exists, 'Missing local-control discovery')
        control = json.loads(discovery.read_text()); assert control['pid'] == process.pid
        ui('activate')
        ui('press', 'Show advanced settings'); ui('press', 'Show advanced settings')
    def observe(label, expected, available=False, hold=0):
        started = time.monotonic()
        observations = []
        def matched():
            rows = json.loads(ui('dump'))
            names = [r['name'] for r in rows if r['role'] == 'label']
            observations.append({'elapsedSeconds': time.monotonic()-started,
                                 'footer': [n for n in names if 'update' in n.lower() or 'release' in n.lower() or 'version available' in n.lower()]})
            return rows if expected in names and time.monotonic()-started >= hold else None
        rows = wait(matched, 'Expected footer missing: '+expected)
        assert any(r['name'] == 'Releases' and 'visible' in r['states'] for r in rows) == available, 'Incorrect Releases link visibility'
        bounds = json.loads(ui('footer', expected))
        ImageGrab.grab().save(report/(label+'.png'))
        diagnostic = api('/diagnostics')
        assert not diagnostic['app']['live'] and not diagnostic['app']['capturing']
        assert not diagnostic['source']['has_frame'] and diagnostic['video']['frames_sent'] == 0
        assert diagnostic['metrics']['audio_packets_sent'] == 0
        entry = {'name': label, 'expected': expected, 'observations': observations, 'visibleFooter': bounds,
                 'releaseLinkPresent': available, 'captureStayedOff': True, 'cache': read_cache(cache),
                 'cacheSha256': sha(cache)}
        result['cases'].append(entry); shutil.copyfile(cache, report/(label+'-cache.ini')); save()
        return entry
    def stop():
        nonlocal process, control
        ui('quit-menu'); assert process.wait(timeout=10) == 0
        assert not discovery.exists(); process = control = None

    try:
        print('Report:', report, flush=True)
        release = {'tag_name': 'v99.0.0', 'draft': False, 'prerelease': False}
        seed(release); launch('old-version-only-cache')
        original = sha(cache)
        observe('old-version-only-cache', MISSING, hold=6)
        assert sha(cache) == original; stop()
        name = 'game-capture-99.0.0~linux.2-amd64-0123456789ab-abcdef012345.deb'
        asset = {'name': name, 'size': 1000, 'state': 'uploaded',
                 'browser_download_url': 'https://github.com/steveseguin/game-capture/releases/download/v99.0.0/'+name}
        release['assets'] = [asset]; seed(release)
        for label in ['compatible-cache', 'compatible-cache-relaunch']:
            launch(label); observe(label, 'New version available: v99.0.0', True, hold=6)
            assert read_cache(cache)['release'] == release; stop()
        for label, altered in [('wrong-architecture', {**asset, 'name': name.replace('amd64', 'arm64')}),
                               ('untrusted-asset-url', {**asset, 'browser_download_url': 'https://example.com/'+name})]:
            seed({**release, 'assets': [altered]}); launch(label)
            observe(label, MISSING); stop()
        cache.unlink()
        request = urllib.request.Request(API, headers={'User-Agent': 'game-capture-packaged-qa',
            'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
        with direct.open(request, timeout=20) as response:
            body = response.read(1024*1024+1); assert len(body) <= 1024*1024
            result['oracle'] = {'url': response.url, 'etag': response.headers.get('ETag'), 'sha256': hashlib.sha256(body).hexdigest()}
        (report/'public-release.json').write_bytes(body)
        public = json.loads(body)
        assert not any(a['name'].endswith('.deb') for a in public['assets']), 'Public Linux release changed; update cold-release oracle'
        launch('cold-online'); wait(cache.exists, 'No update cache')
        wait(lambda: read_cache(cache)['succeeded'] if 'Release="@ByteArray({' in cache.read_text() else False,
             'No successful release lookup')
        cold = observe('cold-online', MISSING)
        assert cold['cache']['release']['tag_name'] == public['tag_name']
        assert cold['cache']['release']['assets'] == []; stop()
        launch('warm-online'); warm = observe('warm-online', MISSING, hold=6)
        assert warm['cacheSha256'] == cold['cacheSha256']; stop()
        old = int(time.time())-86410
        stale = re.sub(r'^LastAttempt=\d+$', f'LastAttempt={old}', cache.read_text(), flags=re.M)
        cache.write_text(re.sub(r'^LastSuccess=\d+$', f'LastSuccess={old}', stale, flags=re.M))
        launch('failed-refresh', blocked=True)
        wait(lambda: result['proxyRequests'], 'App did not use owned failure proxy')
        failed = observe('failed-refresh', 'Update check unavailable', hold=6)
        assert not failed['cache']['succeeded'] and failed['cache']['attempt'] > old
        assert failed['cache']['success'] == old and failed['cache']['release'] == cold['cache']['release']; stop()
        launch('warm-after-failure'); retained = observe('warm-after-failure', 'Update check unavailable', hold=6)
        assert retained['cacheSha256'] == failed['cacheSha256']; stop()
        result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
        if process and process.poll() is None:
            try:
                (report/'failure-ui.json').write_text(ui('dump')); ui('footer')
                ImageGrab.grab().save(report/'failure.png')
            except Exception: pass
    finally:
        if process and process.poll() is None:
            try: stop()
            except Exception:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
        proxy.shutdown(); proxy.server_close(); proxy_thread.join(timeout=3)
        for log in logs: log.close()
        save(); print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
