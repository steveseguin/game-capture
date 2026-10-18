"""Exercise packaged Mac GUI diagnostics export on ordinary and refused shutdown writes."""
import argparse,hashlib,json,os,subprocess,threading,time,uuid
from pathlib import Path
from urllib.request import Request,urlopen

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app',type=Path,required=True)
parser.add_argument('--expected-executable-sha256',required=True)
parser.add_argument('--reports',type=Path,required=True)
args=parser.parse_args()
exe=args.app.resolve()/'Contents/MacOS/game-capture'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(exe)==args.expected_executable_sha256
report=args.reports.resolve()/str(uuid.uuid4());report.mkdir(parents=True)
result={'scope':__doc__,'executableSha256':sha(exe),'harnessSha256':sha(Path(__file__)),'cases':[],'passed':False}
(report/'harness.py').write_bytes(Path(__file__).read_bytes())
def save():(report/'results.json').write_text(json.dumps(result,indent=2)+'\n')
def call(control,route,body=None):
 data=json.dumps(body).encode() if body else None
 request=Request(control['base_url']+route,data=data,headers={'Authorization':'Bearer '+control['token'],'Content-Type':'application/json'})
 with urlopen(request,timeout=5) as response:return json.load(response)
print('Reports:',report,flush=True);save()
try:
 for iteration in range(2):
  for refused in [False,True]:
   case=report/(f'{iteration}-'+('refused' if refused else 'ordinary'))
   case.mkdir();output=case/'snapshot.json';control_path=case/'private-control.json'
   if refused:output.mkdir();(output/'sentinel').write_text('preserve directory')
   else:output.write_text('{"previous":"preserve until committed"}')
   entry={'iteration':iteration,'refusedDestination':refused,'passed':False};result['cases'].append(entry);save()
   env={k:v for k,v in os.environ.items() if not k.startswith(('QT_','DYLD_','GAME_CAPTURE_','VERSUS_','GH_','GITHUB_','ACTIONS_'))}
   process=None;observer=None;stop=threading.Event();reads=[0];invalid=[0];control=None
   try:
    with (case/'private-gui.log').open('wb') as log:
     process=subprocess.Popen([str(exe),'--temporary-settings','--local-control','--local-control-port=0','--local-control-discovery='+str(control_path),'--diagnostics-out='+str(output)],env=env,stdout=log,stderr=subprocess.STDOUT)
     deadline=time.monotonic()+20
     while not control_path.exists():
      if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('GUI did not expose its control endpoint')
      time.sleep(.05)
     control=json.loads(control_path.read_text());assert control['pid']==process.pid
     before=call(control,'/diagnostics');assert not before['app']['live']
     if not refused:
      def observe():
       while not stop.is_set():
        try:
         value=output.read_text();reads[0]+=1;json.loads(value)
        except (json.JSONDecodeError,UnicodeDecodeError):invalid[0]+=1
        except OSError:pass
      observer=threading.Thread(target=observe);observer.start()
     call(control,'/commands',{'command':'quit'});process.wait(timeout=15)
     stop.set()
     if observer:observer.join(timeout=5);assert not observer.is_alive()
     entry.update(exitCode=process.returncode,discoveryRemoved=not control_path.exists(),reads=reads[0],incomplete=invalid[0])
     assert process.returncode==0 and entry['discoveryRemoved']
     if refused:
      entry['directoryPreserved']=output.is_dir() and (output/'sentinel').read_text()=='preserve directory' and len(list(output.iterdir()))==1
      assert entry['directoryPreserved']
     else:
      current=json.loads(output.read_text());entry['snapshotUpdated']='previous' not in current and isinstance(current.get('app'),dict)
      assert entry['snapshotUpdated'] and reads[0]>0 and invalid[0]==0
      entry['snapshotSha256']=sha(output)
     entry['passed']=True
   finally:
    stop.set()
    if observer:observer.join(timeout=5)
    if process and process.poll() is None:
     try:
      if control:call(control,'/commands',{'command':'quit'})
      process.wait(timeout=5)
     except Exception:process.terminate();process.wait(timeout=5)
    save()
 result['passed']=True
except Exception as error:result['error']=str(error)
finally:save();print(json.dumps({'report':str(report),'passed':result['passed'],'error':result.get('error')}),flush=True)
raise SystemExit(0 if result['passed'] else 1)
