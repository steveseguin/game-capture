"""Bounded, deterministic HTTP fault workflows against a real packaged app."""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import select
import socket
import subprocess
import time
import uuid
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('desktop_helpers', Path(__file__).with_name('desktop-ui-e2e.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publisher', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    parser.add_argument('--seed', type=int, default=2601007)
    args = parser.parse_args()
    exe = args.publisher.resolve(strict=True)
    if not (exe.parent / 'platforms/qwindows.dll').is_file():
        raise RuntimeError('A complete package is required')
    run = args.reports.resolve() / uuid.uuid4().hex
    run.mkdir(parents=True)
    saved = helpers.snapshot(helpers.SETTINGS_KEY)
    checks, held = [], []
    control = None
    process = None
    failure = None
    rng = random.Random(args.seed)

    def check(name, passed, detail=None):
        checks.append(dict(name=name, passed=bool(passed), detail=detail))
        print(('PASS ' if passed else 'FAIL ') + name, flush=True)

    def raw(payload, chunks=False, timeout=3):
        data = bytearray()
        with socket.create_connection(('127.0.0.1', control['port']), timeout=timeout) as conn:
            conn.settimeout(timeout)
            if chunks:
                for offset in range(0, len(payload), 7):
                    conn.sendall(payload[offset:offset + 7])
                    time.sleep(.001)
            else:
                conn.sendall(payload)
            try:
                while chunk := conn.recv(65536):
                    data.extend(chunk)
                    if len(data) > 4 * 1024 * 1024:
                        raise RuntimeError('Oversized control response')
            except ConnectionResetError:
                pass
        first = bytes(data).split(b'\r\n', 1)[0]
        return int(first.split()[1]) if first.startswith(b'HTTP/1.1 ') else 0

    def api(route, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = Request(control['base_url'] + route, data=data,
                      headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
        with urlopen(req, timeout=4) as response:
            return json.load(response)

    try:
        discovery = run / 'control.json'
        output = (run / 'publisher.log').open('wb')
        process = subprocess.Popen([str(exe), '--local-control', '--local-control-port=0',
                                    '--local-control-discovery=' + str(discovery)], cwd=exe.parent,
                                   stdout=output, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW,
                                   env=dict(os.environ, LOCALAPPDATA=str(run), GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1'))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and process.poll() is None:
            try:
                control = json.loads(discovery.read_text(encoding='utf-8'))
                if api('/health')['pid'] == process.pid:
                    break
            except (OSError, ValueError):
                time.sleep(.1)
        if not control or process.poll() is not None:
            raise RuntimeError('Packaged app did not become ready')
        check('actual-packaged-process', api('/health')['pid'] == process.pid)
        auth = b'Authorization: Bearer ' + control['token'].encode() + b'\r\n'
        cases = [
            ('missing-auth', b'GET /diagnostics HTTP/1.1\r\nHost: localhost\r\n\r\n', 401),
            ('wrong-auth', b'GET /diagnostics HTTP/1.1\r\nAuthorization: Bearer wrong\r\n\r\n', 401),
            ('missing-http-version', b'GET /health\r\n\r\n', 400),
            ('invalid-http-version', b'GET /health HTTP/9.9\r\n\r\n', 400),
            ('extra-request-tokens', b'GET /health HTTP/1.1 ignored\r\n\r\n', 400),
            ('malformed-header', b'GET /health HTTP/1.1\r\ninvalid-header\r\n\r\n', 400),
            ('whitespace-header-name', b'GET /health HTTP/1.1\r\nContent-Length : 0\r\n\r\n', 400),
            ('duplicate-auth', b'GET /diagnostics HTTP/1.1\r\n' + auth + auth + b'\r\n', 400),
            ('oversized-header', b'GET /health HTTP/1.1\r\nX-Fill: ' + b'a' * 17000 + b'\r\n\r\n', 400),
            ('oversized-buffer', b'G' * (1024 * 1024 + 1), 400),
        ]
        for value in [b'-1', b'+0', b'1e3', b'0x10', b'999999999999999999999999', b'1048576', b'']:
            cases.append(('invalid-length-' + str(len(cases)), b'GET /health HTTP/1.1\r\nContent-Length: ' + value + b'\r\n\r\n', 400))
        for framing in [b'Content-Length: 0\r\nContent-Length: 1', b'Transfer-Encoding: chunked']:
            cases.append(('ambiguous-framing-' + str(len(cases)), b'GET /health HTTP/1.1\r\n' + framing + b'\r\n\r\n', 400))
        for name, payload, expected in cases:
            try:
                actual = raw(payload)
                check(name, actual == expected, dict(expected=expected, actual=actual))
            except OSError as error:
                check(name, False, type(error).__name__)

        # Valid fragmentation, header case, LF-safe JSON, and UTF-8 byte counts.
        body = json.dumps({'command': 'issue_report', 'notes': 'Unicode: café / 日本語 / 🎮'}, ensure_ascii=False).encode()
        payload = b'POST /commands HTTP/1.1\r\n' + auth + b'cOnTeNt-LeNgTh: ' + str(len(body)).encode() + b'\r\n\r\n' + body
        check('fragmented-unicode-report', raw(payload, chunks=True) == 201)
        reports = list((run / 'GameCapture/reports').glob('*.json'))
        check('unicode-report-output', any(json.loads(p.read_text(encoding='utf-8')).get('notes') == 'Unicode: café / 日本語 / 🎮' for p in reports))

        invalid_json = [b'', b'null', b'[]', b'"quit"', b'{', b'{"command":null}', b'{"command":123}',
                        b'{"command":"unknown"}', b'{"command":"stop\\u0000quit"}', b'\xff\xfe', b'[' * 2000]
        for index in range(256):
            if index % 4 == 0:
                body = rng.choice(invalid_json)
            elif index % 4 == 1:
                body = b'\xff' + rng.randbytes(rng.randrange(1, 512))
            elif index % 4 == 2:
                body = json.dumps({'command': 'fuzz-' + rng.randbytes(24).hex(),
                                   'notes': ''.join(chr(rng.randrange(0x20, 0xd7ff)) for _ in range(80))}).encode()
            else:
                depth = rng.randrange(1, 1500)
                body = b'[' * depth + b'null' + b']' * depth
            payload = b'POST /commands HTTP/1.1\r\n' + auth + b'Content-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body
            check('seeded-invalid-command-' + str(index), raw(payload) == 400)
        check('malformed-commands-preserve-app', process.poll() is None and not api('/diagnostics')['app']['live'])

        # No client should retain an incomplete request indefinitely, including a
        # client that keeps trickling bytes just before an idle timer would fire.
        for initial in [b'', b'GET /health HTTP/1.1\r\nX-Slow: ',
                        b'POST /commands HTTP/1.1\r\nContent-Length: 500\r\n\r\n']:
            conn = socket.create_connection(('127.0.0.1', control['port']), timeout=3)
            conn.settimeout(.05)
            if initial:
                conn.sendall(initial)
            held.append(conn)
        started = time.monotonic()
        closed = [False] * len(held)
        while time.monotonic() - started < 11.5 and not all(closed):
            for index, conn in enumerate(held):
                if closed[index]:
                    continue
                try:
                    if index == 1:
                        conn.sendall(b'a')
                    closed[index] = conn.recv(8192) == b''
                except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                    closed[index] = True
                except socket.timeout:
                    pass
            time.sleep(.1)
        for index, result in enumerate(closed):
            check('incomplete-connection-deadline-' + str(index), result, round(time.monotonic() - started, 3))
        for conn in held:
            conn.close()
        held.clear()

        for _ in range(48):
            conn = socket.create_connection(('127.0.0.1', control['port']), timeout=3)
            conn.settimeout(.1)
            held.append(conn)
        time.sleep(.4)
        readable, _, _ = select.select(held, [], [], .5)
        rejected = 0
        for conn in readable:
            try:
                rejected += conn.recv(1) == b''
            except (ConnectionResetError, ConnectionAbortedError):
                rejected += 1
        check('connection-count-bounded', rejected >= 16, rejected)
        for conn in held:
            conn.close()
        held.clear()
        time.sleep(.1)

        quit_body = b'{"command":"quit"}'
        pipeline = b'GET /health HTTP/1.1\r\n\r\nPOST /commands HTTP/1.1\r\n' + auth + b'Content-Length: ' + str(len(quit_body)).encode() + b'\r\n\r\n' + quit_body
        check('single-request-per-connection', raw(pipeline) == 200)
        time.sleep(.2)
        check('pipelined-command-not-executed', process.poll() is None and api('/health')['pid'] == process.pid)

        # Bounded parallel pressure followed by successful recovery.
        def burst(index):
            payload = b'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n' if index % 2 else b'POST /commands HTTP/1.1\r\n' + auth + b'Content-Length: 1\r\n\r\n{'
            actual = raw(payload)
            return actual == (200 if index % 2 else 400)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(burst, range(128)))
        check('concurrent-malformed-and-valid-requests', all(results), sum(results))
        check('health-after-fuzz', api('/health')['pid'] == process.pid)
        check('schema-after-fuzz', api('/schema')['schema'] == 'game-capture-local-control-v1')
        api('/commands', {'command': 'quit'})
        check('clean-quit-after-fuzz', process.wait(timeout=8) == 0)
        check('discovery-removed', not discovery.exists())
    except BaseException as error:
        failure = str(error)
        raise
    finally:
        for conn in held:
            conn.close()
        if process and process.poll() is None:
            try:
                api('/commands', {'command': 'quit'})
                process.wait(timeout=5)
            except Exception:
                process.kill()
                process.wait(timeout=5)
        helpers.restore(helpers.SETTINGS_KEY, saved)
        restored = helpers.snapshot(helpers.SETTINGS_KEY) == saved
        result = dict(ok=failure is None and restored and all(c['passed'] for c in checks),
                      error=failure, publisher=str(exe), sha256=hashlib.sha256(exe.read_bytes()).hexdigest(),
                      seed=args.seed, settingsRestored=restored, checks=checks)
        (run / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print('Report: ' + str(run / 'results.json'), flush=True)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
