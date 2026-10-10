"""Decode the OBS recording and measure its audible/visible sync pulses."""
import argparse
import json
from pathlib import Path
import subprocess
import re
import numpy as np
from scipy import signal


def summary(values):
    x=np.asarray(values)
    return None if not x.size else {'n':len(x),'median':float(np.median(x)),
        'min':float(np.min(x)),'max':float(np.max(x)),'p95':float(np.percentile(x,95))}


def main():
    p=argparse.ArgumentParser();p.add_argument('--ffmpeg',required=True);p.add_argument('folder',type=Path)
    p.add_argument('--half',choices=['left','right']);p.add_argument('--audio-stream',type=int,default=0)
    p.add_argument('--fps',type=int,default=30);a=p.parse_args()
    suffix='-'+a.half if a.half else ''
    r=json.loads((a.folder/'obs-receiver.json').read_text());recording=r['recording']
    # Preserve and inspect timestamps before stripping the streams into raw
    # buffers. An independent zero origin for each stream can fabricate skew.
    probe=subprocess.run([a.ffmpeg,'-hide_banner','-copyts','-i',recording,
        '-map','0:v:0','-map',f'0:a:{a.audio_stream}','-vf','showinfo','-af','ashowinfo','-frames:v','1','-frames:a','1','-f','null','-'],
        capture_output=True,timeout=30)
    (a.folder/('first-pts'+suffix+'.log')).write_bytes(probe.stderr)
    probe_text=probe.stderr.decode(errors='replace')
    first_pts={}
    for kind,filter_name in [('audio','ashowinfo'),('video','showinfo')]:
        match=re.search(r'\[Parsed_'+filter_name+r'_[^\]]+\].*?n:\s*0\s+pts:.*?pts_time:([-\d.]+)',probe_text)
        assert match,'Missing first '+kind+' timestamp'
        first_pts[kind]=float(match[1])
    def decode(args,name):
        result=subprocess.run([a.ffmpeg,'-hide_banner','-copyts','-i',recording,*args,'pipe:1'],capture_output=True,timeout=120)
        (a.folder/(name+'-decode'+suffix+'.log')).write_bytes(result.stderr)
        assert result.returncode==0,result.stderr.decode(errors='replace')
        return result.stdout
    crop=('crop=iw/2:ih:'+('0' if a.half=='left' else 'iw/2')+':0,') if a.half else ''
    video=np.frombuffer(decode(['-map','0:v:0','-an','-vf',crop+f'scale=320:180,fps=fps={a.fps}:start_time=0','-pix_fmt','rgb24','-f','rawvideo'],'video'),np.uint8).reshape(-1,180,320,3)
    pcm=np.frombuffer(decode(['-map',f'0:a:{a.audio_stream}','-vn','-af','aresample=48000:async=1:first_pts=0','-ac','2','-ar','48000','-f','f32le'],'audio'),'<f4').reshape(-1,2)
    # Locate the two colored sentinel rectangles in the encoded recording.
    picture=video[len(video)//2]
    cyan=(picture[:,:,0]<80)&(picture[:,:,1]>150)&(picture[:,:,2]>150)
    magenta=(picture[:,:,0]>150)&(picture[:,:,1]<80)&(picture[:,:,2]>150)
    geometry=None
    for y in range(90):
        cx=np.flatnonzero(cyan[y]);mx=np.flatnonzero(magenta[y])
        if len(cx)>2 and len(mx)>2 and mx[0]>cx[-1]+96:
            left=(cx[0]+cx[-1])/2;right=(mx[0]+mx[-1])/2;width=(right-left)/.9
            vertical=np.flatnonzero(cyan[:90,int(round(left))]);top=vertical[0];bottom=vertical[-1]
            height=(bottom-top+1)/.1;geometry=(left-width*.05,top-height*.1,width,height);break
    assert geometry,'No actual fixture video found in OBS recording'
    x,y,w,h=geometry
    barcode=np.zeros(len(video),np.uint64)
    for i in range(32):barcode|=(video[:,round(y+h*.15),round(x+w*(i+4.5)/40),0]>128).astype(np.uint64)<<i
    lights=video[:,int(y+h*.37),int(x+w*.5),0]>128
    marker=video[:,int(y+h*.15),int(x+w*.05)]
    valid_video=(marker[:,0]<80)&(marker[:,1]>150)&(marker[:,2]>150)
    first_video=np.flatnonzero(valid_video)[0]/a.fps if np.any(valid_video) else None
    active_audio=np.flatnonzero(np.max(np.abs(pcm),axis=1)>.001)
    first_audio=active_audio[0]/48000 if len(active_audio) else None
    vindices=np.flatnonzero(lights & ~np.roll(lights,1))
    vtimes=vindices/a.fps
    filtered=signal.sosfilt(signal.butter(4,[940,1060],fs=48000,btype='bandpass',output='sos'),pcm[:,0])
    n=len(pcm)//480*480
    rms=np.sqrt(np.mean(filtered[:n].reshape(-1,480)**2,axis=1))
    threshold=max(float(np.percentile(rms,98)*.4),1e-5)
    active=rms>threshold
    atimes=np.array([i*.01+.005 for i in np.flatnonzero(active & ~np.roll(active,1)) if i>50 and np.count_nonzero(active[i:i+6])>=5])
    offsets=[];pulse_pairs=[]
    for t in atimes:
        nearest=vtimes[np.argmin(np.abs(vtimes-t))] if len(vtimes) else -10
        if abs(t-nearest)<.8:
            offset=(t-nearest)*1000
            offsets.append(offset)
            vi=int(vindices[np.argmin(np.abs(vtimes-t))])
            source_ms=float(barcode[vi]);pulse_id=int(round(source_ms/2000))
            # The first observed white frame can be up to one recording frame
            # late. Its embedded source clock identifies that quantization;
            # retain the raw onset and compare the same source-clock instant.
            assert 0 <= source_ms-pulse_id*2000 < 150,'Invalid pulse barcode'
            clock_video=nearest-(source_ms-pulse_id*2000)/1000
            pulse_pairs.append({'audioSeconds':float(t),'videoSeconds':float(nearest),'offsetMs':float(offset),
                'sourcePulseId':pulse_id,'sourceMsAtVideoPulse':source_ms,
                'sourceClockVideoSeconds':float(clock_video),'sourceClockOffsetMs':float((t-clock_video)*1000)})
    spectrum=[]
    for ch in range(2):
        f,power=signal.welch(pcm[:,ch],48000,nperseg=48000)
        peaks={str(hz):float(np.sqrt(np.sum(power[(f>hz-2)&(f<hz+2)]))) for hz in [440,880,1000]}
        spectrum.append(peaks)
    result={'recording':recording,'firstPtsSeconds':first_pts,'alignment':'copyts; video fps start_time=0 and audio aresample first_pts=0 pad/trim both streams onto one recording clock',
        'secondsVideo':len(video)/a.fps,'secondsAudio':len(pcm)/48000,
        'fixtureGeometry':geometry,'decodedAudioRms':np.sqrt(np.mean(pcm**2,axis=0)).tolist(),
        'firstFixtureVideoSeconds':first_video,'firstAudibleSamplesSeconds':first_audio,
        'startupPeakSampleStep':float(np.max(np.abs(np.diff(pcm[:int((first_audio+1)*48000)],axis=0)))) if first_audio is not None else None,
        'audioToneEnergy':spectrum,'videoPulseCount':len(vtimes),'audioPulseCount':len(atimes),
        'audioMinusVideoMs':summary(offsets),'audioMinusVideoAllMs':offsets,'pulsePairs':pulse_pairs,
        'obsSkippedRenderFrames':r['after']['renderSkippedFrames']-r['before']['renderSkippedFrames'],
        'obsSkippedOutputFrames':r['after']['outputSkippedFrames']-r['before']['outputSkippedFrames'],
        'analysisFps':a.fps,
        'limitations':f'A/V difference in an actual OBS recording. {a.fps}-fps video, 10-ms audio windows and filtering limit onset precision; this is not physical display/speaker latency.'}
    result['mediaPassed']=len(vtimes)>3 and len(atimes)>3 and max(result['decodedAudioRms'])>.001
    steady=[pair for pair in pulse_pairs if pair['audioSeconds']>10]
    if len(steady)>10 and steady[-1]['audioSeconds']-steady[0]['audioSeconds']>60:
        times=np.array([pair['audioSeconds'] for pair in steady])/60
        result['steadyOffsetSlopeMsPerMinute']=float(np.polyfit(times,[pair['offsetMs'] for pair in steady],1)[0])
        result['offsetByMinute']=[{'minute':minute,'audioMinusVideoMs':summary(
            [pair['offsetMs'] for pair in steady if minute*60<=pair['audioSeconds']<(minute+1)*60])}
            for minute in range(int(steady[-1]['audioSeconds']//60)+1)]
    result['selection']={'videoHalf':a.half,'audioStream':a.audio_stream}
    (a.folder/('obs-analysis'+suffix+'.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
