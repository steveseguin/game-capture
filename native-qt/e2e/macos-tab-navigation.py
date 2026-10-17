#!/usr/bin/env python3
"""Exercise packaged Mac forward/reverse Tab navigation in isolated idle settings.

Scenario setup uses native accessibility actions and one guarded popup click.
Navigation uses keyboard events directed to the owned application PID. System
keyboard preferences are observed, never changed. This is not VoiceOver coverage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app',required=True,type=Path)
    parser.add_argument('--ui-helper',required=True,type=Path)
    parser.add_argument('--reports',required=True,type=Path)
    args=parser.parse_args()
    app=args.app.resolve();helper=args.ui_helper.resolve();exe=app/'Contents/MacOS/game-capture'
    assert (app/'Contents/Frameworks').is_dir(),'Use a deployed application'
    report=args.reports.resolve()/str(uuid.uuid4());report.mkdir(parents=True)
    sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    for p in [Path(__file__),Path(__file__).with_name('macos-ui-control.mm')]:shutil.copy2(p,report/p.name)
    result={'scope':__doc__,'executableSha256':sha(exe),'harnessSha256':sha(Path(__file__)),
            'uiHelperSha256':sha(helper),'arguments':sys.argv[1:],'scenarios':[],'passed':False}
    preference=subprocess.run(['/usr/bin/defaults','read','-g','AppleKeyboardUIMode'],capture_output=True,text=True)
    result['keyboardPreference']={'readExitCode':preference.returncode,'value':preference.stdout.strip() or None,
                                  'meaning':'Observed existing global preference; absent means no explicit override was read'}
    child=None;control=None
    settings=report/'private-settings';discovery=report/'private-control.json'
    def save(): (report/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    def ui(action,*values):
        return subprocess.check_output([str(helper),str(child.pid),action,*values],text=True,stderr=subprocess.PIPE,timeout=10)
    def rows():return json.loads(ui('dump'))
    def field(name):return next((r for r in rows() if r.get('AXIdentifier','').endswith('.'+name)),None)
    def wait(check,message,seconds=8):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            assert child.poll() is None,'Owned app exited during '+message
            value=check()
            if value:return value
            time.sleep(.08)
        raise AssertionError(message)
    def api(route,body=None):
        request=urllib.request.Request(control['base_url']+route,data=json.dumps(body).encode() if body else None,
            headers={'Authorization':'Bearer '+control['token'],'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=5) as response:return json.load(response)
    def idle():
        d=api('/diagnostics');assert not d['app']['live'] and not d['app']['capturing']
        assert d['video']['frames_sent']==0 and d['metrics']['audio_packets_sent']==0
    def choose(name,value):
        if field(name).get('AXTitle')!=value:
            ui('press',name);ui('press',value)
            wait(lambda:field(name).get('AXTitle')==value,'Selection did not commit: '+name)
    def focus():
        focused=[r for r in rows() if r.get('AXFocused') and (r.get('AXIdentifier') or r.get('AXRole')=='AXWindow')]
        if not focused:return None
        r=max(focused,key=lambda r:r.get('depth',0))
        return {'identifier':r.get('AXIdentifier'),'role':r.get('AXRole'),
                'key':r.get('AXIdentifier') or '<native-window-focus>'}
    def cycle(direction,start,case,key):
        sequence=[start];seen={start['key']}
        case[key]=sequence;save()
        for _ in range(160):
            case['pendingKey']={'direction':direction,'from':sequence[-1]};save()
            ui('key',direction)
            def moved():
                current=focus()
                return current if current and current['key']!=sequence[-1]['key'] else None
            current=wait(moved,'Focus did not move after '+direction,2)
            sequence.append(current);case.pop('pendingKey',None);save()
            if current['key']==start['key']:return sequence
            assert current['key'] not in seen,'Focus loop excluded starting control'
            seen.add(current['key'])
        raise AssertionError('Tab cycle did not close in 160 steps')
    env={k:v for k,v in os.environ.items() if not k.startswith(('QT_','DYLD_','GAME_CAPTURE_','VERSUS_'))}
    print('Reports:',report,flush=True);save()
    with (report/'private-app.log').open('w') as log:
        try:
            child=subprocess.Popen([str(exe),'--settings-dir='+str(settings),'--local-control','--local-control-port=0',
                '--local-control-discovery='+str(discovery)],cwd=report,env=env,stdout=log,stderr=subprocess.STDOUT)
            wait(discovery.exists,'Control discovery did not appear',15)
            control=json.loads(discovery.read_text());assert control['pid']==child.pid
            wait(lambda:field('sourceModeSelect'),'Source control did not appear',15)
            subprocess.run(['/usr/bin/open','-a',str(app),'--args','--settings-dir='+str(settings),'--local-control',
                '--local-control-port=0','--local-control-discovery='+str(discovery)],check=True,capture_output=True,timeout=10)
            ui('activate');idle()
            scenarios=[('Window','VDO.Ninja (default)',None),('Camera / Webcam','WHIP',None),
                       ('Syphon (texture sharing)','SRT (caller)',None),('Window','RTMP / RTMPS',None),
                       ('Window','VDO.Ninja (default)','VP9 (Software, experimental)'),
                       ('Window','VDO.Ninja (default)','AV1 (Software, experimental)')]
            for source,output,codec in scenarios:
                case={'source':source,'output':output,'codecSelection':codec,'passed':False};result['scenarios'].append(case);save()
                choose('sourceModeSelect',source)
                if not int(field('advancedToggle').get('AXValue',0)):ui('press','advancedToggle')
                wait(lambda:field('outputSelect'),'Output selector did not appear')
                choose('outputSelect',output)
                choose('bitrateSelect','Custom')
                if not int(field('audioEncodingToggle').get('AXValue',0)):ui('press','audioEncodingToggle')
                if codec:
                    choose('encoderSelect','Software (x264 / VP9 / AV1)');choose('codecSelect',codec)
                idle()
                ui('scroll-to','sourceModeSelect');time.sleep(.2)
                case['initialMouseAudit']=json.loads(ui('click','sourceModeSelect'));time.sleep(.25);ui('key','escape')
                wait(lambda:field('sourceModeSelect').get('AXFocused'),'Source menu did not retain keyboard focus')
                baseline=rows();(report/(str(len(result['scenarios']))+'-private-ui.json')).write_text(json.dumps(baseline,indent=2)+'\n')
                # These control classes carry text/value settings. Report other
                # roles separately because native button Tab policy is global.
                roles={'AXMenuButton','AXComboBox','AXTextField','AXIncrementor'}
                required=[r for r in baseline if r.get('AXRole') in roles and r.get('AXEnabled') and r.get('AXIdentifier')]
                start=focus();assert start
                cycle('tab',start,case,'forward')
                cycle('shift-tab',start,case,'reverse')
                forward=[r['key'] for r in case['forward']]
                reverse=[r['key'] for r in case['reverse']]
                case['windowFocusStops']=sum(r['role']=='AXWindow' for r in case['forward'])
                assert reverse==list(reversed(forward)),'Reverse Tab traversal differed from forward order'
                covered=lambda ident:any(r['identifier'] and (r['identifier']==ident or r['identifier'].startswith(ident+'.') or
                    (r['role'] in {'AXMenuButton','AXIncrementor'} and ident.startswith(r['identifier']+'.'))) for r in case['forward'])
                case['requiredControls']=[{'identifier':r['AXIdentifier'],'role':r['AXRole'],'reached':covered(r['AXIdentifier'])} for r in required]
                case['unreachedControls']=[r for r in case['requiredControls'] if not r['reached']]
                case['otherControls']=[{'identifier':r['AXIdentifier'],'role':r['AXRole'],'reached':covered(r['AXIdentifier'])}
                    for r in baseline if r.get('AXRole') in {'AXButton','AXCheckBox','AXRadioButton'} and r.get('AXEnabled') and r.get('AXIdentifier')]
                idle();save()
                assert not case['unreachedControls'],'Enabled settings were not reachable with Tab'
                case['passed']=True;save()
            api('/commands',{'command':'quit'});child.wait(timeout=10)
            assert child.returncode==0 and not discovery.exists()
            result['passed']=True
        except Exception as error:
            result['error']=repr(error)
            if isinstance(error,subprocess.CalledProcessError):result['toolError']=error.stderr
            if child and child.poll() is None:
                try:(report/'private-failure-ui.json').write_text(ui('dump'))
                except Exception:pass
        finally:
            if child and child.poll() is None:
                try:
                    if control:api('/commands',{'command':'quit'})
                    child.wait(timeout=5)
                except Exception:
                    child.terminate()
                    try:child.wait(timeout=3)
                    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)
            result['exitCode']=child.returncode if child else None;save()
    print(json.dumps({'report':str(report),'passed':result['passed'],'error':result.get('error')}))
    return 0 if result['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
