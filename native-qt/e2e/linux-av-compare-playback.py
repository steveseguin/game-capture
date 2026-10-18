#!/usr/bin/env python3
"""Compare visible receiver drawable/Pulse output with source and MediaRecorder.

Both desktop recordings preserve FFmpeg input timestamps using a common origin
within each recording. They remain uncalibrated software references; no physical
display/speaker latency or absolute timing qualification is established here.
All existing MediaRecorder qualification results remain separate and unchanged.
"""
import argparse,importlib.util,json,statistics
from pathlib import Path

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('report',type=Path);parser.add_argument('--ffmpeg',required=True);args=parser.parse_args()
    spec=importlib.util.spec_from_file_location('av_analysis',Path(__file__).with_name('macos-analyze-av-sync.py'));analyzer=importlib.util.module_from_spec(spec);spec.loader.exec_module(analyzer)
    workflow=json.loads((args.report/'results.json').read_text());analysis=json.loads((args.report/'av-analysis.json').read_text())
    assert workflow['receiverDesktop'] and workflow['sourceReference']=='desktop' and workflow['receiverPlayback']=='owned-sink'
    result={'scope':__doc__,'calibrated':False,'qualificationPassed':False,'comparisonComplete':False,'maximumSkewMs':analysis['maximumSkewMs'],'phases':[]}
    try:
        for phase in workflow['phases']:
            measured=next(p for p in analysis['phases'] if p['name']==phase['name']);meta=phase['receiverDesktop']
            for kind in ['source','receiver']:
                original=phase[kind];assert Path(original['path']).name==original['path']
                assert analyzer.digest(args.report/original['path'])==original['sha256']==measured[kind]['sha256']
            assert Path(meta['path']).name==meta['path'] and analyzer.digest(args.report/meta['path'])==meta['sha256']
            assert meta['closed'] and meta['exitCode']==0 and not meta['calibrated'] and meta['role']=='receiver'
            playback=analyzer.analyze(args.report/meta['path'],args.ffmpeg)
            span=(meta['ended']-meta['anchorMs'])/1000;ready=(meta['ready']-meta['anchorMs'])/1000
            bounds=(0<=playback['firstVideoPts']<=ready+1 and -2<=playback['firstAudioPts']<=ready+1 and playback['firstVideoPts']<playback['videoObservations'][-1]['pts']<=span+1)
            assert bounds,'Receiver desktop PTS do not fit common wall-clock origin'
            source={p['id']:p for p in measured['source']['pairs']};recorded={p['id']:p for p in measured['receiver']['pairs']};pairs=[]
            for pulse in playback['pairs']:
                pid=pulse['id']
                if pid not in source or pid not in recorded:continue
                pairs.append({'pulseId':pid,'sourceDesktopOffsetMs':source[pid]['offsetMs'],'receiverDesktopOffsetMs':pulse['offsetMs'],
                    'receiverRecordedOffsetMs':recorded[pid]['offsetMs'],'desktopAdditionalOffsetMs':pulse['offsetMs']-source[pid]['offsetMs'],
                    'recordedAdditionalOffsetMs':recorded[pid]['offsetMs']-source[pid]['offsetMs'],'recordedMinusDesktopMs':recorded[pid]['offsetMs']-pulse['offsetMs']})
            def summary(key):
                values=[p[key] for p in pairs];return {'minimum':min(values,default=None),'median':statistics.median(values) if values else None,'maximum':max(values,default=None)}
            complete=bool(playback['mediaPassed'] and measured['source']['mediaPassed'] and measured['receiver']['mediaPassed'] and len(pairs)>=max(8,workflow['seconds']//2-4))
            result['phases'].append({'name':phase['name'],'receiverDesktop':playback,'pairs':pairs,'recordingTimelineBoundsPassed':bounds,
                'comparisonComplete':complete,'desktopSkewWithinLimit':bool(complete and all(abs(p['desktopAdditionalOffsetMs'])<=result['maximumSkewMs']+1e-6 for p in pairs)),
                'summary':{k:summary(k) for k in ['desktopAdditionalOffsetMs','recordedAdditionalOffsetMs','recordedMinusDesktopMs']}})
        result['comparisonComplete']=bool(result['phases']) and all(p['comparisonComplete'] for p in result['phases'])
    except Exception as error:
        result['error']=str(error);raise
    finally:
        with (args.report/'playback-comparison.json').open('x') as out:json.dump(result,out,indent=2);out.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k!='phases'}))
    if not result['comparisonComplete']:raise SystemExit(1)

if __name__=='__main__':main()
