#!/usr/bin/env python3
"""Capture the actual packaged GUI's owned-source previews at controlled cursor positions.

This performs source selection and retains native screenshots. Pixel qualification
is a separate review of those screenshots; workflow success alone is insufficient.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
for name in ['app', 'fixture', 'ui-helper', 'reports']:
    parser.add_argument('--' + name, type=Path, required=True)
args = parser.parse_args()
report = args.reports.resolve() / str(uuid.uuid4())
report.mkdir(parents=True)
exe = args.app.resolve() / 'Contents/MacOS/game-capture'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
result = dict(scope=__doc__, started=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              executableSha256=sha(exe), fixtureSha256=sha(args.fixture),
              fixtureSourceSha256=sha(Path(__file__).with_name('macos-cursor-fixture.mm')),
              harnessSha256=sha(Path(__file__)), uiHelperSha256=sha(args.ui_helper),
              uiHelperSourceSha256=sha(Path(__file__).with_name('macos-ui-control.mm')),
              phases=[], finished=False, workflowPassed=False, pixelReviewPending=True)
children = []
logs = []


def save():
    (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')


def wait(predicate, seconds, message):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError(message)


def launch(command, label):
    env = {k: v for k, v in os.environ.items() if not k.startswith(
        ('QT_', 'DYLD_', 'VERSUS_', 'GAME_CAPTURE_', 'GH_', 'GITHUB_', 'ACTIONS_'))}
    log = (report / (label + '.log')).open('wb')
    logs.append(log)
    child = subprocess.Popen([str(x) for x in command], env=env, stdin=subprocess.PIPE,
                             stdout=log, stderr=subprocess.STDOUT)
    children.append(child)
    return child


def messages():
    rows = []
    for line in (report / 'fixture.log').read_text().splitlines():
        if line.startswith('{'):
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def fixture_command(command, key, value=True):
    start = len(messages())
    assert source.poll() is None, 'Fixture exited'
    source.stdin.write((command + '\n').encode())
    source.stdin.flush()
    return wait(lambda: next((r for r in messages()[start:] if r.get(key) == value), None),
                5, 'Fixture response missing: ' + command)


def ui(action, query=None):
    command = [str(args.ui_helper), str(publisher.pid), action]
    if query is not None:
        command.append(query)
    return subprocess.check_output(command, timeout=10, text=True, stderr=subprocess.PIPE)


def api(route, body=None):
    request = urllib.request.Request(control['base_url'] + route,
        data=json.dumps(body).encode() if body else None,
        headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def verify_state(state, mode):
    assert state['inside'] and state['atControlledPoint'] and state['mode'] == mode
    assert abs(state['localX'] - (80 if mode == 'transparent' else 480)) <= 2
    assert abs(state['localY'] - 90) <= 2


save()
(report / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
for name in ['macos-ui-control.mm', 'macos-cursor-fixture.mm']:
    (report / name).write_bytes(Path(__file__).with_name(name).read_bytes())
print(str(report), flush=True)
source = publisher = None
try:
    title = 'Mac Cursor Preview ' + uuid.uuid4().hex[:12]
    source = launch([args.fixture, title], 'fixture')
    result['fixture'] = wait(lambda: next((r for r in messages() if r.get('ready')), None), 10, 'Fixture not ready')
    discovery = report / 'control.json'
    publisher = launch([exe, '--temporary-settings', '--local-control', '--local-control-port=0',
                        '--local-control-discovery=' + str(discovery)], 'publisher')
    wait(lambda: discovery.exists(), 15, 'Packaged GUI discovery missing')
    control = json.loads(discovery.read_text())
    assert control['pid'] == publisher.pid
    ui('activate')

    def filter_ready():
        try:
            rows = json.loads(ui('dump'))
            return any(str(r.get('AXIdentifier', '')).endswith('.sourceFilterInput') for r in rows)
        except subprocess.CalledProcessError:
            return False

    wait(filter_ready, 15, 'Packaged GUI source filter not ready')
    subprocess.run([str(args.ui_helper), str(publisher.pid), 'set', 'sourceFilterInput', title],
                   check=True, capture_output=True, timeout=10)

    def actionable():
        try:
            ui('source-ready', title)
            return True
        except subprocess.CalledProcessError:
            return False

    wait(actionable, 15, 'Owned source row not actionable')
    ui('select-source', title)
    ui('verify-selected', title)
    # The list retries a missing asynchronous thumbnail every fourth 3s refresh.
    # Do not press Refresh: that would hide a failure of the normal idle retry.
    time.sleep(15)
    for mode in ['park', 'transparent', 'opaque']:
        phase = dict(mode=mode)
        result['phases'].append(phase)
        phase['command'] = fixture_command(mode, 'command', mode)
        assert phase['command']['warpError'] == 0
        # The preview timer is 1.5 seconds; allow two refresh opportunities.
        time.sleep(3.5)
        phase['before'] = fixture_command('state', 'state')
        verify_state(phase['before'], mode)
        ui('activate')
        ui('verify-selected', title)
        rows = json.loads(ui('dump'))
        (report / (mode + '-accessibility.json')).write_text(json.dumps(rows, indent=2) + '\n')
        phase['windowBounds'] = json.loads(ui('window-bounds'))
        phase['previewBounds'] = json.loads(ui('bounds', 'selectedPreview'))
        phase['sourceListBounds'] = json.loads(ui('bounds', 'sourceList'))
        try:
            phase['thumbnailBounds'] = json.loads(ui('bounds', 'thumbnail'))
        except subprocess.CalledProcessError:
            phase['thumbnailBounds'] = None
        window_id = ui('window').strip()
        assert window_id.isdigit()
        image = report / (mode + '.png')
        subprocess.run(['/usr/sbin/screencapture', '-x', '-o', '-l', window_id, str(image)],
                       check=True, capture_output=True, timeout=10)
        phase['screenshot'] = dict(path=image.name, sha256=sha(image))
        source_image = report / (mode + '-source.png')
        subprocess.run(['/usr/sbin/screencapture', '-x', '-o', '-l', str(result['fixture']['windowId']), str(source_image)],
                       check=True, capture_output=True, timeout=10)
        phase['sourceScreenshot'] = dict(path=source_image.name, sha256=sha(source_image))
        phase['after'] = fixture_command('state', 'state')
        verify_state(phase['after'], mode)
        diagnostics = api('/diagnostics')
        assert not diagnostics['app']['live'] and not diagnostics['app']['capturing']
        phase['publisherStayedIdle'] = True
        save()
    api('/commands', {'command': 'quit'})
    assert publisher.wait(timeout=15) == 0
    assert not discovery.exists()
    fixture_command('quit', 'cleanup')
    assert source.wait(timeout=5) == 0
    result['fixtureCleanup'] = next(r for r in messages() if r.get('cleanup'))
    assert result['fixtureCleanup']['pointerRestored']
    result['workflowPassed'] = True
except Exception as error:
    result['error'] = repr(error)
    if isinstance(error, subprocess.CalledProcessError) and error.stderr:
        result['helperError'] = error.stderr.decode(errors='replace') if isinstance(error.stderr, bytes) else error.stderr
finally:
    if source is not None and source.poll() is None:
        try:
            fixture_command('quit', 'cleanup')
            source.wait(timeout=5)
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            pass
    for child in children:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    for log in logs:
        log.close()
    result['fixtureCleanup'] = next((r for r in messages() if r.get('cleanup')), None) if source is not None else None
    result.update(finished=True, ended=datetime.datetime.now(datetime.timezone.utc).isoformat())
    save()
    print(json.dumps(dict(report=str(report), workflowPassed=result['workflowPassed'],
                         pixelReviewPending=True, error=result.get('error'))))
raise SystemExit(0 if result['workflowPassed'] else 1)
