#!/usr/bin/env python3
"""Own a temporary GNOME virtual monitor; retire it on stdin EOF.

QA only, using the host Mutter ScreenCast v4 API and PipeWire. Does not call
ApplyMonitorsConfig or persist a monitor layout. The physical HDMI source stays
on the original monitor while the camera GUI runs on the virtual monitor.
"""
import argparse
import json
from pathlib import Path
import select
import subprocess
import sys
import time
import dbus
import dbus.mainloop.glib
from gi.repository import GLib

parser = argparse.ArgumentParser()
parser.add_argument('--report', required=True, type=Path)
args = parser.parse_args()
assert args.report.is_dir()
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
display = dbus.Interface(bus.get_object('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig'), 'org.gnome.Mutter.DisplayConfig')
before = display.GetCurrentState()
assert len(before[1]) == len(before[2]) == 1, 'This HDMI fixture requires one original monitor'
assert list(before[2][0][:5]) == [0, 0, 1.0, 0, 1], 'Unexpected original layout'
result = {'before': before, 'passed': False}
session = process = None
try:
    cast = dbus.Interface(bus.get_object('org.gnome.Mutter.ScreenCast', '/org/gnome/Mutter/ScreenCast'), 'org.gnome.Mutter.ScreenCast')
    session_path = cast.CreateSession(dbus.Dictionary({}, signature='sv'))
    session = dbus.Interface(bus.get_object('org.gnome.Mutter.ScreenCast', session_path), 'org.gnome.Mutter.ScreenCast.Session')
    stream = session.RecordVirtual(dbus.Dictionary({'cursor-mode': dbus.UInt32(0)}, signature='sv'))
    nodes = []
    bus.add_signal_receiver(lambda node: nodes.append(int(node)), signal_name='PipeWireStreamAdded', dbus_interface='org.gnome.Mutter.ScreenCast.Stream', path=stream)
    session.Start()
    deadline = time.monotonic()+10
    while not nodes and time.monotonic()<deadline:
        while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
        time.sleep(.05)
    assert len(nodes)==1, 'No owned PipeWire node'
    with (args.report/'virtual-monitor-gstreamer.log').open('wb') as log:
        process = subprocess.Popen(['gst-launch-1.0','-q','pipewiresrc','path='+str(nodes[0]),'!','video/x-raw,width=1280,height=900,format=BGRx,framerate=0/1','!','fakesink','sync=false'],stdout=log,stderr=log)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            assert process.poll() is None, 'Virtual monitor consumer exited'
            active=display.GetCurrentState()
            if len(active[1])==2: break
            time.sleep(.1)
        assert len(active[1])==len(active[2])==2
        assert active[1][0]==before[1][0] and active[2][0]==before[2][0], 'Original monitor changed'
        assert list(active[2][1][:5])==[800,0,1.0,0,0], 'Owned virtual monitor must be on the right'
        result.update(active=active,node=nodes[0],session=str(session_path),stream=str(stream))
        print(json.dumps({'ready':True,'node':nodes[0],'bounds':[800,0,1280,900]}),flush=True)
        while True:
            assert process.poll() is None, 'Virtual monitor consumer exited'
            if select.select([sys.stdin],[],[],.2)[0] and not sys.stdin.buffer.read(1): break
        result['passed']=True
except Exception as error:
    result['error']=str(error)
    raise
finally:
    if process and process.poll() is None:
        process.terminate();process.wait(timeout=10)
    if session: session.Stop()
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        restored=display.GetCurrentState()
        if restored[1:]==before[1:]: break
        time.sleep(.1)
    result['restored']=restored
    result['layoutRestored']=restored[1:]==before[1:]
    result['passed']=result['passed'] and result['layoutRestored']
    (args.report/'virtual-monitor.json').write_text(json.dumps(result,indent=2)+'\n')
    assert result['layoutRestored'], 'Original monitor layout was not restored'
