"""Exercise command-line/environment port precedence in a complete package."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
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
    results = []

    def reserve():
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        return listener

    for case in ('environment-port', 'explicit-fixed-port', 'explicit-ephemeral-port'):
        listener = reserve()
        env_port = listener.getsockname()[1]
        flags = []
        expected = env_port
        if case == 'explicit-fixed-port':
            with reserve() as other:
                expected = other.getsockname()[1]
            flags.append(f'--local-control-port={expected}')
        elif case == 'explicit-ephemeral-port':
            flags.append('--local-control-port=0')
        else:
            listener.close()
        discovery = run / (case + '.json')
        env = dict(os.environ, LOCALAPPDATA=str(run), GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1',
                   GAME_CAPTURE_LOCAL_CONTROL_PORT=str(env_port))
        process = subprocess.Popen([str(publisher), '--local-control',
            f'--local-control-discovery={discovery}', *flags], env=env,
            creationflags=subprocess.CREATE_NO_WINDOW)
        control = None
        actual = None
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    control = json.loads(discovery.read_text(encoding='utf-8'))
                    with urlopen(control['base_url'] + '/health', timeout=1) as response:
                        health = json.load(response)
                    if health['pid'] == process.pid:
                        actual = health['port']
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(.05)
            passed = (actual is not None and actual != env_port) if case == 'explicit-ephemeral-port' else actual == expected
            results.append(dict(name=case, passed=passed, actual_port=actual))
            print(case, passed, actual)
        finally:
            listener.close()
            if process.poll() is None:
                try:
                    if control:
                        req = Request(control['base_url'] + '/commands', data=b'{"command":"quit"}',
                            headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
                        with urlopen(req, timeout=3) as response:
                            json.load(response)
                        process.wait(timeout=5)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
    (run / 'results.json').write_text(json.dumps(dict(publisher=str(publisher),
        sha256=hashlib.sha256(publisher.read_bytes()).hexdigest(), results=results), indent=2), encoding='utf-8')
    print('Results:', run)
    return 0 if all(result['passed'] for result in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
