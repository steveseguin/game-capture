#!/usr/bin/env python3
"""Inspect browser output captured from its owned null sink.

The intentional source pause must appear as exactly one internal silence longer
than a second. Retain all samples and 10 ms windows; report tone levels/routing
before and after that pause with a declared 500 ms onset allowance. This is not
physical speaker measurement or calibrated sample alignment with RTP/Web Audio.
"""
from array import array
import argparse,hashlib,json,math,sys
from pathlib import Path

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('report',type=Path);args=parser.parse_args()
    meta=json.loads((args.report/'receiver-playout.json').read_text());assert meta['path']=='receiver-playout.f32le'
    raw=(args.report/meta['path']).read_bytes()
    assert not meta['error'] and meta['exitCode']==0 and len(raw)==meta['bytes'] and len(raw)%8==0
    assert hashlib.sha256(raw).hexdigest()==meta['sha256']
    pcm=array('f');pcm.frombytes(raw)
    if sys.byteorder!='little':pcm.byteswap()
    assert all(math.isfinite(v) for v in pcm)
    windows=[]
    for first in range(0,len(pcm)//2-479,480):
        rms=[math.sqrt(sum(v*v for v in pcm[first*2+ch:(first+480)*2:2])/480) for ch in range(2)]
        windows.append({'firstFrame':first,'rms':rms,'belowFixtureFloor':min(rms)<.05,'silent':max(rms)<.0005})
    runs=[];start=None
    for i,w in enumerate(windows+[{'silent':False}]):
        if w['silent']:
            if start is None:start=i
        elif start is not None:
            if i-start>=100:runs.append({'firstFrame':start*480,'endFrame':i*480})
            start=None
    internal=[r for r in runs if r['firstFrame']>=48000 and r['endFrame']<=len(pcm)//2-48000]
    assert len(internal)==1,('Expected one intentional internal pause',runs)
    pause=internal[0]
    first=next(w['firstFrame'] for w in windows if not w['belowFixtureFloor'])
    resumed=next(w['firstFrame'] for w in windows if w['firstFrame']>=pause['endFrame'] and not w['belowFixtureFloor'])
    # Leave the pre-pause fade out in the transition region. The entire raw
    # recording and every level window remain available for independent review.
    ranges={'beforePause':(first+24000,pause['firstFrame']-24000),'afterResume':(resumed+24000,len(pcm)//2)}
    summaries={}
    for name,(begin,end) in ranges.items():
        checked=[w for w in windows if begin<=w['firstFrame'] and w['firstFrame']+480<=end]
        assert len(checked)>=100,('Insufficient playout tone coverage',name)
        tones=[]
        for offset in range(begin,end-4799,4800):
            amplitudes=[]
            for ch in range(2):
                values=pcm[offset*2+ch:(offset+4800)*2:2];channel=[]
                for hz in [440,880,2000]:
                    coefficient=2*math.cos(2*math.pi*hz/48000);q1=q2=0
                    for value in values:q0=value+coefficient*q1-q2;q2=q1;q1=q0
                    channel.append(2*math.sqrt(max(0,q1*q1+q2*q2-coefficient*q1*q2))/4800)
                amplitudes.append(channel)
            valid=all(ch[i]>=.005 and ch[i]>=10*ch[1-i] and ch[2]<=ch[i]/10**(25/20) for i,ch in enumerate(amplitudes))
            tones.append({'firstFrame':offset,'amplitudes':amplitudes,'routingPassed':valid})
        zeroRuns=[];zeroStart=None
        for i in range(begin,end+1):
            zero=i<end and pcm[i*2]==0 and pcm[i*2+1]==0
            if zero:
                if zeroStart is None:zeroStart=i
            elif zeroStart is not None:
                if i-zeroStart>2:zeroRuns.append({'firstFrame':zeroStart,'frames':i-zeroStart})
                zeroStart=None
        summaries[name]={'beginFrame':begin,'endFrame':end,'checked10msWindows':len(checked),
            'minimum10msRms':min(v for w in checked for v in w['rms']),
            'lowWindows':[w for w in checked if w['belowFixtureFloor']],
            'routingPassed':bool(tones) and all(t['routingPassed'] for t in tones),'tones':tones,'exactZeroRunsBothChannels':zeroRuns}
    clipped=sum(abs(v)>=.999 for v in pcm)
    result={'scope':__doc__,'rawSha256':meta['sha256'],'seconds':len(pcm)/96000,'sampleRate':48000,
        'pause':pause,'firstToneFrame':first,'resumedToneFrame':resumed,'onsetAllowanceMs':500,
        'beforePauseTransitionMs':500,'clippedSamples':clipped,'windows':windows,'segments':summaries}
    result['passedAfterTransitions']=not clipped and all(not s['lowWindows'] and s['routingPassed'] and not s['exactZeroRunsBothChannels'] for s in summaries.values())
    with (args.report/'receiver-playout-analysis.json').open('x') as out:json.dump(result,out,indent=2);out.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['windows','segments']}))

if __name__=='__main__':main()
