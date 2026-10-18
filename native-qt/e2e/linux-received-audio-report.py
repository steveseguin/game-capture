#!/usr/bin/env python3
"""Decode the independent received-track recording, retaining audio frame PTS.

MediaRecorder re-encodes Opus; this is not the original network bitstream or a
physical playback measurement. Initial onset and every 10 ms RMS window are
retained. The 500 ms post-onset summary does not waive any continuous observer
failures, nor does concatenated PCM imply a gapless recording timeline.
"""
from array import array
from bisect import bisect_right
import argparse,hashlib,json,math,re,subprocess,sys
from pathlib import Path

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('report',type=Path);args=parser.parse_args()
    workflow=json.loads((args.report/'results.json').read_text());meta=workflow['resumeReceiverRecording']
    file=args.report/meta['path'];assert file.name==meta['path']
    assert hashlib.sha256(file.read_bytes()).hexdigest()==meta['sha256'] and file.stat().st_size==meta['bytes']
    probe=json.loads(subprocess.check_output(['/usr/bin/ffprobe','-v','error','-select_streams','a:0','-show_streams','-of','json',str(file)],timeout=15))
    assert len(probe['streams'])==1
    stream=probe['streams'][0];assert stream['codec_name']=='opus' and stream['channels']==2 and int(stream['sample_rate'])==48000
    decoded=subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-copyts','-i',str(file),'-map','0:a:0',
        '-af','aresample=48000,asettb=1/48000,ashowinfo','-ac','2','-ar','48000','-f','f32le','-'],capture_output=True,timeout=30)
    with (args.report/'resume-receiver-decode.log').open('xb') as out:out.write(decoded.stderr)
    assert decoded.returncode==0
    frames=[(int(a),int(b)) for a,b in re.findall(r'\[Parsed_ashowinfo[^\]]*\].*?pts:(-?\d+)\s.*?nb_samples:(\d+)',decoded.stderr.decode(errors='replace'))]
    assert frames and all(n>0 for _,n in frames)
    pcm=array('f');pcm.frombytes(decoded.stdout)
    if sys.byteorder!='little':pcm.byteswap()
    assert len(pcm)==2*sum(n for _,n in frames) and 48000<=len(pcm)//2<=480000 and all(math.isfinite(v) for v in pcm)
    with (args.report/'resume-receiver.f32le').open('xb') as out:out.write(decoded.stdout)
    ends=[];count=0
    for _,n in frames:count+=n;ends.append(count)
    def timestamp(index):
        k=bisect_right(ends,index);return (frames[k][0]+index-(ends[k-1] if k else 0))/48000
    windows=[]
    for first in range(0,len(pcm)//2-479,480):
        rms=[math.sqrt(sum(v*v for v in pcm[first*2+ch:(first+480)*2:2])/480) for ch in range(2)]
        windows.append({'firstFrame':first,'ptsSeconds':timestamp(first),'rms':rms,'belowFixtureFloor':min(rms)<.05})
    onset=next(w['firstFrame'] for w in windows if not w['belowFixtureFloor'])
    checked=[w for w in windows if w['firstFrame']>=onset+24000]
    assert checked
    gaps=[(b[0]-a[0]-a[1])/48 for a,b in zip(frames,frames[1:])]
    result={'scope':__doc__,'recordingSha256':meta['sha256'],'decodedSha256':hashlib.sha256(decoded.stdout).hexdigest(),
        'decodedFrames':len(pcm)//2,'decodedSeconds':len(pcm)/96000,'audioFrames':[{'pts':p,'samples':n} for p,n in frames],
        'maximumFramePtsDiscontinuityMs':max(map(abs,gaps),default=0),
        'nonmonotonicAudioFrames':sum(b[0]<=a[0] for a,b in zip(frames,frames[1:])),
        'firstToneFrame':onset,'firstTonePtsSeconds':timestamp(onset),'postOnsetSettlingMs':500,
        'minimum10msRmsAfterSettling':min(v for w in checked for v in w['rms']),
        'lowWindowsAfterSettling':[w for w in checked if w['belowFixtureFloor']],
        'clippedSamples':sum(abs(v)>=.999 for v in pcm),'windows':windows}
    result['levelChecksPassedAfterSettling']=not result['lowWindowsAfterSettling'] and not result['clippedSamples']
    with (args.report/'resume-receiver-analysis.json').open('x') as out:json.dump(result,out,indent=2);out.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['windows','audioFrames']}))

if __name__=='__main__':main()
