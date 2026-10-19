#!/usr/bin/env python3
"""Packaged updater over real TLS through an owned loopback CONNECT fixture.

The executable, production API URL and peer verification stay unchanged. Only
the owned app's mount namespace sees a generated QA CA in /etc/ssl/certs.
Untrusted and wrong-host certificates must fail before the compatible release
case can pass. No host trust/network settings or public releases are changed.
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
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

from PIL import ImageGrab

API_PATH = '/repos/steveseguin/game-capture/releases/latest'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def cache_values(path):
    config = configparser.ConfigParser(interpolation=None); config.optionxform = str
    config.read(path); values = config['General']; encoded = values['Release']
    if encoded.startswith('"'): encoded = ast.literal_eval(encoded)
    assert encoded.startswith('@ByteArray(') and encoded.endswith(')')
    body = encoded[len('@ByteArray('):-1]
    return {'attempt': int(values['LastAttempt']), 'success': int(values['LastSuccess']),
            'succeeded': values['LastAttemptSucceeded'] == 'true',
            'release': json.loads(body) if body else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publisher', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    assert os.getuid() != 0 and os.environ.get('GC_QA_PRIVATE_DESKTOP')
    assert os.environ.get('QT_QPA_PLATFORM') == 'xcb'
    exe = args.publisher.resolve(); bundle = exe.parent.parent.parent
    manifest_path = bundle/'release-artifact-manifest.json'
    assert sha(manifest_path) == args.manifest_sha256
    manifest = json.loads(manifest_path.read_text())
    architecture = manifest['architecture']
    assert architecture in ('amd64', 'arm64')
    other_architecture = 'amd64' if architecture == 'arm64' else 'arm64'
    assert sha(exe) == manifest['artifact']['sha256']
    for item in manifest['payload']['files']:
        file = (bundle/item['relativePath']).resolve()
        assert file.is_relative_to(bundle) and file.stat().st_size == item['size'] and sha(file) == item['sha256']
    report = args.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    helper = Path(__file__).with_name('linux-ui-control.py')
    for file in [Path(__file__), helper]: shutil.copy2(file, report/file.name)
    host_bundle = Path('/etc/ssl/certs/ca-certificates.crt')
    host_sha = sha(host_bundle); host_namespace = os.readlink('/proc/self/ns/mnt')
    result = {'scope': __doc__, 'passed': False, 'cases': [], 'network': [],
              'executableSha256': sha(exe), 'manifestSha256': sha(manifest_path),
              'harnessSha256': sha(__file__), 'helperSha256': sha(helper), 'hostCaBundleSha256': host_sha}
    env = {k:v for k,v in os.environ.items() if not k.lower().endswith('_proxy') and k not in ['SSL_CERT_FILE','SSL_CERT_DIR']}
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    app = control = server = None; logs = []; active = {}; stop_server = None
    private = tempfile.TemporaryDirectory(prefix='gc-update-tls-'); root = Path(private.name)
    certs = root/'certs'; certs.mkdir()

    def save(): (report/'results.json').write_text(json.dumps(result, indent=2)+'\n')
    def openssl(*values):
        subprocess.run(['openssl', *values], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
    def certificate(name, hostname):
        openssl('req','-new','-newkey','rsa:2048','-nodes','-keyout',str(root/(name+'.key')),
                '-out',str(root/(name+'.csr')),'-subj','/CN='+hostname)
        extension = root/(name+'.ext')
        extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:'+hostname+'\n')
        openssl('x509','-req','-in',str(root/(name+'.csr')),'-CA',str(certs/'qa-root.crt'),
                '-CAkey',str(root/'ca.key'),'-CAcreateserial','-out',str(root/(name+'.crt')),
                '-days','1','-sha256','-extfile',str(extension))
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(root/(name+'.crt'), root/(name+'.key'))
        context.set_servername_callback(lambda sock, name, ctx: result['network'].append(
            {'case':active['label'],'kind':'sni','hostname':name}))
        shutil.copy2(root/(name+'.crt'), report/(name+'.crt'))
        return context
    def wait(check, message, seconds=25):
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            assert app is None or app.poll() is None, 'Owned application exited unexpectedly'
            value = check()
            if value: return value
            time.sleep(.15)
        raise AssertionError(message)
    def ui(*values):
        return subprocess.check_output([sys.executable,str(helper),str(control['pid']),*values],text=True,timeout=15)
    def diagnostics():
        request = urllib.request.Request(control['base_url']+'/diagnostics',headers={'Authorization':'Bearer '+control['token']})
        with direct.open(request,timeout=5) as response: d = json.load(response)
        assert not d['app']['live'] and not d['app']['capturing'] and not d['source']['has_frame']
        assert d['video']['frames_sent'] == 0 and d['metrics']['audio_packets_sent'] == 0
    def stop():
        nonlocal app,control
        ui('quit-menu'); assert app.wait(timeout=10) == 0
        assert not Path(control['discoveryFile']).exists()
        app = control = None

    class Response(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def do_GET(self):
            assert self.path == API_PATH
            assert self.headers.get('Host') == 'api.github.com'
            assert not self.headers.get('Cookie') and not self.headers.get('Authorization')
            result['network'].append({'case':active['label'],'kind':'get','path':self.path,
                'host':self.headers.get('Host'),'userAgent':self.headers.get('User-Agent'),
                'tlsVersion':self.connection.version(),'cipher':self.connection.cipher()[0]})
            body = json.dumps(active['body'],separators=(',',':')).encode()
            self.send_response(active['status'])
            if active['status'] == 302: self.send_header('Location','https://example.com/never-follow')
            self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body)))
            self.send_header('Connection','close'); self.end_headers(); self.wfile.write(body)
            self.close_connection = True
        def log_message(self,*args): pass
    class Proxy(http.server.BaseHTTPRequestHandler):
        def do_CONNECT(self):
            result['network'].append({'case':active['label'],'kind':'connect','target':self.path})
            if self.path != 'api.github.com:443': self.send_error(403); return
            self.send_response(200); self.end_headers(); self.wfile.flush()
            self.connection.settimeout(20)
            try:
                with active['tls'].wrap_socket(self.connection,server_side=True) as tls:
                    Response(tls,self.client_address,self.server)
            except (ssl.SSLError,ConnectionError,TimeoutError) as error:
                result['network'].append({'case':active['label'],'kind':'tls-error','error':str(error)})
            self.close_connection = True
        def log_message(self,*args): pass

    def release(version='99.0.0', arch=architecture):
        tag='v'+version; name=f'game-capture-{version}~linux.2-{arch}-0123456789ab-abcdef012345.deb'
        asset={'name':name,'state':'uploaded','size':12345,
               'browser_download_url':f'https://github.com/steveseguin/game-capture/releases/download/{tag}/{name}'}
        return {'tag_name':tag,'draft':False,'prerelease':False,'assets':[
            {'name':'windows-only.exe','state':'uploaded','size':1000,'browser_download_url':'https://example.com/windows-only.exe'},asset]}

    def run(label, expected, metadata, tls, trusted=True, status=200, settings=None, warm=False):
        nonlocal app,control,active
        settings = settings or report/('settings-'+label); settings.mkdir(exist_ok=True)
        cache = settings/'update-check.ini'; discovery = settings/'private-control.json'
        if not warm and settings.name == 'settings-'+label: assert not cache.exists(), 'Cold launch has cache'
        prior_hash = sha(cache) if cache.exists() else None
        active = {'label':label,'body':metadata,'tls':tls,'status':status}
        start_events = len(result['network']); started = time.monotonic()
        address=f'http://127.0.0.1:{server.server_port}'
        child_env={**env,'http_proxy':address,'https_proxy':address,'HTTP_PROXY':address,'HTTPS_PROXY':address}
        command=['bwrap','--die-with-parent','--unshare-user','--bind','/','/']
        if trusted: command += ['--ro-bind',str(certs),'/etc/ssl/certs']
        command += ['--',str(exe),'--settings-dir='+str(settings),'--local-control',
                    '--local-control-port=0','--local-control-discovery='+str(discovery)]
        log=(report/(label+'.log')).open('w');logs.append(log)
        app=subprocess.Popen(command,env=child_env,stdout=log,stderr=log)
        wait(discovery.exists,'No discovery');control=json.loads(discovery.read_text())
        control['discoveryFile']=str(discovery);pid=control['pid']
        assert Path(f'/proc/{pid}/exe').resolve()==exe
        assert Path(f'/proc/{pid}').stat().st_uid==os.getuid()
        assert os.readlink(f'/proc/{pid}/ns/mnt') != host_namespace
        process_bundle=Path(f'/proc/{pid}/root/etc/ssl/certs/ca-certificates.crt')
        assert sha(process_bundle)==(sha(certs/'ca-certificates.crt') if trusted else host_sha)
        ui('activate'); ui('press','Show advanced settings');ui('press','Show advanced settings')
        if not warm:
            wait(lambda:any(e['kind']=='connect' for e in result['network'][start_events:]),'No HTTPS CONNECT')
        def completed():
            if not cache.exists(): return False
            rows=json.loads(ui('dump'))
            return rows if any(r['name']==expected for r in rows) and time.monotonic()-started>=7 else False
        rows=wait(completed,'Expected completed footer: '+expected)
        assert any(r['name']=='Releases' and 'visible' in r['states'] for r in rows)==expected.startswith('New version')
        footer=json.loads(ui('footer',expected));ImageGrab.grab().save(report/(label+'.png'))
        diagnostics();values=cache_values(cache);events=result['network'][start_events:]
        if warm: assert not events and sha(cache)==prior_hash
        elif expected=='Update check unavailable': assert not values['succeeded']
        else:
            assert values['succeeded'] and values['success']>=values['attempt']>0
            assert values['release']['tag_name']==metadata['tag_name']
            assert values['release']['assets']==([] if expected.startswith('Latest release') else [metadata['assets'][-1]])
            assert any(e['kind']=='get' and e['path']==API_PATH for e in events)
        if label in ['untrusted-certificate','wrong-hostname']:
            assert not any(e['kind']=='get' for e in events), 'Untrusted TLS reached HTTP handler'
            assert any(e['kind']=='tls-error' for e in events)
        assert all(e['target']=='api.github.com:443' for e in events if e['kind']=='connect'), 'Redirect followed'
        entry={'name':label,'expected':expected,'footer':footer,'trustedPrivateCa':trusted,'warm':warm,
               'cache':values,'cacheSha256':sha(cache),'networkEvents':events,'captureStayedOff':True,
               'privateMountVerified':True,'processCaBundleSha256':sha(process_bundle)}
        stop();entry['quitNormally']=True;result['cases'].append(entry)
        shutil.copy2(cache,report/(label+'-cache.ini'));save();print(json.dumps({'case':label,'passed':True}),flush=True)
        return settings,values

    try:
        print('Report:',report,flush=True)
        openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'ca.key'),
                '-out',str(certs/'qa-root.crt'),'-days','1','-subj','/CN=Game Capture owned QA CA',
                '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign')
        shutil.copy2(certs/'qa-root.crt',certs/'ca-certificates.crt')
        root_hash=subprocess.check_output(['openssl','x509','-hash','-noout','-in',str(certs/'qa-root.crt')],text=True).strip()
        (certs/(root_hash+'.0')).symlink_to('qa-root.crt')
        shutil.copy2(certs/'qa-root.crt',report/'qa-root.crt')
        valid=certificate('valid','api.github.com');wrong=certificate('wrong-host','wrong.invalid')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy)
        stop_server=threading.Thread(target=server.serve_forever,daemon=True);stop_server.start()
        run('untrusted-certificate','Update check unavailable',release(),valid,trusted=False)
        run('wrong-hostname','Update check unavailable',release(),wrong)
        settings,first=run('cold-compatible','New version available: v99.0.0',release(),valid)
        run('warm-compatible','New version available: v99.0.0',release(),valid,settings=settings,warm=True)
        current=manifest['version'].split('~')[0]
        run('current-compatible','You’re up to date',release(current),valid)
        run('other-architecture','Latest release has no compatible Linux download',release(arch=other_architecture),valid)
        run('redirect','Update check unavailable',release(),valid,status=302)
        cache=settings/'update-check.ini';old=int(time.time())-86410
        stale=re.sub(r'^LastAttempt=\d+$',f'LastAttempt={old}',cache.read_text(),flags=re.M)
        cache.write_text(re.sub(r'^LastSuccess=\d+$',f'LastSuccess={old}',stale,flags=re.M))
        _,failed=run('failed-refresh','Update check unavailable',{},valid,status=503,settings=settings)
        assert failed['release']==first['release'] and failed['success']==old and failed['attempt']>old
        run('warm-after-failure','Update check unavailable',{},valid,settings=settings,warm=True)
        result['passed']=True
    except Exception as error:
        result['error']=repr(error)
        if app and app.poll() is None and control:
            try:(report/'failure-ui.json').write_text(ui('dump'));ImageGrab.grab().save(report/'failure.png')
            except Exception:pass
    finally:
        if app and app.poll() is None:
            try:stop()
            except Exception:
                app.terminate()
                try:app.wait(timeout=5)
                except subprocess.TimeoutExpired:app.kill();app.wait(timeout=5)
        if server:server.shutdown();server.server_close()
        if stop_server:stop_server.join(timeout=3)
        for log in logs:log.close()
        private.cleanup();result['privateKeysRemoved']=not root.exists()
        result['hostCaBundleUnchanged']=sha(host_bundle)==host_sha
        result['passed']=result['passed'] and result['privateKeysRemoved'] and result['hostCaBundleUnchanged']
        save();print(json.dumps({'report':str(report),'passed':result['passed'],'error':result.get('error')}),flush=True)
    return 0 if result['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
