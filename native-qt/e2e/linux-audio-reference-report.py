#!/usr/bin/env python3
"""Analyze the owned playback reference; sample offsets are not absolute timing."""
from array import array
import argparse,hashlib,json,math,sys
from pathlib import Path

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('report',type=Path);args=parser.parse_args()
    meta=json.loads((args.report/'resume-source.json').read_text());raw=(args.report/meta['path']).read_bytes()
    assert not meta['error'] and meta['exitCode']==0 and len(raw)==meta['bytes']
    assert hashlib.sha256(raw).hexdigest()==meta['sha256'] and len(raw)%8==0
    pcm=array('f');pcm.frombytes(raw)
    if sys.byteorder!='little':pcm.byteswap()
    assert all(math.isfinite(v) for v in pcm)
    windows=[];tones=[]
    for first in range(0,len(pcm)//2-479,480):
        rms=[math.sqrt(sum(v*v for v in pcm[first*2+ch:(first+480)*2:2])/480) for ch in range(2)]
        windows.append({'firstFrame':first,'rms':rms,'belowFixtureFloor':min(rms)<.05})
    for first in range(0,len(pcm)//2-4799,4800):
        amplitudes=[]
        for ch in range(2):
            values=pcm[first*2+ch:(first+4800)*2:2];channel=[]
            for hz in [440,880,2000]:
                coefficient=2*math.cos(2*math.pi*hz/48000);q1=q2=0
                for value in values:q0=value+coefficient*q1-q2;q2=q1;q1=q0
                channel.append(2*math.sqrt(max(0,q1*q1+q2*q2-coefficient*q1*q2))/4800)
            amplitudes.append(channel)
        valid=all(ch[i]>=.005 and ch[i]>=10*ch[1-i] and ch[2]<=ch[i]/10**(25/20) for i,ch in enumerate(amplitudes))
        tones.append({'firstFrame':first,'amplitudes':amplitudes,'routingPassed':valid})
    checked=[w for w in windows if w['firstFrame']>=9600]
    result={'scope':__doc__,'rawSha256':meta['sha256'],'seconds':len(pcm)/96000,'initialSettlingMs':200,
        'minimum10msRmsAfterSettling':min(v for w in checked for v in w['rms']),
        'lowWindowsAfterSettling':[w for w in checked if w['belowFixtureFloor']],
        'clippedSamples':sum(abs(v)>=.999 for v in pcm),'windows':windows,'tones':tones,
        'routingPassedAfterSettling':all(w['routingPassed'] for w in tones if w['firstFrame']>=9600)}
    result['continuityPassedAfterSettling']=not result['lowWindowsAfterSettling'] and not result['clippedSamples'] and result['routingPassedAfterSettling']
    with (args.report/'resume-source-analysis.json').open('x') as out:json.dump(result,out,indent=2);out.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['windows','tones']}))

if __name__=='__main__':main()
