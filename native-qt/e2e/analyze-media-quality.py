"""Analyze saved *decoded* media, with explicit software-timestamp limitations."""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy import signal


def describe(values):
    a=np.asarray(values,dtype=float)
    if not a.size: return None
    return {'n':len(a),'min':float(np.min(a)),'median':float(np.median(a)),
            'p95':float(np.percentile(a,95)),'max':float(np.max(a))}


def analyze(folder):
    r=json.loads((folder/'receiver.json').read_text())
    if not r.get('ok'): return {'error':r.get('error'),'case':folder.name}
    frames=json.loads((folder/'video-frames.json').read_text())
    chunks=json.loads((folder/'audio-chunks.json').read_text())
    pcm=np.fromfile(folder/'decoded.f32',dtype='<f4').reshape(-1,2)
    valid=[v for v in frames if v['valid']]
    epoch=r['source']['epoch']
    # Worklet records each block's estimated device presentation time.
    chunk_offsets=np.cumsum([0]+[c['frames'] for c in chunks])[:-1]
    n=min(len(pcm)//480*480,len(pcm)); blocks=pcm[:n].reshape(-1,480,2)
    positions=np.arange(len(blocks))*480+240
    block_wall=np.interp(positions,chunk_offsets,[c['wall'] for c in chunks])
    rms=np.sqrt(np.mean(blocks**2,axis=1))
    filtered=signal.sosfilt(signal.butter(4,[940,1060],fs=48000,btype='bandpass',output='sos'),pcm[:,0])
    pulse_rms=np.sqrt(np.mean(filtered[:n].reshape(-1,480)**2,axis=1))
    threshold=float(np.percentile(pulse_rms,98)*.4)
    active=pulse_rms>max(threshold,1e-5)
    edges=np.flatnonzero(active & ~np.roll(active,1))
    edges=[i for i in edges if i>100 and np.count_nonzero(active[i:i+6])>=5]
    video_pulses=[]
    previous=False
    for f in valid:
        if f['pulse'] and not previous:
            sequence=round(f['sourceMs']/2000)
            if abs(f['sourceMs']-sequence*2000)<150:
                video_pulses.append((sequence,f['wall'],f['sourceMs']))
        previous=f['pulse']
    pulses=[]
    for i in edges:
        wall=float(block_wall[i]);sequence=round((wall-epoch)/2000)
        matches=[v for v in video_pulses if v[0]==sequence]
        if matches:
            pulses.append({'sequence':sequence,'audioWall':wall,'videoWall':matches[0][1],
                           'audioMinusVideoMs':wall-matches[0][1],
                           'audioLatencyMs':wall-(epoch+sequence*2000)})
    # Exclude intended sync pulses, silence transitions and initial settling.
    delay=np.median([p['audioLatencyMs'] for p in pulses]) if pulses else 0
    source_time=(block_wall-epoch-delay)/1000
    clean=(source_time%2>.3)&(source_time%60<44.8)|(source_time%2>.3)&(source_time%60>50.3)
    clean &= np.arange(len(blocks))>200
    stable_rms=np.median(rms[clean],axis=0)
    gaps=(rms<stable_rms*.12)&clean[:,None]
    # A second-order sine predictor flags abrupt discontinuities. Codec noise
    # is reported as a measured residual, not automatically called audible.
    residuals=[]
    for ch,hz in enumerate((440,880)):
        x=pcm[:n,ch]
        residual=x[2:]-2*np.cos(2*np.pi*hz/48000)*x[1:-1]+x[:-2]
        residual=np.pad(residual,(2,0)).reshape(-1,480)
        residuals.append({'rms':float(np.sqrt(np.mean(residual[clean]**2))),
            'peak':float(np.max(np.abs(residual[clean]))),
            'blocksAboveQuarterToneAmplitude':int(np.count_nonzero(np.max(np.abs(residual),axis=1)[clean]>stable_rms[ch]*np.sqrt(2)*.25))})
    silence=(source_time%60>45.3)&(source_time%60<49.7)
    stats=[]
    for phase in r['phases']:
        # A new receiver can have no video RTP stats until its first keyframe.
        def inbound(snapshot,kind):return next((x for x in snapshot['stats'] if x.get('type')=='inbound-rtp' and x.get('kind')==kind),{})
        a0,a1=inbound(phase['before'],'audio'),inbound(phase['after'],'audio')
        v0,v1=inbound(phase['before'],'video'),inbound(phase['after'],'video')
        delta=lambda x,y,k:y.get(k,0)-x.get(k,0)
        duration=(phase['ended']-phase['started'])/1000
        stats.append({'phase':phase['name'],'seconds':duration,
            'decodedVideoFps':delta(v0,v1,'framesDecoded')/duration,
            'videoFramesDropped':delta(v0,v1,'framesDropped'),
            'videoPacketsLost':delta(v0,v1,'packetsLost'),
            'freezeCount':delta(v0,v1,'freezeCount'),'freezeSeconds':delta(v0,v1,'totalFreezesDuration'),
            'audioPacketsLost':delta(a0,a1,'packetsLost'),
            'concealedSamples':delta(a0,a1,'concealedSamples'),
            'concealedFraction':delta(a0,a1,'concealedSamples')/max(1,delta(a0,a1,'totalSamplesReceived')) if 'totalSamplesReceived' in a1 else None,
            'audioKbps':delta(a0,a1,'bytesReceived')*8/duration/1000,
            'meanAudioJitterBufferMs':delta(a0,a1,'jitterBufferDelay')/max(1,delta(a0,a1,'jitterBufferEmittedCount'))*1000,
            'audioBytesReceived':delta(a0,a1,'bytesReceived'),
            'videoFramesDecoded':delta(v0,v1,'framesDecoded')})
    # Source clock calibration should be nearly constant; preserve uncertainty.
    calibrations=[s['epoch'] for s in r['source']['calibrations'][-60:]]
    tones=[]
    for ch in range(2):
        freq,power=signal.welch(pcm[:,ch],48000,nperseg=48000)
        tones.append({str(hz):float(np.sqrt(np.sum(power[(freq>hz-2)&(freq<hz+2)]))) for hz in [440,880,1000]})
    final_stats=r['finish']['stats']
    negotiated={}
    for kind in ['audio','video']:
        track=next(s for s in final_stats if s.get('type')=='inbound-rtp' and s.get('kind')==kind)
        negotiated[kind]=next((s for s in final_stats if s.get('id')==track.get('codecId')),None)
    result={'case':folder.name,'publisherSha256':r['case']['sha256'],'secondsDecoded':len(pcm)/48000,
        'validBarcodeFrames':len(valid),'invalidBarcodeFrames':len(frames)-len(valid),'negotiatedCodecs':negotiated,
        'uniqueSourceFrames':sum(a['sourceMs']!=b['sourceMs'] for a,b in zip(valid,valid[1:])),
        'uniqueSourceFps':sum(a['sourceMs']!=b['sourceMs'] for a,b in zip(valid,valid[1:]))/((valid[-1]['wall']-valid[0]['wall'])/1000),
        'videoLatencyMs':describe([v['wall']-epoch-v['sourceMs'] for v in valid if v['sourceMs']>2000]),
        'videoPresentationIntervalMs':describe(np.diff([v['wall'] for v in valid])),
        'independentTrackAudioMinusVideoMs':describe([p['audioMinusVideoMs'] for p in pulses]),
        'audioLatencyMs':describe([p['audioLatencyMs'] for p in pulses]),
        'pulseMeasurements':pulses,'sourceClockEpochMs':describe(calibrations),
        'channelsRms':stable_rms.tolist(),'toneEnergy':tones,'clippedSamples':int(np.count_nonzero(np.abs(pcm)>.999)),
        'unexpectedLowEnergy10msBlocks':np.sum(gaps,axis=0).tolist(),
        'sinePredictionResidual':residuals,
        'intendedSilenceRms':np.sqrt(np.mean(blocks[silence]**2,axis=(0,1))).tolist() if np.any(silence) else None,
        'phases':stats,
        'limitations':'Audio is observed through an independent MediaStreamAudioSource, bypassing HTML video A/V synchronization: its offset MUST NOT be presented as browser lip sync. Same-machine estimated clocks; not physical microphone/camera latency. Pulse onset includes 5-ms ramp, filtering and 10-ms analysis granularity. Residuals are diagnostics, not a listening verdict.'}
    if any(s['phase']=='recovered' for s in stats):
        recovery=next(s for s in stats if s['phase']=='recovered')
        result['networkImpairmentActuallyObserved']=all(s['audioPacketsLost']>10 for s in stats if s['phase'].startswith('loss-'))
        result['recoveryPlaybackPassed']=recovery['decodedVideoFps']>20 and recovery['audioBytesReceived']>10000
    resources=folder/'resources.jsonl'
    if resources.exists():
        samples=[json.loads(s) for s in resources.read_text().splitlines()]
        result['resources']={k:describe([s[k] for s in samples[5:]]) for k in ['rss','private','handles','threads','cpuPercentOneCore']}
    (folder/'analysis.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('folder',type=Path);args=parser.parse_args()
    print(json.dumps(analyze(args.folder),indent=2))
