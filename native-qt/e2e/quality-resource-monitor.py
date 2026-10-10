"""Measure the real publisher process without changing its behavior."""
import argparse
import ctypes
import json
from pathlib import Path
import time
import frida
import psutil

p=argparse.ArgumentParser()
p.add_argument('--pid',type=int,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
# Keep the interactive capture fixture awake for long soaks. This request is
# scoped to this process/thread and disappears on exit; no power plan changes.
ctypes.windll.kernel32.SetThreadExecutionState(0x80000003)
proc=psutil.Process(a.pid)
events=[]
session=frida.attach(a.pid)
script=session.create_script('''
Process.attachModuleObserver({onAdded(m){
  if (/game-capture|Qt6|qschannel|opus|avcodec/i.test(m.name)) send({kind:'module',path:m.path});
  for(const n of ['MessageBeep','Beep','PlaySoundW','PlaySoundA']){
    const p=m.findExportByName(n); if(p) Interceptor.attach(p,{onEnter(){send({kind:'sound',api:n});}});
  }
}});
''')
script.on('message',lambda m,d:events.append({'time':time.time(),**m.get('payload',m)}))
script.load()
with a.output.open('w',encoding='utf-8') as f:
    while True:
        try:
            m=proc.memory_info()
            row={'time':time.time(),'pid':proc.pid,'path':proc.exe(),'rss':m.rss,'private':m.private,
                 'handles':proc.num_handles(),'threads':proc.num_threads(),'cpuPercentOneCore':proc.cpu_percent(),
                 'children':[{'pid':c.pid,'name':c.name(),'rss':c.memory_info().rss} for c in proc.children()]}
            f.write(json.dumps(row)+'\n');f.flush()
            time.sleep(1)
        except psutil.NoSuchProcess:
            break
a.output.with_suffix('.events.json').write_text(json.dumps(events,indent=2),encoding='utf-8')
