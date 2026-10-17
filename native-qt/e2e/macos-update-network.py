#!/usr/bin/env python3
"""Packaged GUI release lookup, warm cache, process-isolated HTTPS failure and relaunch.

Reads the public release API; never publishes, downloads an installer, opens a
release link, changes system networking/trust, or starts media capture.
"""
import argparse
import ast
import configparser
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import time
import urllib.request
import uuid

API = 'https://api.github.com/repos/steveseguin/game-capture/releases/latest'
PROFILE = '(version 1) (allow default) (deny network-outbound (remote ip "*:443"))'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_cache(path):
    config = configparser.ConfigParser(interpolation=None)
    config.optionxform = str
    config.read(path)
    values = config['General']
    encoded = values.get('Release', '')
    if encoded.startswith('"'):
        encoded = ast.literal_eval(encoded)
    assert encoded.startswith('@ByteArray(') and encoded.endswith(')'), 'Unexpected cache encoding'
    return {'attempt': int(values['LastAttempt']), 'success': int(values['LastSuccess']),
            'succeeded': values['LastAttemptSucceeded'] == 'true',
            'release': json.loads(encoded[len('@ByteArray('):-1])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--ui-helper', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    app, helper = args.app.resolve(), args.ui_helper.resolve()
    exe = app / 'Contents/MacOS/game-capture'
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True)
    shutil.copyfile(__file__, report / Path(__file__).name)
    shutil.copyfile(Path(__file__).with_name('macos-ui-control.mm'), report / 'macos-ui-control.mm')
    (report / 'https-denied.sb').write_text(PROFILE + '\n')
    installed = plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']
    result = {'scope': __doc__, 'executableSha256': sha(exe), 'helperSha256': sha(helper),
              'harnessSha256': sha(Path(__file__)), 'installedVersion': installed,
              'cases': [], 'passed': False}
    env = {k: v for k, v in os.environ.items() if not k.startswith(('QT_', 'DYLD_', 'VERSUS_', 'GAME_CAPTURE_'))}
    process = None
    control = None
    logs = []
    settings = report / 'settings'
    settings.mkdir()
    cache = settings / 'update-check.ini'
    discovery = report / 'control.json'

    def save():
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')

    def api(route, body=None):
        request = urllib.request.Request(control['base_url'] + route,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def ui(action, name=None):
        return subprocess.check_output([str(helper), str(process.pid), action, *([name] if name else [])],
                                       text=True, stderr=subprocess.PIPE, timeout=5)

    def rows():
        return json.loads(ui('dump'))

    def field(name):
        return next((r for r in rows() if r.get('AXIdentifier', '').endswith('.' + name)), None)

    def wait(check, message, seconds=25):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            assert process is None or process.poll() is None, 'App exited unexpectedly'
            value = check()
            if value:
                return value
            time.sleep(.15)
        raise AssertionError(message)

    def launch(label, blocked=False):
        nonlocal process, control
        log = (report / (label + '.log')).open('w')
        logs.append(log)
        command = [str(exe), '--settings-dir=' + str(settings), '--local-control',
                   '--local-control-port=0', '--local-control-discovery=' + str(discovery)]
        if blocked:
            command = ['/usr/bin/sandbox-exec', '-f', str(report / 'https-denied.sb'), *command]
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=report, env=env, stdout=log, stderr=subprocess.STDOUT)
        wait(lambda: discovery.exists(), 'Local control did not start')
        control = json.loads(discovery.read_text())
        assert control['pid'] == process.pid
        wait(lambda: field('advancedToggle'), 'GUI not accessible')
        before = int(field('advancedToggle').get('AXValue', 0))
        ui('press', 'advancedToggle')
        wait(lambda: int(field('advancedToggle').get('AXValue', 0)) != before,
             'GUI did not respond during update workflow', 5)
        ui('press', 'advancedToggle')
        wait(lambda: int(field('advancedToggle').get('AXValue', 0)) == before,
             'GUI controls did not restore', 5)
        return started

    def observe(label, expected, link_expected, started, minimum_seconds=0):
        snapshots = []
        def footer_matches():
            # Cocoa can flatten the scroll area's children into the window.
            # The footer remains directly readable through accessibility then.
            scroll = subprocess.run([str(helper), str(process.pid), 'scroll-bottom'],
                                    capture_output=True, timeout=5)
            footer = [r for r in rows() if any(r.get('AXIdentifier', '').endswith('.' + name)
                      for name in ('updateStatusLabel', 'releasesLink'))]
            snapshots.append({'elapsedSeconds': time.monotonic() - started,
                              'scrollActionExit': scroll.returncode, 'footer': footer})
            matched = any(expected in r.values() for r in footer)
            return footer if matched and time.monotonic() - started >= minimum_seconds else None
        footer = wait(footer_matches, label + ': expected footer did not appear')
        links = [r for r in footer if r.get('AXIdentifier', '').endswith('.releasesLink')]
        assert bool(links) == link_expected, 'Incorrect Releases link visibility'
        d = api('/diagnostics')
        assert not d['app']['live'] and not d['app']['capturing'] and not d['source']['has_frame']
        assert d['video']['frames_sent'] == 0 and d['metrics']['audio_packets_sent'] == 0
        entry = {'name': label, 'footerObservations': snapshots, 'captureStayedOff': True,
                 'elapsedSeconds': time.monotonic() - started, 'cache': read_cache(cache),
                 'cacheSha256': sha(cache)}
        result['cases'].append(entry)
        shutil.copyfile(cache, report / (label + '-cache.ini'))
        save()
        return entry

    def stop():
        api('/commands', {'command': 'quit'})
        assert process.wait(timeout=10) == 0, 'App did not quit normally'
        assert not discovery.exists(), 'Discovery file survived quit'

    try:
        print('Reports:', report, flush=True)
        state = json.loads(subprocess.check_output([str(helper), str(os.getpid()), 'session-state'], text=True))
        assert not state['screenLocked'], 'Unlock the Mac for GUI workflows'
        request = urllib.request.Request(API, headers={'Accept': 'application/vnd.github+json',
            'User-Agent': 'game-capture-packaged-qa', 'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.status == 200
            body = response.read(1024 * 1024 + 1)
            assert len(body) <= 1024 * 1024
            result['oracleResponse'] = {'url': response.url, 'date': response.headers.get('Date'),
                                        'etag': response.headers.get('ETag'), 'sha256': hashlib.sha256(body).hexdigest()}
        (report / 'public-release.json').write_bytes(body)
        release = json.loads(body)
        assert release['draft'] is False and release['prerelease'] is False
        tag = release['tag_name']
        assert re.fullmatch(r'v?\d+\.\d+\.\d+', tag), 'Review nonstandard release version before running this workflow'
        version = tag.removeprefix('v')
        compatible = [a for a in release['assets'] if a['name'] in
                      [f'game-capture-macos-arm64-{version}.zip', f'game-capture-macos-arm64-{version}.dmg']
                      and a['state'] == 'uploaded' and a['size'] > 0]
        available = bool(compatible) and tuple(map(int, version.split('.'))) > tuple(map(int, installed.split('.')))
        expected = ('Latest release has no Apple Silicon download' if not compatible else
                    f'New version available: v{version}' if available else 'You’re up to date')
        result['expectedFooter'] = expected
        result['publicReleaseTag'] = tag
        assert not cache.exists(), 'Cold launch must start without an update cache'
        earliest = int(time.time())
        first = observe('cold-online', expected, available, launch('cold-online'))
        assert first['cache']['succeeded'] and first['cache']['attempt'] >= earliest
        assert first['cache']['success'] >= first['cache']['attempt']
        assert first['cache']['release']['tag_name'] == tag, 'Release changed during observation or wrong cache metadata'
        assert bool(first['cache']['release']['assets']) == bool(compatible)
        stop()
        warm = observe('warm-online', expected, available, launch('warm-online'), 7)
        assert warm['cacheSha256'] == first['cacheSha256'], 'Warm cache unexpectedly refreshed'
        stop()

        # Age only this workflow's private cache so the next normal startup
        # refreshes. Retain the real metadata to detect stale-success displays.
        old = int(time.time()) - 86410
        stale = re.sub(r'^LastAttempt=\d+$', f'LastAttempt={old}', cache.read_text(), flags=re.M)
        stale = re.sub(r'^LastSuccess=\d+$', f'LastSuccess={old}', stale, flags=re.M)
        cache.write_text(stale)
        assert read_cache(cache)['attempt'] == old
        earliest = int(time.time())
        started = launch('refresh-https-denied', blocked=True)
        # Startup initially says unavailable too; wait for a completed failed
        # refresh, not that placeholder, before accepting the negative result.
        wait(lambda: read_cache(cache)['attempt'] >= earliest and not read_cache(cache)['succeeded'],
             'Blocked refresh did not record a new attempt')
        failed = observe('refresh-https-denied', 'Update check unavailable', False, started, 7)
        assert not failed['cache']['succeeded']
        assert failed['cache']['release'] == first['cache']['release'], 'Failed refresh destroyed valid metadata'
        assert failed['cache']['success'] == old, 'Failure advanced the success timestamp'
        stop()
        # Normal networking is restored for this new process; the recent failed
        # attempt must retain its honest status and avoid a launch retry loop.
        retained = observe('warm-after-failure', 'Update check unavailable', False,
                           launch('warm-after-failure'), 7)
        assert retained['cacheSha256'] == failed['cacheSha256'], 'Failed-attempt cooldown was not retained'
        stop()
        result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
        if process is not None and process.poll() is None:
            try:
                (report / 'failed-ui.json').write_text(ui('dump'))
            except Exception:
                pass
    finally:
        if process is not None and process.poll() is None:
            try:
                stop()
            except Exception:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        for log in logs:
            log.close()
        save()
        print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
