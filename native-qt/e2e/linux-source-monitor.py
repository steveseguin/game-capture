#!/usr/bin/env python3
"""Move one explicitly owned disposable Chrome fixture to the right monitor."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, GLib

parser=argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--title', required=True)
placement=parser.add_mutually_exclusive_group()
placement.add_argument('--fit-image', type=Path)
placement.add_argument('--verify-image', type=Path)
args=parser.parse_args()
assert os.environ.get('GC_QA_WAYLAND_DESKTOP') and os.environ.get('GC_QA_KEYBOARD_SOCKET')
assert args.title.startswith('Owned Linux Capture AV ')
proc=Path(f'/proc/{args.pid}')
assert proc.joinpath('exe').resolve()==Path('/opt/google/chrome/chrome')
assert proc.stat().st_uid==os.getuid()
command=proc.joinpath('cmdline').read_bytes().rstrip(b'\0').split(b'\0')
# This Chrome build rewrites its process title into one argv string. Parse it
# as data only; still require the exact disposable profile and native backend.
if len(command)==1: command=[part.encode() for part in shlex.split(command[0].decode())]
profiles=[Path(v.decode().split('=',1)[1]) for v in command if v.startswith(b'--user-data-dir=')]
assert len(profiles)==1 and profiles[0].name.startswith('playwright_chromiumdev_profile-'), f'Unexpected owned Chrome profiles: {profiles}; argument count: {len(command)}'
assert profiles[0].parent==Path('/tmp') and profiles[0].stat().st_uid==os.getuid()
assert b'--ozone-platform=wayland' in command

def owned(pid):
    for _ in range(12):
        if pid==args.pid: return True
        if pid<=1: return False
        try:
            status=Path(f'/proc/{pid}/status').read_text()
            pid=int(next(line for line in status.splitlines() if line.startswith('PPid:')).split()[1])
        except (FileNotFoundError,ProcessLookupError): return False
    return False

def nodes(node):
    yield node
    for i in range(node.get_child_count()):
        child=node.get_child_at_index(i)
        if child: yield from nodes(child)

def pump():
    while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)

deadline=time.monotonic()+10
frame=None
observed=[]
while time.monotonic()<deadline:
    pump();desktop=Atspi.get_desktop(0);matches=[]
    observed=[]
    for i in range(desktop.get_child_count()):
        app=desktop.get_child_at_index(i)
        if app and owned(app.get_process_id()):
            candidates=[n for n in nodes(app) if n.get_name().startswith(args.title)]
            observed.extend({'role':n.get_role_name(),'states':[str(s) for s in n.get_state_set().get_states()]} for n in candidates)
            matches.extend(n for n in candidates if n.get_role_name()=='frame')
    assert len(matches)<=1, 'More than one owned source window'
    if matches and matches[0].get_state_set().contains(Atspi.StateType.ACTIVE): frame=matches[0];break
    time.sleep(.1)
assert frame is not None, 'The explicitly owned Chrome source is not active: '+json.dumps(observed)
def bounds():
    r=frame.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
    return [r.x,r.y,r.width,r.height]
before=bounds()
def keys(sequence):
    subprocess.run([sys.executable,str(Path(__file__).with_name('linux-portal-select.py')),'--keys',*sequence],check=True,timeout=8)

result={'pid':args.pid,'title':args.title,'before':before}
if args.fit_image or args.verify_image:
    from PIL import Image, ImageChops
    source=args.fit_image or args.verify_image
    assert source.is_file() and source.stat().st_uid==os.getuid()
    image=Image.open(source).convert('RGB');assert image.size==(1440,1000)
    r,g,b=image.split()
    cyan=ImageChops.multiply(ImageChops.multiply(r.point(lambda v:255 if v<70 else 0),g.point(lambda v:255 if v>170 else 0)),b.point(lambda v:255 if v>170 else 0)).getbbox()
    magenta=ImageChops.multiply(ImageChops.multiply(r.point(lambda v:255 if v>170 else 0),g.point(lambda v:255 if v<70 else 0)),b.point(lambda v:255 if v>170 else 0)).getbbox()
    assert cyan and abs(cyan[2]-cyan[0]-51.2)<=2 and abs(cyan[3]-cyan[1]-432)<=2, 'Full owned cyan fixture marker is absent'
    left,top=cyan[0]-64,cyan[1]-144
    result.update(canvasBounds=[left,top,1280,720],cyan=cyan,magenta=magenta)
    if args.fit_image:
        horizontal=round((80-left)/10);vertical=round((140-top)/10)
        assert abs(horizontal)<=50 and abs(vertical)<=50, 'Owned window is outside the bounded adjustment range'
        result['moveSteps']=[horizontal,vertical]
        if horizontal or vertical:
            keys(['ALT_F7'])
            moves=['RIGHT' if horizontal>0 else 'LEFT']*abs(horizontal)+['DOWN' if vertical>0 else 'UP']*abs(vertical)
            for start in range(0,len(moves),12):keys(moves[start:start+12])
            keys(['ENTER'])
    else:
        assert left>=0 and top>=90 and left+1280<=1440 and top+720<=1000, 'Owned source is clipped by the monitor'
        assert magenta and abs(magenta[0]-(left+.91*1280))<=2 and abs(magenta[2]-magenta[0]-51.2)<=2 and abs(magenta[1]-cyan[1])<=2 and abs(magenta[3]-cyan[3])<=2, 'Full owned magenta fixture marker is absent'
        result['passed']=True
else:
    keys(['SUPER_SHIFT_RIGHT'])
time.sleep(.3);pump()
assert frame.get_state_set().contains(Atspi.StateType.ACTIVE), 'Owned source lost focus'
result['after']=bounds()
print(json.dumps(result))
