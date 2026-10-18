#!/usr/bin/env python3
"""Localize A/V offsets using received RTP and exact native frame identities.

Linux-only diagnostic: RTP wrap is disambiguated against the publisher host's
CLOCK_MONOTONIC. Video RTP timestamps must exactly match native submission trace
entries, whose frame IDs join the source's pulse barcode trace. Audio is decoded
with libopus directly, without browser buffering or re-encoding. No independent
absolute calibration or physical playback qualification is claimed.
"""
import argparse,csv,gzip,hashlib,importlib.util,json,statistics,sys
from pathlib import Path
import numpy as np

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('report',type=Path);parser.add_argument('--output-dir',type=Path);args=parser.parse_args();report=args.report
    output=args.output_dir or report;output.mkdir(parents=True,exist_ok=True)
    workflow=json.loads((report/'results.json').read_text());assert workflow['rtpTiming'] and workflow['traceCapture']
    sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    trace=report/workflow['frameTrace']['path'];assert sha(trace)==workflow['frameTrace']['sha256']
    rows=list(csv.DictReader(trace.read_text().splitlines()));captures={}
    for row in rows:
        if row['stage']!='submit':continue
        timestamp=int(row['output100ns']);rtp=(timestamp//10000000*90000+(timestamp%10000000)*90000//10000000)&0xffffffff
        assert rtp not in captures,'Ambiguous native submission RTP timestamp'
        captures[rtp]={'output100ns':timestamp,'capture100ns':int(row['capture100ns']),'id':int(row['id']),'wallMs':int(row['wallMs'])}
    anchor=workflow['rtpClockAnchor']['monotonicNs']/1e9
    def unwrap(stamp,rate):
        base=stamp/rate;period=2**32/rate
        time=base+round((anchor-base)/period)*period
        assert abs(time-anchor)<180,'RTP timestamp does not fit bounded capture'
        return time
    source={};presentation=[];inputHashes={}
    for sample in workflow['samples']:
        file=report/sample['file'];assert sha(file)==sample['sha256'];inputHashes[file.name]=sha(file)
        data=json.loads(gzip.decompress(file.read_bytes()))
        for row in data['trace']:
            frame_id=row['frameId']
            if frame_id in source:assert source[frame_id]['stamp']==row['stamp'],'Ambiguous source frame ID wrap'
            source[frame_id]=row
        presentation.extend(data['observed']['presentation'])
    joined=[];missingCapture=missingSource=0
    for row in presentation:
        capture=captures.get(row['rtpTimestamp'])
        if capture is None:missingCapture+=1;continue
        draw=source.get(capture['id'])
        if draw is None or abs(draw['wall']-capture['wallMs'])>1000:missingSource+=1;continue
        time=unwrap(row['rtpTimestamp'],90000)
        assert abs(time-capture['output100ns']/1e7)<=1/90000+1e-8
        joined.append({**row,'capture100ns':capture['capture100ns'],'output100ns':capture['output100ns'],'frameId':capture['id'],'stamp':draw['stamp'],'rtpSeconds':time})
    assert joined and len(joined)>=len(presentation)*.9,'Insufficient exact RTP/native/source joins'
    pulses={}
    for row in joined:
        pulse,phase=divmod(row['stamp'],256)
        if phase>=16:continue
        previous=pulses.get(pulse)
        if previous is None or row['rtpSeconds']<previous['videoRtpSeconds']:
            pulses[pulse]={'pulseId':pulse,'videoRtpSeconds':row['rtpSeconds'],'videoClockSeconds':row['rtpSeconds']-phase/100,'sourcePhaseMs':phase*10,'frameId':row['frameId'],'rtpTimestamp':row['rtpTimestamp']}
    spec=importlib.util.spec_from_file_location('opus_copy',Path(__file__).with_name('linux-decode-opus-report.py'));decoder=importlib.util.module_from_spec(spec);spec.loader.exec_module(decoder)
    meta,audio,packets,discontinuities,version=decoder.decode(report);assert not discontinuities
    pcm=np.asarray(audio,dtype=np.float32).reshape(-1,2);n=len(pcm)//480
    window=np.hanning(480);spectrum=np.fft.rfft(pcm[:n*480,0].reshape(n,480)*window,axis=1)
    amplitude=2*np.abs(spectrum[:,10])/window.sum();active=amplitude>.03
    starts=np.flatnonzero(active & ~np.concatenate(([False],active[:-1])))
    ends=np.array([p['firstFrame']+p['frames'] for p in packets])
    def sample_time(index):
        p=packets[int(np.searchsorted(ends,index,side='right'))]
        return unwrap(p['rtpTimestamp'],48000)+(index-p['firstFrame'])/48000
    beeps=[sample_time(int(i)*480+240) for i in starts if i+8<=n and np.count_nonzero(active[i:i+8])>=6]
    original=json.loads((report/'av-analysis.json').read_text());references={p['pulseId']:p for p in original['phases'][0]['pairs']}
    pairs=[];used=set()
    for pulse in sorted(pulses.values(),key=lambda p:p['pulseId']):
        if pulse['pulseId'] not in references:continue
        distance,index,beep=min((abs(t-pulse['videoRtpSeconds']),i,t) for i,t in enumerate(beeps))
        assert distance<.5 and index not in used;used.add(index)
        offset=(beep-pulse['videoClockSeconds'])*1000;reference=references[pulse['pulseId']]
        pairs.append({**pulse,'audioRtpSeconds':beep,'rtpOffsetMs':offset,'sourceRecordedOffsetMs':reference['sourceOffsetMs'],
            'receiverRecordedOffsetMs':reference['receiverOffsetMs'],'rtpMinusSourceRecordedMs':offset-reference['sourceOffsetMs'],
            'receiverRecordedMinusRtpMs':reference['receiverOffsetMs']-offset})
    assert len(pairs)>=max(8,workflow['seconds']//2-4)
    def summary(key):
        values=[p[key] for p in pairs];return {'minimum':min(values),'median':statistics.median(values),'maximum':max(values)}
    raw=pcm.astype('<f4').tobytes()
    with (output/'rtp-audio-decoded.f32le').open('xb') as out:out.write(raw)
    result={'scope':__doc__,'calibrated':False,'qualificationPassed':False,'analysisComplete':True,
        'inputs':{**inputHashes,trace.name:sha(trace),'received-opus.jsonl':meta['sha256'],'av-analysis.json':sha(report/'av-analysis.json')},
        'libopusVersion':version,'decodedAudioSha256':hashlib.sha256(raw).hexdigest(),'audioFrames':len(pcm),'rtpDiscontinuities':discontinuities,
        'videoPresentationRows':len(presentation),'exactJoinedVideoFrames':len(joined),'missingNativeSubmission':missingCapture,'missingSourceDraw':missingSource,
        'audioPulseTimes':beeps,'pairs':pairs,'summary':{k:summary(k) for k in ['rtpOffsetMs','rtpMinusSourceRecordedMs','receiverRecordedMinusRtpMs']}}
    with (output/'rtp-av-analysis.json').open('x') as out:json.dump(result,out,indent=2);out.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['inputs','pairs','audioPulseTimes']}))

if __name__=='__main__':main()
