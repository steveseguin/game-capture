#!/usr/bin/env python3
"""Packaged ARM/amd64 GUI on an owned GNOME desktop: real portal consent,
cancel/retry, optional source restoration, crop, moving H.264 reception and cleanup.
Run inside linux-owned-wayland-desktop.py and linux-wayland-desktop.py.
This does not qualify physical monitors, hardware encoding or desktop-wide shortcuts.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import traceback
import urllib.request
import uuid
import dbus
import numpy as np


def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--publisher',type=Path,required=True)
    p.add_argument('--manifest-sha256',required=True)
    p.add_argument('--reports',type=Path,required=True)
    a = p.parse_args()
    assert os.getuid() != 0 and os.environ.get('GC_QA_OWNED_WAYLAND') and os.environ.get('GC_QA_WAYLAND_DESKTOP')
    exe = a.publisher.resolve(); bundle = exe.parent.parent.parent
    manifest_path = bundle/'release-artifact-manifest.json'
    assert sha(manifest_path) == a.manifest_sha256
    manifest = json.loads(manifest_path.read_text())
    for entry in manifest['payload']['files']:
        file = (bundle/entry['relativePath']).resolve()
        assert file.is_relative_to(bundle) and sha(file) == entry['sha256']
    launcher = bundle/manifest.get('launcher',manifest['artifact']['path'])
    report = a.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True,mode=0o700)
    helpers = Path(__file__).parent
    result = {'scope':__doc__,'passed':False,'manifestSha256':sha(manifest_path),'executableSha256':sha(exe),
              'harnessSha256':sha(__file__),'phases':[],'packageSourceTree':manifest['sourceTreeSha256']}
    save = lambda:(report/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    logs=[]; processes=[]; app=None; control=None
    def launch(args,name,stdin=None):
        log=(report/(name+'.log')).open('w');logs.append(log)
        child=subprocess.Popen(args,stdin=stdin,stdout=log,stderr=log);processes.append(child);return child
    def wait(check,description,seconds=25):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            if check(): return
            if app: assert app.poll() is None,'Publisher exited'
            time.sleep(.15)
        raise AssertionError(description)
    def ui(*args): return subprocess.check_output([sys.executable,str(helpers/'linux-ui-control.py'),str(app.pid),*args],text=True,timeout=60)
    def rows(): return json.loads(ui('dump'))
    def diag():
        request=urllib.request.Request(control['base_url']+'/diagnostics',headers={'Authorization':'Bearer '+control['token']})
        with urllib.request.urlopen(request,timeout=5) as r:return json.load(r)
    bus=dbus.SessionBus()
    def portal_owner(): return str(bus.get_name_owner('org.freedesktop.impl.portal.desktop.gnome'))
    def selector(label,cancel=False):
        return launch([sys.executable,str(helpers/'linux-portal-select.py'),'--title=Owned Linux Capture Native GTK Source',
                       '--output='+str(report/(label+'-portal.json')),*(['--cancel'] if cancel else [])],label+'-portal')
    def idle():
        d=diag(); assert not d['app']['live'] and not d['app']['capturing'];return d
    def stop():
        ui('press','Stop streaming');wait(lambda:not diag()['app']['capturing'],'Stop failed');idle()
    def receive(label):
        transport=report/(label+'.ts'); raw=report/(label+'.rgb')
        subprocess.run(['ffmpeg','-v','error','-y','-i',destination+'?fifo_size=1000000&overrun_nonfatal=1',
                        '-t','5','-map','0:v:0','-c','copy',str(transport)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=25)
        subprocess.run(['ffmpeg','-v','error','-y','-threads','2','-filter_threads','1','-i',str(transport),
                        '-an','-vf','scale=160:90','-pix_fmt','rgb24','-f','rawvideo',str(raw)],check=True,timeout=20)
        frames=np.fromfile(raw,dtype=np.uint8).reshape(-1,90,160,3); assert len(frames)>=90
        identities=[]
        for frame in frames:
            row=frame[45].astype(int)
            cyan=np.flatnonzero((row[:,0]<70)&(row[:,1]>170)&(row[:,2]>170));magenta=np.flatnonzero((row[:,0]>170)&(row[:,1]<70)&(row[:,2]>170))
            assert len(cyan) and len(magenta),'Missing moving-source markers'
            width=(int(magenta[0])-int(cyan[0]))/.75;left=int(cyan[0])-width*.1
            identity=0
            for bit in range(16):
                pixel=row[round(left+width*(.2+(bit+.5)*.6/16))]
                assert max(pixel)-min(pixel)<45 and not 85<pixel[0]<170,'Corrupt source barcode'
                if pixel[0]>127: identity |= 1<<bit
            identities.append(identity)
        assert len(set(identities))>=30,'Frozen received video'
        result['phases'].append({'name':label,'decodedFrames':len(frames),'uniqueIdentities':len(set(identities)),
             'transportSha256':sha(transport),'decodedVideoSha256':sha(raw),'diagnostics':diag()});save()
    print('Wayland report:',report,flush=True);save()
    try:
        source=launch([sys.executable,str(helpers/'linux-gtk-source.py')],'source',subprocess.PIPE)
        time.sleep(2); assert source.poll() is None, 'Native GTK source exited; inspect source.log'
        discovery=report/'private-control.json'
        app=launch([str(launcher),'--settings-dir='+str(report/'settings'),'--local-control','--local-control-port=0',
                    '--local-control-discovery='+str(discovery)],'publisher')
        wait(discovery.exists,'No control endpoint');control=json.loads(discovery.read_text());assert control['pid']==app.pid
        wait(lambda:any(r['name']=='Show advanced settings' for r in rows()),'GUI absent')
        ui('press','Show advanced settings')
        ui('choose','VDO.Ninja (default)','UDP / MPEG-TS (LAN)')
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        destination=f'udp://127.0.0.1:{port}'
        ui('text','Output URL',destination)
        ui('choose','Auto (Hardware, then Software)','Software (x264 / VP9 / AV1 / HEVC)')
        ui('choose','1280x720','960x540')
        if manifest['architecture']=='amd64':ui('choose','60','30')
        audio=next(r['name'] for r in rows() if r['role']=='combo box' and r['name'] in ('No audio','Selected window/app audio'))
        if audio!='No audio':ui('choose',audio,'No audio')
        microphone = next(r['name'] for r in rows() if r['role']=='combo box' and ('microphone' in r['name'].lower() or r['name']=='No microphone'))
        if microphone != 'No microphone': ui('choose',microphone,'No microphone')
        ui('source','Choose a window')
        # Cancel a real picker, then retry in the same process.
        picker=selector('cancel',True);ui('press','Go live')
        assert picker.wait(timeout=30)==0
        wait(lambda:any(r['name']=='Go live' and 'sensitive' in r['states'] for r in rows()),'Cancel did not restore controls');idle()
        owner=portal_owner();result['cancelReturnedIdle']=True;save()
        ui('press','Remember Wayland source')
        original_size = None
        for cycle in range(2):
            if cycle:
                for edge in ('left','top','right','bottom'):ui('value','Crop '+edge,'10')
            ui('press','Go live')
            # A compositor may grant persistence for monitors but not windows.
            # Only select again when the actual application remains pending.
            time.sleep(2)
            restored=diag()['app']['live']
            if not restored:
                picker=selector('capture-'+str(cycle));assert picker.wait(timeout=30)==0
            wait(lambda:diag()['app']['live'],'Capture failed after picker')
            assert portal_owner()==owner,'Portal backend restarted'
            dimensions = (diag()['source']['width'],diag()['source']['height'])
            if cycle: assert dimensions == tuple(n-20 for n in original_size), (original_size, dimensions)
            else: original_size = dimensions
            result['originalSourceDimensions'] = original_size
            result.setdefault('restoredWithoutChooser',[]).append(restored)
            receive('window-'+str(cycle));stop()
        # An unsupported shortcut portal must leave ordinary controls usable.
        ui('press','Enable global shortcuts');time.sleep(6)
        result['shortcutStatus']=[r['name'] for r in rows() if r['role']=='label' and ('shortcut' in r['name'].lower() or 'Start or stop streaming' in r['name'])]
        ui('press','Enable global shortcuts');idle()
        ui('quit-menu');assert app.wait(timeout=15)==0
        assert not discovery.exists(), 'Quit left control discovery behind'
        app=launch([str(launcher),'--settings-dir='+str(report/'settings'),'--local-control','--local-control-port=0',
                    '--local-control-discovery='+str(discovery)],'relaunched-publisher')
        wait(discovery.exists,'No relaunched control endpoint');control=json.loads(discovery.read_text());assert control['pid']==app.pid
        wait(lambda:any(r['name']=='Show advanced settings' for r in rows()),'Relaunched GUI absent');idle()
        assert any(r['name']=='Remember Wayland source' and 'checked' in r['states'] for r in rows())
        ui('source','Choose a window');ui('press','Go live');time.sleep(2)
        restored=diag()['app']['live']
        if not restored:
            picker=selector('relaunched-capture');assert picker.wait(timeout=30)==0
        wait(lambda:diag()['app']['live'],'Capture failed after relaunch')
        assert (diag()['source']['width'],diag()['source']['height'])==tuple(n-20 for n in original_size)
        result['relaunchedRestoredWithoutChooser']=restored
        receive('relaunched-window');stop()
        ui('quit-menu');assert app.wait(timeout=15)==0
        result['discoveryRemoved']=not discovery.exists();assert result['discoveryRemoved']
        result['portalSurvived']=portal_owner()==owner;assert result['portalSurvived']
        result['passed']=True
    except Exception:
        result['error']=traceback.format_exc()
        try:(report/'failure-diagnostics.json').write_text(json.dumps(diag(),indent=2))
        except Exception:pass
        try:(report/'failure-ui.json').write_text(ui('dump'))
        except Exception:pass
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=8)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        for log in logs:log.close()
        result['ownedProcessesRetired']=all(p.poll() is not None for p in processes);save()
        print(json.dumps({'report':str(report/'results.json'),'passed':result['passed']}),flush=True)
    return 0 if result['passed'] else 1
if __name__=='__main__':sys.exit(main())
