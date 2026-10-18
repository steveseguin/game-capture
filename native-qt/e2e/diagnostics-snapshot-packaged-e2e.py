"""Exercise command-line diagnostics output on packaged application shutdown."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import re
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
    parser.add_argument('--iterations', type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 25:
        parser.error('--iterations must be between 1 and 25')
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
    kernel.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                               ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    kernel.ReadFile.restype = wintypes.BOOL

    def shared_read(path):
        # A normal observer must permit atomic rename. Python's default file
        # open can deny delete sharing, turning this into the locked case.
        # https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
        handle = kernel.CreateFileW(str(path), 0x80000000, 7, None, 3, 0, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            chunks = []
            buffer = ctypes.create_string_buffer(65536)
            count = wintypes.DWORD()
            while True:
                if not kernel.ReadFile(handle, buffer, len(buffer), ctypes.byref(count), None):
                    raise ctypes.WinError(ctypes.get_last_error())
                if not count.value:
                    return b''.join(chunks).decode('utf-8')
                chunks.append(buffer.raw[:count.value])
        finally:
            kernel.CloseHandle(handle)

    def save():
        (run / 'results.json').write_text(json.dumps(dict(publisher=str(publisher),
            sha256=hashlib.sha256(publisher.read_bytes()).hexdigest(),
            harnessSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            observerShareMode='FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE',
            results=results), indent=2), encoding='utf-8')

    def diagnostic_log_lines(output):
        # The application logger is a file sink on Windows; GUI stdout alone
        # does not preserve the failed QSaveFile stage. This directory belongs
        # to this workflow's explicitly isolated LOCALAPPDATA.
        lines = []
        for file in (run / 'GameCapture/logs').glob('game-capture-debug*.log'):
            for line in file.read_text(encoding='utf-8', errors='replace').splitlines():
                if '[Diagnostics]' not in line or str(output) not in line:
                    continue
                line = line.replace(str(run), '<workflow>')
                line = re.sub(r'(?i)(?:https?|wss?)://[^\s"<>]+', '<url>', line)
                line = re.sub(r'(?i)bearer\s+\S+', 'Bearer <redacted>', line)
                lines.append(line[:2000])
        return lines[-40:]

    def record(name, passed, **details):
        results.append(dict(name=name, passed=passed, iteration=iteration, **details))
        save()
        print(name, passed, details)

    save()
    for iteration, locked in ((i, locked) for i in range(args.iterations) for locked in (False, True)):
        output = run / (('locked' if locked else 'snapshot') + f'-{iteration}.json')
        original = '{"previous":"retain this snapshot"}'
        output.write_text(original, encoding='utf-8')
        discovery = run / (('locked-control' if locked else 'control') + f'-{iteration}.json')
        process = subprocess.Popen([str(publisher), '--local-control',
            f'--settings-dir={run / (("settings-locked" if locked else "settings-normal") + f"-{iteration}")}',
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
                            value = shared_read(output)
                            reads.append(1)
                            json.loads(value)
                        except (json.JSONDecodeError, UnicodeDecodeError):
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
            record('quit-exits-cleanly', process.returncode == 0, locked=locked, exitCode=process.returncode)
            record('quit-removes-discovery', not discovery.exists(), locked=locked)
            if locked:
                record('failed-replacement-preserves-snapshot', output.read_text(encoding='utf-8') == original,
                       diagnosticLogLines=diagnostic_log_lines(output))
            else:
                record('readers-see-complete-json', bool(reads) and not invalid,
                       reads=len(reads), incomplete=len(invalid))
                content = json.loads(output.read_text(encoding='utf-8'))
                record('shutdown-exports-current-diagnostics', bool(content) and 'previous' not in content,
                       diagnosticLogLines=diagnostic_log_lines(output))
        except Exception as error:
            record('workflow-completed', False, locked=locked, error=str(error))
        finally:
            stop.set()
            if observer:
                observer.join()
            if handle is not None:
                kernel.CloseHandle(handle)
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    save()
    print('Results:', run)
    return 0 if all(result['passed'] for result in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
