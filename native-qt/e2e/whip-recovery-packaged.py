"""Native packaged publisher -> impaired UDP -> independent WHIP decoder.

Uses Desktop Studio's existing private aiortc receiver/relay fixtures (pass its
native-qt directory with --receiver-root). No installed receiver is modified.
"""
import argparse, ast, collections, hashlib, heapq, http.client, http.server, json
import os, random, re, select, socket, subprocess, sys, threading, time, urllib.parse, urllib.request
from pathlib import Path
import psutil

parser = argparse.ArgumentParser()
parser.add_argument('--publisher', required=True)
parser.add_argument('--receiver-root', required=True)
parser.add_argument('--fixture', required=True)
parser.add_argument('--report', required=True)
parser.add_argument('--encoder', default='software')
parser.add_argument('--impaired-seconds', type=int, default=60)
args = parser.parse_args()
assert 10 <= args.impaired_seconds <= 600
native = Path(__file__).resolve().parent.parent
receiver_root = Path(args.receiver_root).resolve()
publisher = Path(args.publisher).resolve()
report = Path(args.report).resolve(); report.mkdir(parents=True, exist_ok=True)
results = {'publisherSha256': hashlib.sha256(publisher.read_bytes()).hexdigest(), 'http': [], 'samples': []}
started = time.monotonic()
for node in ast.parse((receiver_root/'e2e/mixer-udp-fault-e2e.py').read_text()).body:
    if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in ('UdpRelay', 'Signaling', 'rewrite_candidates', 'port'):
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<shared UDP fixture>', 'exec'))
os.environ['STUDIO_WHIP_REFERENCE'] = '1'
whip_port = port(); relay = signal_server = receiver = source = app = None
logs = []

def launch(argv, name, cwd=None, env=None):
    log = (report/(name+'.log')).open('wb'); logs.append(log)
    return subprocess.Popen([str(a) for a in argv], cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=log, stderr=log,
                            creationflags=subprocess.CREATE_NO_WINDOW)

discovery = report/'control.json'
def api(route, body=None):
    d = json.loads(discovery.read_text())
    req = urllib.request.Request(d['base_url']+route,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer '+d['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response: return json.load(response)

try:
    receiver = launch([sys.executable, receiver_root/'e2e/whip-reference-receiver.py', '--port', whip_port,
                       '--report', report/'receiver'], 'receiver', receiver_root)
    time.sleep(2); assert receiver.poll() is None
    relay = UdpRelay(1, True)
    signal_server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Signaling)
    threading.Thread(target=signal_server.serve_forever, daemon=True).start()
    # A real visible browser plays the frame-ID/audio clock; the app captures
    # its window and process audio, exactly as for a game or desktop app.
    page = report/'source.html'
    page.write_text('<title>WHIP Recovery Clock</title><style>html,body{margin:0;background:black;overflow:hidden}video{width:100vw;height:100vh}</style><video autoplay loop src="'+Path(args.fixture).resolve().as_uri()+'"></video>')
    source = launch(['node', '-e', '''
const {chromium}=require('playwright');
(async()=>{
 const b=await chromium.launch({channel:'chrome',headless:false,args:['--autoplay-policy=no-user-gesture-required','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
 const p=await b.newPage({viewport:null});await p.goto(process.argv[1]);
 const c=await p.context().newCDPSession(p),w=await c.send('Browser.getWindowForTarget');
 await c.send('Browser.setWindowBounds',{windowId:w.windowId,bounds:{windowState:'fullscreen'}});
 await p.waitForFunction(()=>document.querySelector('video').currentTime>1);
 require('fs').writeFileSync(process.argv[2],'ready');
 process.stdin.resume();process.stdin.on('end',async()=>{await b.close()});
})().catch(e=>{console.error(e);process.exit(1)});
''', page.as_uri(), report/'source-ready'], 'source', native)
    end = time.monotonic()+30
    while not (report/'source-ready').exists():
        assert source.poll() is None and time.monotonic()<end, 'Source did not start'
        time.sleep(.2)
    app = launch([publisher, '--headless', '--output=whip',
        '--output-url=http://127.0.0.1:'+str(signal_server.server_port)+'/whip/whip',
        '--source=window', '--window=WHIP Recovery Clock', '--resolution=1280x720', '--fps=30',
        '--video-encoder='+args.encoder, '--bitrate-kbps=4000', '--audio-source=selected-window',
        '--audio-channels=2', '--local-control', '--local-control-discovery='+str(discovery), '--duration-ms=900000'],
        'publisher', publisher.parent, {**os.environ, 'LOCALAPPDATA': str(report), 'GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING':'1'})
    end=time.monotonic()+45
    while True:
        assert app.poll() is None and time.monotonic()<end, 'Publisher did not become live'
        if discovery.exists() and api('/diagnostics').get('output',{}).get('state')==2: break
        time.sleep(.2)
    phases=[]
    for name,loss,jitter,seconds in [('baseline',0,0,10),('loss-only',.01,0,20),('moderate',.01,25,args.impaired_seconds),('restored',0,0,10)]:
        print(name, flush=True); relay.configure(name,loss,jitter); began=time.monotonic()
        while time.monotonic()-began<seconds:
            tick=time.perf_counter(); d=api('/diagnostics')
            results['samples'].append({'wall':time.monotonic(), 'apiMs':(time.perf_counter()-tick)*1000, 'output':d['output']})
            assert d['output']['state']==2 and d['output']['reconnects']==0
            time.sleep(.5)
        phases.append({'name':name,'start':began,'end':time.monotonic()})
    api('/commands', {'command':'quit'}); app.wait(timeout=30)
    with urllib.request.urlopen(f'http://127.0.0.1:{whip_port}/status') as response: received=json.load(response)
    results.update(receiver=received, phases=phases, relay=relay.snapshot())
    for phase in phases:
        frames=[f for f in received['frames'] if phase['start']<=f['wall']<phase['end']]
        audio=[a for a in received['audio'] if phase['start']<=a['wall']<phase['end']]
        phase.update(frames=len(frames),fps=len(frames)/(phase['end']-phase['start']),
            maxPtsGapMs=max(((b['pts']-a['pts'])*1000 for a,b in zip(frames,frames[1:])),default=0),
            nonIncreasingPts=sum(b['pts']<=a['pts'] for a,b in zip(frames,frames[1:])),
            audibleWindows=sum(a['rms']>.02 for a in audio))
    ffmpeg=publisher.parent/'ffmpeg/bin/ffmpeg.exe'
    decoded=subprocess.run([str(ffmpeg),'-v','error','-i',str(report/'receiver'/(received['id']+'.h264')),'-f','null','-'],capture_output=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
    results['rawDecode']={'returncode':decoded.returncode,'stderr':decoded.stderr.decode(errors='replace')}
    results['passed']=not decoded.returncode and not decoded.stderr and all(p['fps']>28 and not p['nonIncreasingPts'] and p['maxPtsGapMs']<250 and p['audibleWindows']>15 for p in phases)
finally:
    for process in (app,source,receiver):
        if process and process.poll() is None:
            try: children=psutil.Process(process.pid).children(recursive=True)
            except psutil.NoSuchProcess: children=[]
            process.terminate(); process.wait(timeout=15)
            for child in children:
                try: child.kill()
                except psutil.NoSuchProcess: pass
            psutil.wait_procs(children,timeout=5)
    if relay: relay.close()
    if signal_server: signal_server.shutdown(); signal_server.server_close()
    for log in logs: log.close()
    (report/'results.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results.get('phases'),indent=2),flush=True)
assert results.get('passed'), 'Native WHIP recovery media failed'
