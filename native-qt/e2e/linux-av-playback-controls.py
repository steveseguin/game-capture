#!/usr/bin/env python3
"""Offline +/-150 ms receiver-output controls using a real paired recording.

These are rejection/measurement controls, not packaged application passes and
not absolute reference calibration. Original recordings remain unchanged.
"""
import argparse,copy,hashlib,json,shutil,subprocess,sys,uuid
from pathlib import Path

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('workflow',type=Path);parser.add_argument('--reports',required=True,type=Path);parser.add_argument('--ffmpeg',default='/usr/bin/ffmpeg');args=parser.parse_args()
    workflow=json.loads((args.workflow/'results.json').read_text());baseline=json.loads((args.workflow/'playback-comparison.json').read_text())
    assert len(workflow['phases'])==len(baseline['phases'])==1 and baseline['comparisonComplete'] and not baseline['calibrated']
    source=args.workflow/workflow['phases'][0]['receiverDesktop']['path'];originalHash=digest(source)
    assert originalHash==workflow['phases'][0]['receiverDesktop']['sha256']==baseline['phases'][0]['receiverDesktop']['sha256']
    report=args.reports.resolve()/str(uuid.uuid4());report.mkdir(parents=True);print('Reports: '+str(report),flush=True)
    for name in ['linux-av-playback-controls.py','linux-av-compare-playback.py','macos-analyze-av-sync.py']:shutil.copyfile(Path(__file__).with_name(name),report/name)
    result={'scope':__doc__,'originalWorkflow':str(args.workflow.resolve()),'originalResultsSha256':digest(args.workflow/'results.json'),'originalReceiverSha256':originalHash,'originalComparisonSha256':digest(args.workflow/'playback-comparison.json'),'cases':[],'passed':False,'absoluteTimingCalibrated':False}
    try:
        for shift in [-150,150]:
            folder=report/('shift-'+str(shift));folder.mkdir();derived=copy.deepcopy(workflow);derived['calibrationOnly']=True;derived['passed']=False
            for kind in ['source','receiver','browserSource']:
                meta=derived['phases'][0][kind];original=args.workflow/meta['path'];assert digest(original)==meta['sha256'];(folder/meta['path']).hardlink_to(original)
            shutil.copyfile(args.workflow/'av-analysis.json',folder/'av-analysis.json')
            meta=derived['phases'][0]['receiverDesktop'];target=folder/meta['path']
            command=[args.ffmpeg,'-nostdin','-v','error','-copyts','-i',str(source),'-itsoffset',str(shift/1000),'-i',str(source),'-map','0:v:0','-map','1:a:0','-c','copy','-avoid_negative_ts','disabled','-n',str(target)]
            subprocess.run(command,check=True,capture_output=True,timeout=60)
            meta.update(sha256=digest(target),bytes=target.stat().st_size,scope='Offline audio PTS shift of immutable actual receiver recording; not a new capture')
            (folder/'results.json').write_text(json.dumps(derived,indent=2)+'\n')
            with (folder/'comparison.log').open('x') as log:
                process=subprocess.run([sys.executable,str(report/'linux-av-compare-playback.py'),str(folder),'--ffmpeg',args.ffmpeg],stdout=log,stderr=subprocess.STDOUT,timeout=180)
            measured=json.loads((folder/'playback-comparison.json').read_text());assert process.returncode==0 and measured['comparisonComplete'] and not measured['qualificationPassed'] and not measured['calibrated']
            actual=measured['phases'][0];base={p['pulseId']:p for p in baseline['phases'][0]['pairs']};assert not actual['desktopSkewWithinLimit']
            deltas=[p['desktopAdditionalOffsetMs']-base[p['pulseId']]['desktopAdditionalOffsetMs'] for p in actual['pairs'] if p['pulseId'] in base]
            assert len(deltas)>=11 and max(abs(v-shift) for v in deltas)<=1.01,'Injected timing shift measured incorrectly'
            result['cases'].append({'injectedAudioOffsetMs':shift,'minimumMeasuredDeltaMs':min(deltas),'maximumMeasuredDeltaMs':max(deltas),'matchedPulses':len(deltas),'outOfLimitRejected':True,'shiftedRecordingSha256':digest(target),'comparisonSha256':digest(folder/'playback-comparison.json'),'command':command,'passed':True})
        assert digest(source)==originalHash;result['passed']=True
    except Exception as error:result['error']=str(error);raise
    finally:
        with (report/'controls.json').open('x') as out:json.dump(result,out,indent=2);out.write('\n')
        print(json.dumps({'report':str(report),'passed':result['passed'],'error':result.get('error')}))

if __name__=='__main__':main()
