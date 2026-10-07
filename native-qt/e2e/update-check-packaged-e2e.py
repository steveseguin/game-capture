"""Exercise the packaged footer, real HTTPS, failure sockets, cache, and default-browser link.

Frida redirects only this process's update URL to local HTTP/TLS fixtures. Production
has no endpoint override. HTTPS verification is never disabled. Other requests are untouched.
"""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import http.server
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import threading
import time

import frida
from pywinauto import Application, Desktop
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('desktop_workflow', Path(__file__).with_name('desktop-ui-e2e.py'))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)
snapshot, restore, setting = desktop.snapshot, desktop.restore, desktop.setting
SETTINGS_KEY, OBSERVER, wait_for = desktop.SETTINGS_KEY, desktop.OBSERVER, desktop.wait_for

API = 'https://api.github.com/repos/steveseguin/game-capture/releases/latest'
RELEASES = 'https://github.com/steveseguin/game-capture/releases'
UP_TO_DATE = 'You\u2019re up to date'
UNAVAILABLE = 'Update check unavailable'

HOOK = r'''
const core = Process.getModuleByName('Qt6Core.dll');
const net = Process.getModuleByName('Qt6Network.dll');
function fn(module, prefix, result, args) {
    const exp = module.enumerateExports().find(e => e.name.startsWith(prefix));
    if (!exp) throw Error('Missing export ' + prefix);
    return new NativeFunction(exp.address, result, args);
}
const getUrl = fn(net, '?url@QNetworkRequest', 'pointer', ['pointer','pointer']);
const urlText = fn(core, '?toString@QUrl@@', 'pointer', ['pointer','pointer','int']);
const stringCtor = fn(core, '??0QString@@QEAA@PEBVQChar@@_J@Z', 'pointer', ['pointer','pointer','int64']);
const urlCtor = fn(core, '??0QUrl@@QEAA@AEBVQString@@', 'pointer', ['pointer','pointer','int']);
const setUrl = fn(net, '?setUrl@QNetworkRequest', 'void', ['pointer','pointer']);
const destroyUrl = fn(core, '??1QUrl@@', 'void', ['pointer']);
const destroyString = fn(core, '??1QString@@', 'void', ['pointer']);
function readString(p) { return p.add(8).readPointer().readUtf16String(p.add(16).readS64().toNumber()); }
const get = net.getExportByName('?get@QNetworkAccessManager@@QEAAPEAVQNetworkReply@@AEBVQNetworkRequest@@@Z');
Interceptor.attach(get, {onEnter(args) {
    const u = Memory.alloc(8), s = Memory.alloc(24);
    getUrl(args[1], u); urlText(u, s, 0);
    const url = readString(s);
    destroyString(s); destroyUrl(u);
    if (url !== API) return;
    send({kind:'update_request', url:url, time:Date.now()});
    if (REDIRECT) {
        stringCtor(s, Memory.allocUtf16String(REDIRECT), REDIRECT.length);
        urlCtor(u, s, 0); setUrl(args[1], u);
        destroyUrl(u); destroyString(s);
        send({kind:'fixture_redirect', url:REDIRECT});
    }
}});
Interceptor.attach(net.enumerateExports().find(e => e.name.startsWith('?errorOccurred@QNetworkReply')).address,
    {onEnter(args) { send({kind:'network_error', code:args[1].toInt32()}); }});
Process.attachModuleObserver({onAdded(m) {
    if (/game-capture|qt6network|qschannelbackend|qopensslbackend/i.test(m.name)) send({kind:'module', path:m.path});
    if (m.name.toLowerCase() === 'shell32.dll') {
        Interceptor.attach(m.getExportByName('ShellExecuteW'), {onEnter(args) {
            if (!args[2].isNull()) send({kind:'browser_open', url:args[2].readUtf16String()});
        }});
        Interceptor.attach(m.getExportByName('ShellExecuteExW'), {onEnter(args) {
            const p = args[0].add(24).readPointer();
            if (!p.isNull()) send({kind:'browser_open', url:p.readUtf16String()});
        }});
    }
}});
'''


class Fixture:
    def __init__(self, mode, body=None, status=200, cert=None, key=None):
        self.requests = []
        self.mode = mode
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append(dict(path=self.path, headers=dict(self.headers), time=time.time()))
                self.send_response(status)
                if mode == 'oversized-header':
                    self.send_header('Content-Length', str(1024 * 1024 + 1))
                self.end_headers()
                try:
                    if mode == 'stall-body':
                        # Headers establish the connection; no complete body before total deadline.
                        time.sleep(20)
                    elif mode == 'oversized-body':
                        self.wfile.write(b' ' * (1024 * 1024 + 1))
                    else:
                        self.wfile.write(body or b'{}')
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass
            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        if mode in ('stall-connect', 'broken-tls'):
            def accept():
                while not self.stop.is_set():
                    try:
                        client, _ = self.server.socket.accept()
                    except OSError:
                        return
                    self.sockets.append(client)
                    owner.requests.append({'connection': True, 'time': time.time()})
                    if mode == 'broken-tls':
                        client.sendall(b'This is not TLS\r\n')
                        client.close()
            target = accept
        else:
            target = self.server.serve_forever
        scheme = 'https' if mode in ('refused', 'stall-connect', 'broken-tls', 'untrusted-tls') else 'http'
        self.url = f'{scheme}://127.0.0.1:{self.server.server_port}/release'
        if mode == 'untrusted-tls':
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.sockets = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=target, daemon=True)
        if mode == 'refused':
            self.server.server_close()
        else:
            self.thread.start()

    def close(self):
        self.stop.set()
        if self.mode not in ('refused', 'stall-connect', 'broken-tls'):
            self.server.shutdown()
        self.server.server_close()
        for client in self.sockets:
            client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publisher', required=True)
    parser.add_argument('--report-dir', required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--live-status', default=UP_TO_DATE)
    parser.add_argument('--live-only', action='store_true')
    parser.add_argument('--upgrade-cache')
    parser.add_argument('--openssl', default='C:/Program Files/Git/usr/bin/openssl.exe')
    args = parser.parse_args()
    exe = Path(args.publisher).resolve(strict=True)
    report = Path(args.report_dir).resolve()
    report.mkdir(parents=True, exist_ok=True)
    if not (exe.parent / 'tls/qschannelbackend.dll').is_file():
        raise RuntimeError('Packaged Schannel backend is required')
    device = frida.get_local_device()
    if any(p.name.lower() == 'game-capture.exe' for p in device.enumerate_processes()):
        raise RuntimeError('Close existing Game Capture instances')
    cache = Path(os.environ['LOCALAPPDATA']) / 'GameCapture/update-check.ini'
    saved_cache = cache.read_bytes() if cache.exists() else None
    saved_settings = snapshot(SETTINGS_KEY)
    results, events, samples = [], [], []
    active_pid = None
    failure = None
    user32 = ctypes.WinDLL('user32')
    user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM,
                                         wintypes.LPARAM, wintypes.UINT, wintypes.UINT,
                                         ctypes.POINTER(ctypes.c_size_t)]
    user32.SendMessageTimeoutW.restype = wintypes.LPARAM

    def check(name, passed, detail=None):
        results.append(dict(name=name, passed=bool(passed), detail=detail))
        print(('PASS ' if passed else 'FAIL ') + name, flush=True)
        if not passed:
            raise AssertionError(name + ': ' + str(detail))

    def run_case(name, expected, fixture=None, fresh=True, click=False, quit_pending=False):
        nonlocal active_pid
        if fresh:
            cache.unlink(missing_ok=True)
        before = cache.read_bytes() if cache.exists() else None
        current_events = []
        env = dict(os.environ, GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1', LOCALAPPDATA=str(report / name))
        for key in ('QT_PLUGIN_PATH', 'QT_QPA_PLATFORM', 'QML2_IMPORT_PATH'):
            env.pop(key, None)
        active_pid = device.spawn([str(exe)], cwd=str(exe.parent), env=env)
        session = device.attach(active_pid)
        script = session.create_script('const API=' + json.dumps(API) + '; const REDIRECT=' +
                                       json.dumps(fixture.url if fixture else None) + ';' + OBSERVER + HOOK)
        def message(msg, _):
            entry = {'case': name, **msg.get('payload', msg), 'time': time.time()}
            current_events.append(entry)
            events.append(entry)
        script.on('message', message)
        script.load()
        device.resume(active_pid)
        app = Application(backend='uia').connect(process=active_pid, timeout=20)
        window = app.window(title='Game Capture - Powered by VDO.Ninja')
        window.wait('visible', timeout=20)
        window.maximize()
        def named(suffix):
            return next(c for c in window.descendants() if c.element_info.automation_id.endswith('.' + suffix))
        check(name + ': installed version', named('versionLabel').window_text() == 'Version ' + args.expected_version)
        stop = threading.Event()
        hwnd = window.handle
        def monitor():
            while not stop.wait(.05):
                result = ctypes.c_size_t()
                started = time.perf_counter()
                ok = user32.SendMessageTimeoutW(hwnd, 0, 0, 0, 2, 250, ctypes.byref(result))
                samples.append(dict(case=name, responsive=bool(ok), elapsedMs=(time.perf_counter()-started)*1000))
        thread = threading.Thread(target=monitor)
        thread.start()
        try:
            if quit_pending:
                wait_for(lambda: any(e.get('kind') == 'update_request' for e in current_events), 'request started', 12)
                wait_for(lambda: bool(fixture.requests), 'real connection started', 4)
            else:
                wait_for(lambda: named('updateStatusLabel').window_text() == expected and
                         (not fresh or any(e.get('kind') == 'update_request' for e in current_events)),
                         name + ': footer result', 25)
                completed_at = time.time()
                # Check completion persisted, not just the initial unavailable label.
                if fresh:
                    wait_for(lambda: cache.exists() and 'LastAttempt=' in cache.read_text(), 'attempt saved', 3)
                    time.sleep(.3)
                else:
                    time.sleep(6)
                    check(name + ': no restart request', not any(e.get('kind') == 'update_request' for e in current_events))
                    check(name + ': cache unchanged', cache.read_bytes() == before)
                window.set_focus()
                window.wheel_mouse_input(coords=(window.rectangle().width() - 25, 150), wheel_dist=-30)
                time.sleep(.3)
                window.capture_as_image().save(report / (name + '.png'))
                check(name + ': footer status', named('updateStatusLabel').window_text() == expected)
                visible_link = [c for c in window.descendants() if c.element_info.automation_id.endswith('.releasesLink') and c.is_visible()]
                check(name + ': link visibility', bool(visible_link) == expected.startswith('New version available:'))
                if click:
                    previous_browser_handles = {w.handle for w in Desktop(backend='uia').windows(title_re='.*Microsoft.*Edge.*')}
                    visible_link[0].click_input()
                    wait_for(lambda: any(e.get('kind') == 'browser_open' and e.get('url') == RELEASES for e in current_events),
                             'default browser launch', 10)
                    wait_for(lambda: bool(Desktop(backend='uia').windows(title_re='.*Releases.*game-capture.*Microsoft.*Edge.*')),
                             'releases browser window', 25)
                    windows = Desktop(backend='uia').windows(title_re='.*Releases.*game-capture.*Microsoft.*Edge.*')
                    chosen = next((w for w in windows if w.handle == user32.GetForegroundWindow()), windows[0])
                    browser = Desktop(backend='uia').window(handle=chosen.handle)
                    address_field = next(e for e in browser.descendants(control_type='Edit')
                                         if e.element_info.automation_id == 'view_1017' or e.window_text() == RELEASES)
                    address = address_field.get_value()
                    check(name + ': actual browser address', address.rstrip('/') in (RELEASES, RELEASES.removeprefix('https://')), address)
                    browser.capture_as_image().save(report / 'releases-browser.png')
                    # Isolated LOCALAPPDATA can trigger Edge's first-run overlay. Reading the
                    # address does not require signing in or changing its defaults.
                    if browser.handle not in previous_browser_handles:
                        user32.PostMessageW(browser.handle, 0x10, 0, 0)
                    elif browser.is_enabled():
                        browser.set_focus()
                        browser.type_keys('^w')
            check(name + ': packaged executable loaded', any(e.get('kind') == 'module' and
                  Path(e.get('path', '')).resolve() == exe for e in current_events))
            if not fixture and fresh:
                check(name + ': packaged TLS backend loaded', any(e.get('kind') == 'module' and
                      Path(e.get('path', '')).resolve() == exe.parent / 'tls/qschannelbackend.dll' for e in current_events))
            check(name + ': no sound or alert', not any(e.get('kind') == 'sound' or e.get('event') == 2 for e in current_events))
            check(name + ': observer intact', not any(e.get('type') == 'error' for e in current_events),
                  [e for e in current_events if e.get('type') == 'error'])
            import win32api, win32con, win32event, win32process
            stop.set()
            thread.join(2)
            handle = win32api.OpenProcess(win32con.SYNCHRONIZE | win32con.PROCESS_QUERY_INFORMATION, False, active_pid)
            started = time.perf_counter()
            window.set_focus()
            window.menu_select('File->Quit')
            ended = win32event.WaitForSingleObject(handle, 4000) == win32con.WAIT_OBJECT_0
            exit_code = win32process.GetExitCodeProcess(handle)
            handle.Close()
            check(name + ': clean prompt quit', ended and exit_code == 0 and time.perf_counter()-started < 4,
                  dict(exitCode=exit_code, elapsed=time.perf_counter()-started))
            active_pid = None
        finally:
            stop.set()
            thread.join(2)
        requests = [e for e in current_events if e.get('kind') == 'update_request']
        if fixture:
            if fixture.mode in ('refused', 'untrusted-tls'):
                expected_error = 1 if fixture.mode == 'refused' else 6
                check(name + ': real socket error', any(e.get('kind') == 'network_error' and
                      e.get('code') == expected_error for e in current_events))
            else:
                check(name + ': real fixture traffic', bool(fixture.requests))
            for request in fixture.requests:
                if 'headers' in request:
                    headers = {k.lower(): v for k, v in request['headers'].items()}
                    check(name + ': public metadata request only', 'authorization' not in headers and
                          'cookie' not in headers and headers.get('user-agent') == 'game-capture/' + args.expected_version)
            if name in ('connection-timeout', 'total-timeout'):
                duration = completed_at - requests[0]['time']
                low, high = (9, 12) if name == 'connection-timeout' else (14, 17)
                check(name + ': bounded timeout', low <= duration <= high, duration)
        streak = maximum = 0
        for sample in [s for s in samples if s['case'] == name]:
            streak = 0 if sample['responsive'] else streak + 1
            maximum = max(maximum, streak)
        check(name + ': responsive UI', maximum < 2, maximum)

    try:
        setting('ui', 'minimizeToTrayOnClose', 'false')
        setting('ui', 'advancedVisible', 'false')
        if args.upgrade_cache:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(Path(args.upgrade_cache).read_bytes())
            run_case('upgraded-cached-release', UP_TO_DATE, fresh=False)
        run_case('live-github', args.live_status, click=args.live_status.startswith('New version available:'))
        (report / 'live-cache.ini').write_bytes(cache.read_bytes())
        run_case('cached-live-github', args.live_status, fresh=False)
        if not args.live_only:
            cert, key = report / 'untrusted.crt', report / 'untrusted.key'
            subprocess.run([args.openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=127.0.0.1',
                            '-addext', 'subjectAltName=IP:127.0.0.1'], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           creationflags=subprocess.CREATE_NO_WINDOW)
            payload = lambda tag, **flags: json.dumps(dict(tag_name=tag, draft=False, prerelease=False, **flags)).encode()
            major, minor, patch = map(int, args.expected_version.split('.'))
            newer = f'{major}.{minor}.{patch + 1}'
            # Future stable metadata exercises the old-version UI; the real upgrade comparison is run with both packages.
            cases = [('new-stable', 'normal', payload('v' + newer), 200, 'New version available: v' + newer),
                     ('matching-stable', 'normal', payload('v' + args.expected_version), 200, UP_TO_DATE),
                     ('prerelease-flag', 'normal', b'{"tag_name":"v99.0.0","draft":false,"prerelease":true}', 200, UNAVAILABLE),
                     ('prerelease-tag', 'normal', payload('v99.0.0-rc.1'), 200, UNAVAILABLE),
                     ('draft', 'normal', b'{"tag_name":"v99.0.0","draft":true,"prerelease":false}', 200, UNAVAILABLE),
                     ('rate-limit', 'normal', payload('v99.0.0'), 429, UNAVAILABLE),
                     ('malformed', 'normal', b'not json', 200, UNAVAILABLE),
                     ('oversized-header', 'oversized-header', None, 200, UNAVAILABLE),
                     ('oversized-body', 'oversized-body', None, 200, UNAVAILABLE),
                     ('tls-error', 'broken-tls', None, 200, UNAVAILABLE),
                     ('offline-refused', 'refused', None, 200, UNAVAILABLE),
                     ('untrusted-certificate', 'untrusted-tls', None, 200, UNAVAILABLE),
                     ('connection-timeout', 'stall-connect', None, 200, UNAVAILABLE),
                     ('total-timeout', 'stall-body', None, 200, UNAVAILABLE)]
            for name, mode, body, code, expected in cases:
                fixture = Fixture(mode, body, code, cert, key)
                try:
                    run_case(name, expected, fixture, click=name == 'new-stable' and expected.startswith('New version'))
                    if name == 'new-stable':
                        (report / 'stable-cache.ini').write_bytes(cache.read_bytes())
                        run_case('cached-stable', expected, fresh=False)
                    if name == 'rate-limit':
                        run_case('cached-failure', UNAVAILABLE, fresh=False)
                finally:
                    fixture.close()
            fixture = Fixture('stall-connect')
            try:
                run_case('shutdown-pending', UNAVAILABLE, fixture, quit_pending=True)
                run_case('restart-after-shutdown', UNAVAILABLE, fresh=False)
            finally:
                fixture.close()
    except BaseException as error:
        failure = str(error)
        raise
    finally:
        if active_pid:
            try:
                device.kill(active_pid)
            except frida.ProcessNotFoundError:
                pass
        if saved_cache is None:
            cache.unlink(missing_ok=True)
        else:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(saved_cache)
        restore(SETTINGS_KEY, saved_settings)
        restored = snapshot(SETTINGS_KEY) == saved_settings
        (report / 'results.json').write_text(json.dumps(dict(ok=failure is None and restored, error=failure,
            publisher=str(exe), sha256=hashlib.sha256(exe.read_bytes()).hexdigest(), settingsRestored=restored,
            checks=results, events=events, responsiveness=samples), indent=2), encoding='utf-8')
        print('Report: ' + str(report / 'results.json'), flush=True)


if __name__ == '__main__':
    main()
