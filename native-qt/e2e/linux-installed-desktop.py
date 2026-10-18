#!/usr/bin/env python3
"""Exercise an installed DEB through its desktop entry inside an owned container.

Run as an ordinary user under linux-private-desktop.py and Xvfb. The host
controller performs package changes only while this workflow reports ready.
No host desktop, audio socket, device or Docker socket belongs in the container.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def source_window():
    import tkinter as tk
    root = tk.Tk(); root.title('Game Capture Installed Source'); root.geometry('640x360+30+30')
    canvas = tk.Canvas(root, width=640, height=360, highlightthickness=0); canvas.pack(fill='both', expand=True)
    identity = 0
    def draw():
        nonlocal identity
        identity = (identity+1) % 65536
        w, h = canvas.winfo_width(), canvas.winfo_height()
        canvas.delete('all'); canvas.create_rectangle(0, 0, w, h, fill='#183042', outline='')
        for x, color in [(.1, 'cyan'), (.85, 'magenta')]:
            canvas.create_rectangle(x*w, .25*h, (x+.05)*w, .75*h, fill=color, outline='')
        for bit in range(16):
            canvas.create_rectangle((.2+bit*.6/16)*w, .25*h, (.2+(bit+1)*.6/16)*w, .75*h,
                                    fill='white' if identity & (1 << bit) else 'black', outline='')
        root.after(33, draw)
    root.after(100, draw); root.mainloop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', action='store_true')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--single', action='store_true', help='Clean-install launch and saved-settings relaunch without package transitions')
    args = parser.parse_args()
    if args.source: return source_window()
    assert os.getuid() != 0 and args.output and os.environ.get('GC_QA_PRIVATE_DESKTOP')
    report = args.output.resolve(); report.mkdir(parents=True, exist_ok=True)
    result = {'scope':__doc__, 'uid':os.getuid(), 'passed':False, 'phases':[],
              'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    helper = Path(__file__).with_name('linux-ui-control.py')
    source = receiver = None; app_pid = None; logs = []
    def save(): (report/'results.json').write_text(json.dumps(result, indent=2)+'\n')
    def wait(check, seconds=15):
        end = time.monotonic()+seconds
        while not check():
            if time.monotonic() > end: raise RuntimeError('Installed workflow observation timed out')
            time.sleep(.1)
    def app_pids():
        found = []
        for p in Path('/proc').iterdir():
            if not p.name.isdigit(): continue
            try:
                if (p/'exe').resolve(strict=True) == Path('/usr/bin/game-capture') and p.stat().st_uid == os.getuid(): found.append(int(p.name))
            except OSError: pass
        return found
    def ui(*values):
        return subprocess.check_output([sys.executable, str(helper), str(app_pid), *values], text=True, timeout=12)
    def screenshot(name):
        from PIL import ImageGrab
        ImageGrab.grab().save(report/(name+'.png'))
    def transition(name):
        result['awaiting'] = name; save(); print(json.dumps({'awaiting':name}), flush=True)
        wait(lambda:(report/('continue-'+name)).exists(), 900)
        del result['awaiting']; save()
    def launch_and_stream(label, restore):
        nonlocal app_pid, receiver
        assert not app_pids(), 'Unexpected existing application'
        log = (report/(label+'-launcher.log')).open('w'); logs.append(log)
        subprocess.run(['gtk-launch','game-capture'], stdout=log, stderr=log, check=True, timeout=10)
        wait(lambda:len(app_pids())==1); app_pid = app_pids()[0]
        rows = json.loads(ui('dump'))
        version = subprocess.check_output(['dpkg-query','-W','-f=${Version}','game-capture'], text=True)
        phase = {'label':label, 'packageVersion':version, 'executableSha256':hashlib.sha256(Path('/usr/bin/game-capture').read_bytes()).hexdigest(), 'pid':app_pid, 'passed':False}
        result['phases'].append(phase); save()
        advanced = next(r for r in rows if r['name']=='Show advanced settings')
        if 'checked' not in advanced['states']: ui('press','Show advanced settings')
        rows = json.loads(ui('dump'))
        if any(r['role']=='combo box' and r['name']=='VDO.Ninja (default)' for r in rows):
            ui('choose','VDO.Ninja (default)','UDP / MPEG-TS (LAN)')
        if restore:
            rows = json.loads(ui('dump'))
            for name in ['Software (x264 / VP9 / AV1 / HEVC)', '960x540', '30', 'No audio']:
                assert any(r['role']=='combo box' and r['name']==name for r in rows), 'Saved setting missing: '+name
            assert json.loads(ui('read-text','Output URL'))=='udp://127.0.0.1:18892'
            phase['settingsRestored'] = True
        else:
            ui('text','Output URL','udp://127.0.0.1:18892')
            ui('choose','Auto (Hardware, then Software)','Software (x264 / VP9 / AV1 / HEVC)')
            ui('choose','1280x720','960x540'); ui('choose','60','30')
            rows = json.loads(ui('dump'))
            audio = next(r['name'] for r in rows if r['role']=='combo box' and r['name'] in ['Selected window/app audio','No audio'])
            if audio != 'No audio': ui('choose',audio,'No audio')
        assert not any(r['name']=='Stop streaming' for r in json.loads(ui('dump'))), 'Application resumed publishing automatically'
        ui('source','Game Capture Installed Source'); screenshot(label+'-ready')
        raw = report/(label+'-received.rgb'); rxlog=(report/(label+'-receiver.log')).open('w');logs.append(rxlog)
        receiver = subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-threads','2','-filter_threads','1',
            '-analyzeduration','200000','-probesize','500000','-i','udp://127.0.0.1:18892?fifo_size=8192&overrun_nonfatal=1',
            '-an','-vf','scale=160:90','-pix_fmt','rgb24','-frames:v','60','-f','rawvideo',str(raw)],stdout=rxlog,stderr=rxlog)
        ui('press','Go live'); receiver.wait(timeout=30); assert receiver.returncode==0
        pixels=raw.read_bytes(); size=160*90*3;assert len(pixels)==60*size
        from PIL import Image
        identities=[]
        for offset in range(0,len(pixels),size):
            image=Image.frombytes('RGB',(160,90),pixels[offset:offset+size]);row=[image.getpixel((x,45)) for x in range(160)]
            cyan=next((x for x,(r,g,b) in enumerate(row) if r<70 and g>170 and b>170),None)
            magenta=next((x for x,(r,g,b) in enumerate(row) if r>170 and g<70 and b>170),None)
            assert cyan is not None and magenta is not None and magenta-cyan>80
            width=(magenta-cyan)/.75; left=cyan-width*.1; identity=0
            for bit in range(16):
                r,g,b=row[round(left+width*(.2+(bit+.5)*.6/16))]
                assert max(r,g,b)-min(r,g,b)<45 and not 85<r<170
                if r>127: identity|=1<<bit
            identities.append(identity)
        assert len(set(identities))>=20, 'Decoded source is frozen'
        Image.frombytes('RGB',(160,90),pixels[:size]).save(report/(label+'-received.png'))
        phase.update(decodedFrames=60,uniqueIdentities=len(set(identities)),receivedSha256=hashlib.sha256(pixels).hexdigest())
        ui('press','Stop streaming')
        wait(lambda:any(r['name']=='Go live' and 'sensitive' in r['states'] for r in json.loads(ui('dump'))))
        screenshot(label+'-stopped'); ui('quit-menu');wait(lambda:not app_pids());app_pid=None
        phase['passed']=True;save();print(json.dumps({'phase':label,'passed':True}),flush=True)
    try:
        source_log=(report/'source.log').open('w');logs.append(source_log)
        source=subprocess.Popen([sys.executable,__file__,'--source'],stdout=source_log,stderr=source_log)
        time.sleep(1)
        launch_and_stream('initial',False)
        if args.single:
            launch_and_stream('relaunched',True)
        else:
            transition('upgrade');launch_and_stream('upgraded',True)
            transition('remove')
            assert not Path('/usr/bin/game-capture').exists() and not Path('/usr/share/applications/game-capture.desktop').exists()
            removed=subprocess.run(['gtk-launch','game-capture'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=10)
            assert removed.returncode!=0 and not app_pids();result['removedLauncherUnavailable']=True
            transition('reinstall');launch_and_stream('reinstalled',True)
        result['passed']=True
    except Exception as error:
        result['error']=repr(error)
        try: screenshot('failure')
        except Exception: pass
    finally:
        if app_pid in app_pids(): os.kill(app_pid,signal.SIGTERM)
        for process in [receiver,source]:
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill();process.wait(timeout=5)
        for log in logs:log.close()
        save();print(json.dumps({'passed':result['passed'],'error':result.get('error')}),flush=True)
    return 0 if result['passed'] else 1


if __name__=='__main__': raise SystemExit(main())
