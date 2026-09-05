"""Verify that two running publishers retain their own diagnostic logs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.request import Request, urlopen
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publisher', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    publisher = args.publisher.resolve()
    if not (publisher.parent / 'platforms/qwindows.dll').is_file():
        raise RuntimeError('A complete packaged application is required')
    run = args.reports.resolve() / uuid.uuid4().hex
    run.mkdir(parents=True)
    processes = []
    results = []

    def request(control, path, body=None):
        req = Request(control['base_url'] + path,
                      data=None if body is None else json.dumps(body).encode(),
                      headers={'Authorization': 'Bearer ' + control['token'],
                               'Content-Type': 'application/json'})
        with urlopen(req, timeout=5) as response:
            return json.load(response)

    def start():
        discovery = run / f'control-{len(processes)}.json'
        process = subprocess.Popen(
            [str(publisher), '--local-control', f'--local-control-discovery={discovery}'],
            env=dict(os.environ, LOCALAPPDATA=str(run)),
            creationflags=subprocess.CREATE_NO_WINDOW)
        processes.append((process, None))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Publisher exited during startup')
            try:
                control = json.loads(discovery.read_text(encoding='utf-8'))
                if request(control, '/health')['pid'] == process.pid:
                    processes[-1] = (process, control)
                    return control
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        raise RuntimeError('Publisher did not become ready')

    def record(name, passed):
        results.append(dict(name=name, passed=passed))
        print(name, passed)

    try:
        first = start()
        first_logs = request(first, '/logs/recent?lines=2000')
        second = start()
        second_logs = request(second, '/logs/recent?lines=2000')
        retained = request(first, '/logs/recent?lines=2000')
        record('publishers-have-separate-logs', first_logs['path'] != second_logs['path'])
        record('first-startup-records-preserved',
               all(line in retained['lines'] for line in first_logs['lines']))
        for name, control, logs in [('first', first, retained), ('second', second, second_logs)]:
            own_marker = 'discovery=' + str(run / ('control-0.json' if name == 'first' else 'control-1.json'))
            # Qt normalizes path separators in log messages on Windows.
            record(name + '-log-identifies-own-session',
                   any(own_marker.replace('\\', '/') in line.replace('\\', '/') for line in logs['lines']))
            report = request(control, '/commands', {'command': 'issue_report'})
            content = json.loads(Path(report['path']).read_text(encoding='utf-8'))
            record(name + '-issue-report-uses-own-log',
                   content['log_path'] == logs['path'] and
                   any(own_marker.replace('\\', '/') in line.replace('\\', '/') for line in content['log_tail']))
        request(first, '/commands', {'command': 'quit'})
        processes[0][0].wait(timeout=10)
        third = start()
        third_logs = request(third, '/logs/recent?lines=2000')
        record('default-log-reusable-after-owner-quits', third_logs['path'] == first_logs['path'])
        still_second = request(second, '/logs/recent?lines=2000')
        record('remaining-publisher-log-preserved',
               all(line in still_second['lines'] for line in second_logs['lines']))
    finally:
        for process, control in processes:
            if process.poll() is None:
                try:
                    if control:
                        request(control, '/commands', {'command': 'quit'})
                        process.wait(timeout=5)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
        (run / 'results.json').write_text(json.dumps(dict(
            publisher=str(publisher), sha256=hashlib.sha256(publisher.read_bytes()).hexdigest(),
            results=results), indent=2), encoding='utf-8')
        print('Results:', run)
    return 0 if all(result['passed'] for result in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
