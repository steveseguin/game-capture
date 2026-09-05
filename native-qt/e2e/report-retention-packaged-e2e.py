"""Exercise concurrent report collection against a complete Windows package."""
import argparse
from concurrent.futures import ThreadPoolExecutor
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
    discovery = run / 'control.json'
    env = dict(os.environ, LOCALAPPDATA=str(run))
    process = subprocess.Popen(
        [str(publisher), '--local-control', f'--local-control-discovery={discovery}'],
        env=env, creationflags=subprocess.CREATE_NO_WINDOW)
    results = []
    control = None

    def request(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = Request(control['base_url'] + path, data=data, headers={
            'Authorization': 'Bearer ' + control['token'],
            'Content-Type': 'application/json'})
        with urlopen(req, timeout=10) as response:
            return json.load(response)

    def record(name, passed, **details):
        results.append(dict(name=name, passed=passed, **details))
        print(name, passed, details)

    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Publisher exited during startup')
            try:
                control = json.loads(discovery.read_text(encoding='utf-8'))
                if request('/health')['pid'] == process.pid:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        else:
            raise RuntimeError('Publisher did not become ready')
        for command in ('issue_report', 'export_diagnostics'):
            def collect(index):
                note = f'report-retention-{index}'
                response = request('/commands', dict(command=command, notes=note))
                return note, response
            with ThreadPoolExecutor(max_workers=12) as pool:
                responses = list(pool.map(collect, range(100)))
            paths = [response['path'] for _, response in responses]
            record(command + '-unique-paths', len(set(paths)) == len(paths),
                   requested=len(paths), retained=len(set(paths)))
            intact = True
            for note, response in responses:
                content = json.loads(Path(response['path']).read_text(encoding='utf-8'))
                intact = intact and response['ok'] and bool(content)
                if command == 'issue_report':
                    intact = intact and content.get('notes') == note
            record(command + '-contents-preserved', intact)
        request('/commands', {'command': 'quit'})
        process.wait(timeout=10)
        record('clean-shutdown', process.returncode == 0)
    finally:
        if process.poll() is None:
            try:
                if control:
                    request('/commands', {'command': 'quit'})
                    process.wait(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        (run / 'results.json').write_text(json.dumps(dict(
            publisher=str(publisher), sha256=hashlib.sha256(publisher.read_bytes()).hexdigest(),
            results=results), indent=2), encoding='utf-8')
        print('Results:', run)
    return 0 if all(item['passed'] for item in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
