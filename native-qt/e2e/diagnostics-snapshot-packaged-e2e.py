"""Exercise command-line diagnostics output on packaged application shutdown."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
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
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def record(name, passed, **details):
        results.append(dict(name=name, passed=passed, **details))
        print(name, passed, details)

    for locked in (False, True):
        output = run / ('locked.json' if locked else 'snapshot.json')
        original = '{"previous":"retain this snapshot"}'
        output.write_text(original, encoding='utf-8')
        discovery = run / ('locked-control.json' if locked else 'control.json')
        process = subprocess.Popen([str(publisher), '--local-control',
            f'--local-control-discovery={discovery}', f'--diagnostics-out={output}'],
            env=dict(os.environ, LOCALAPPDATA=str(run)), creationflags=subprocess.CREATE_NO_WINDOW)
        handle = None
        stop = threading.Event()
        reads = []
        invalid = []
        observer = None
        try:
            deadline = time.monotonic() + 20
            while not discovery.exists():
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Publisher did not become ready')
                time.sleep(.05)
            control = json.loads(discovery.read_text(encoding='utf-8'))
            if locked:
                # Allow reads/writes but deny rename/delete, forcing atomic commit failure.
                handle = kernel.CreateFileW(str(output), 0x80000000, 3, None, 3, 0, None)
                if handle == wintypes.HANDLE(-1).value:
                    handle = None
                    raise ctypes.WinError(ctypes.get_last_error())
            else:
                def observe():
                    while not stop.is_set():
                        try:
                            value = output.read_text(encoding='utf-8')
                            reads.append(1)
                            json.loads(value)
                        except json.JSONDecodeError:
                            invalid.append(1)
                        except OSError:
                            pass # Windows can briefly deny a read during replacement.
                observer = threading.Thread(target=observe)
                observer.start()
            req = Request(control['base_url'] + '/commands',
                          data=b'{"command":"quit"}', headers={
                              'Authorization': 'Bearer ' + control['token'],
                              'Content-Type': 'application/json'})
            with urlopen(req, timeout=5) as response:
                json.load(response)
            process.wait(timeout=15)
            stop.set()
            if observer:
                observer.join()
            if locked:
                record('failed-replacement-preserves-snapshot', output.read_text(encoding='utf-8') == original)
            else:
                record('readers-see-complete-json', bool(reads) and not invalid,
                       reads=len(reads), incomplete=len(invalid))
                content = json.loads(output.read_text(encoding='utf-8'))
                record('shutdown-exports-current-diagnostics', bool(content) and 'previous' not in content)
        finally:
            stop.set()
            if observer:
                observer.join()
            if handle is not None:
                kernel.CloseHandle(handle)
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    (run / 'results.json').write_text(json.dumps(dict(publisher=str(publisher),
        sha256=hashlib.sha256(publisher.read_bytes()).hexdigest(), results=results), indent=2), encoding='utf-8')
    print('Results:', run)
    return 0 if all(result['passed'] for result in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
