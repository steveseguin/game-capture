"""Exercise the public-service runner against private delayed RTMP/HLS receivers."""
import argparse,http.server,json,os,select,socket,socketserver,subprocess,threading,time
from pathlib import Path
import psutil

p=argparse.ArgumentParser();p.add_argument('--publisher',type=Path,required=True);p.add_argument('--report',type=Path,required=True);p.add_argument('--viewer-failure',action='store_true')
a=p.parse_args();exe=a.publisher.resolve();out=a.report.resolve();out.mkdir(parents=True,exist_ok=True)
native=Path(__file__).resolve().parents[1];logs=[];owned=[];services=[]
def port():
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]
rtmp,rtc,hls,rtsp,udp=[port() for _ in range(5)]
config=out/'mediamtx.yml';config.write_text(f'''logLevel: info
rtmpAddress: 127.0.0.1:{rtmp}
rtspAddress: 127.0.0.1:{rtsp}
rtspTransports: [tcp]
webrtcAddress: 127.0.0.1:{rtc}
webrtcLocalUDPAddress: 127.0.0.1:{udp}
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts: [127.0.0.1]
hlsAddress: 127.0.0.1:{hls}
hlsAlwaysRemux: true
hlsVariant: fmp4
srt: false
moq: false
paths:
  all_others:
''')
requests={'hlsRejected':0,'hlsForwarded':0,'rtmpRejected':0,'rtmpForwarded':0}
class Hls(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        import urllib.request,urllib.error
        if not requests['hlsRejected']:
            requests['hlsRejected']+=1;self.send_error(503,'Fixture output is still starting');return
        requests['hlsForwarded']+=1
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{hls}'+self.path,timeout=10) as response:
                data=response.read();self.send_response(response.status)
                self.send_header('Content-Type',response.headers.get('Content-Type','application/octet-stream'))
                self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        except urllib.error.HTTPError as error:self.send_error(error.code)
        except OSError:self.send_error(502)
    def log_message(self,*args):pass
class Rtmp(socketserver.BaseRequestHandler):
    def handle(self):
        if not requests['rtmpRejected']:requests['rtmpRejected']+=1;return
        requests['rtmpForwarded']+=1
        try:
            with socket.create_connection(('127.0.0.1',rtmp),timeout=10) as remote:
                while True:
                    readable,_,_=select.select([self.request,remote],[],[],2)
                    for source in readable:
                        data=source.recv(65536)
                        if not data:return
                        (remote if source is self.request else self.request).sendall(data)
        except OSError:pass
class Tcp(socketserver.ThreadingTCPServer):daemon_threads=True
def launch(argv,name):
    log=(out/(name+'.log')).open('wb');logs.append(log)
    process=subprocess.Popen([str(v) for v in argv],stdout=log,stderr=log,cwd=native,creationflags=subprocess.CREATE_NO_WINDOW)
    owned.append(process);return process
try:
    server=launch([native/'.cache/mediamtx-1.21.2/mediamtx.exe',config],'server');time.sleep(.5);assert server.poll() is None
    hp=http.server.ThreadingHTTPServer(('127.0.0.1',0),Hls);rp=Tcp(('127.0.0.1',0),Rtmp)
    for service in (hp,rp):services.append(service);threading.Thread(target=service.serve_forever,daemon=True).start()
    started=time.monotonic();viewer=f'http://127.0.0.1:{port()}/unavailable' if a.viewer_failure else f'http://127.0.0.1:{rtc}/qa/'
    run=launch(['node',native/'e2e/public-output-packaged.js','--publisher='+str(exe),'--output='+str(out/'run'),
        '--publish-url='+f'http://127.0.0.1:{rtc}/qa/whip','--viewer='+viewer,
        '--hls-pull='+f'http://127.0.0.1:{hp.server_port}/compat/index.m3u8',
        '--rtmp-pull='+f'rtmp://127.0.0.1:{rp.server_address[1]}/compat',
        '--seconds=20','--fps=30','--video-encoder=software'],'runner')
    if not a.viewer_failure:
        # Model a service's compatibility rendition: WHIP carries Opus, while
        # legacy RTMP needs AAC. MediaMTX alone does not transcode that audio.
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            if "is publishing to path 'qa'" in (out/'server.log').read_text(errors='replace'):break
            assert run.poll() is None,'Runner stopped before publishing';time.sleep(.1)
        else:raise AssertionError('WHIP publisher did not arrive')
        bridge=launch([exe.parent/'ffmpeg/bin/ffmpeg.exe','-v','warning','-rtsp_transport','tcp','-i',f'rtsp://127.0.0.1:{rtsp}/qa',
            '-map','0:v:0','-map','0:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-f','rtsp','-rtsp_transport','tcp',f'rtsp://127.0.0.1:{rtsp}/compat'],'compatibility')
    code=run.wait(timeout=200);result=json.loads((out/'run/results.json').read_text())
    if a.viewer_failure:
        assert code!=0 and not result.get('passed')
        assert time.monotonic()-started<15,'Failed viewer waited for unrelated pull retries'
        assert all(pull.get('cancelled') and not pull['attempts'] for pull in result['pulls']),result['pulls']
        assert result['shutdown']['exitCode']==0 and not result['shutdown']['forced'],result['shutdown']
        requests.update(passed=True,cancelled=True,seconds=time.monotonic()-started)
        raise SystemExit(0)
    assert code==0 and result['passed'],'Local receiver workflow failed; inspect runner.log/results.json'
    assert requests['hlsRejected']==requests['rtmpRejected']==1,requests
    for pull in result['pulls']:
        assert len(pull['attempts'])>=2 and not pull['attempts'][0]['passed'] and pull['attempts'][-1]['passed'],pull
    assert all(pull.get('decodedAudioVideo') for pull in result['pulls']),result['pulls']
    requests['passed']=True
finally:
    for process in reversed(owned):
        if process.poll() is None:
            try:children=psutil.Process(process.pid).children(recursive=True)
            except psutil.NoSuchProcess:children=[]
            process.kill();process.wait(timeout=10)
            for child in reversed(children):
                try:child.kill()
                except psutil.NoSuchProcess:pass
            psutil.wait_procs(children,timeout=10)
    for service in services:service.shutdown();service.server_close()
    for log in logs:log.close()
    (out/'retry-fixture.json').write_text(json.dumps(requests,indent=2))
print('Private delayed RTMP/HLS receivers passed',flush=True)
