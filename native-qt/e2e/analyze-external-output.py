"""Decode actual receiver recordings without inventing independent A/V origins."""
import argparse,json,re,subprocess
from pathlib import Path
import numpy as np
from scipy import signal

def distribution(values):
    x=np.asarray(values)
    return None if not len(x) else dict(n=len(x),median=float(np.median(x)),min=float(min(x)),max=float(max(x)),p95=float(np.percentile(x,95)))

def analyze(ffmpeg,case,phase):
    recording=Path(phase['recording'])
    def decode(extra,name):
        p=subprocess.run([ffmpeg,'-hide_banner','-copyts','-i',str(recording),*extra,'pipe:1'],capture_output=True,timeout=120)
        recording.with_suffix('.'+name+'.log').write_bytes(p.stderr)
        assert p.returncode==0,p.stderr.decode(errors='replace')[-1000:]
        return p.stdout,p.stderr.decode(errors='replace')
    raw,log=decode(['-map','0:v:0','-an','-vf','scale=160:90,showinfo','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo'],'video')
    frames=np.frombuffer(raw,np.uint8).reshape(-1,90,160,3)
    times=np.array([float(x) for x in re.findall(r'Parsed_showinfo[^\n]*?\bn:\s*\d+\s+pts:.*?pts_time:([-\d.]+)',log)])
    assert len(times)==len(frames) and len(frames)>300,'No continuous decoded video'
    assert np.all(np.diff(times)>0),'Non-monotonic video timestamps'
    pic=frames[len(frames)//2];cyan=(pic[:,:,0]<80)&(pic[:,:,1]>140)&(pic[:,:,2]>140);magenta=(pic[:,:,0]>140)&(pic[:,:,1]<80)&(pic[:,:,2]>140)
    geometry=None
    for y in range(45):
        cx=np.flatnonzero(cyan[y]);mx=np.flatnonzero(magenta[y])
        if len(cx)>2 and len(mx)>2 and mx[0]>cx[-1]+48:
            left=(cx[0]+cx[-1])/2;right=(mx[0]+mx[-1])/2;w=(right-left)/.9
            vertical=np.flatnonzero(cyan[:45,round(left)]);top=vertical[0];h=(vertical[-1]-top+1)/.1
            geometry=(left-w*.05,top-h*.1,w,h);break
    assert geometry,'No fixture picture in decoded video'
    x,y,w,h=geometry
    barcode=np.zeros(len(frames),np.uint64)
    for i in range(32):barcode|=(frames[:,round(y+h*.15),round(x+w*(i+4.5)/40),0]>128).astype(np.uint64)<<i
    lights=frames[:,round(y+h*.37),round(x+w*.5),0]>128
    vtimes=times[np.flatnonzero(lights & ~np.roll(lights,1))]
    elapsed=times[-1]-times[0];changes=np.count_nonzero(np.diff(barcode.astype(np.int64))>0)
    result={'recording':str(recording),'videoFrames':len(frames),'seconds':float(elapsed),'decodedFps':float((len(frames)-1)/elapsed),
            'distinctSourceFramesPerSecond':float(changes/elapsed),'frameGapMs':distribution(np.diff(times)*1000),'videoPulses':len(vtimes),'fixtureGeometry':geometry}
    if not case['silent']:
        raw,_=decode(['-map','0:a:0','-vn','-af','aresample=48000:async=1:first_pts=0','-ac','2','-ar','48000','-f','f32le'],'audio')
        pcm=np.frombuffer(raw,'<f4').reshape(-1,2);n=len(pcm)//480*480;pcm=pcm[:n]
        compressed,_=decode(['-map','0:a:0','-vn','-c:a','copy','-f','data'],'audio-packets')
        blocks=pcm.reshape(-1,480,2);at=np.arange(len(blocks))*.01+.005
        source_ms=np.interp(at,times,barcode.astype(float));valid=(at>times[0]+2)&(at<times[-1]-1)
        intended_silence=(source_ms%60000>45200)&(source_ms%60000<49800)
        active_expected=valid&~((source_ms%60000>44800)&(source_ms%60000<50200))
        rms=np.sqrt(np.mean(blocks**2,axis=1));high=signal.sosfiltfilt(signal.butter(6,6000,fs=48000,btype='highpass',output='sos'),pcm,axis=0).reshape(-1,480,2)
        filtered=signal.sosfilt(signal.butter(4,[940,1060],fs=48000,btype='bandpass',output='sos'),pcm[:,0]);pulse_rms=np.sqrt(np.mean(filtered.reshape(-1,480)**2,axis=1))
        active=pulse_rms>max(np.percentile(pulse_rms,98)*.4,1e-5)
        atimes=at[[i for i in np.flatnonzero(active & ~np.roll(active,1)) if valid[i] and np.count_nonzero(active[i:i+6])>=5]]
        offsets=[]
        for t in atimes:
            near=vtimes[np.argmin(abs(vtimes-t))] if len(vtimes) else -100
            if abs(t-near)<.8:offsets.append((t-near)*1000)
        tones=[]
        for ch in range(2):
            f,power=signal.welch(pcm[:,ch],48000,nperseg=48000)
            tones.append({str(hz):float(np.sqrt(np.sum(power[abs(f-hz)<3]))) for hz in [440,880,1000,3000]})
        result.update(audioSeconds=len(pcm)/48000,compressedAudioKbps=len(compressed)*8/(len(pcm)/48000)/1000,
            requestedAudioKbps=case.get('bitrateKbps',192),audioMinusVideoMs=distribution(offsets),audioPulses=len(atimes),tones=tones,
            unexpectedLowEnergy10ms=int(np.count_nonzero(np.max(rms,axis=1)[active_expected]<.001)),
            clippedSamples=int(np.count_nonzero(abs(pcm)>=.999)),highFrequencyPeak=float(np.max(abs(high[valid]))),
            highFrequencyWindowsAbove002=int(np.count_nonzero(np.max(abs(high[valid]),axis=(1,2))>.02)),
            intentionalSilencePeak=float(np.max(abs(blocks[intended_silence&valid]))) if np.any(intended_silence&valid) else None)
        assert offsets and len(offsets)>=4,'Too few matching A/V pulses'
        result['uncalibratedRawOffsetWithin80ms']=bool(max(abs(np.array(offsets)))<80)
        # Process-loopback audio precedes the fixture's audible-time drawing;
        # even direct OBS source capture can exceed this raw 80-ms bound.
        # Judge added A/V skew using the separate simultaneous reference.
        result['audioPassed']=bool(result['unexpectedLowEnergy10ms']==0 and result['clippedSamples']==0 and result['highFrequencyWindowsAbove002']==0)
        if case['channels']==2:result['channelsPassed']=tones[0]['440']>tones[0]['880']*10 and tones[1]['880']>tones[1]['440']*10
        else:result['channelsPassed']=all(t['440']>.005 and t['880']>.005 for t in tones)
    result['passed']=result['distinctSourceFramesPerSecond']>55 and result['frameGapMs']['p95']<25 and result.get('audioPassed',True) and result.get('channelsPassed',True)
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('folder',type=Path);p.add_argument('--ffmpeg',required=True);a=p.parse_args()
    report=json.loads((a.folder/'results.json').read_text());results=[]
    for case in report['cases']:
        for phase in case['phases']:
            try:row=analyze(a.ffmpeg,case,phase)
            except Exception as e:row={'recording':phase['recording'],'error':str(e),'passed':False}
            row.update(id=case['id'],phase=phase['phase']);results.append(row);print(json.dumps(row),flush=True)
    output={'publisherSha256':report['sha256'],'cases':results,'passed':bool(results) and all(r['passed'] for r in results),
        'scope':'Decoded video cadence, audio continuity and channels. A/V synchronization requires the separate simultaneous OBS source/receiver comparison.',
        'limits':'Software decoded media; timestamps preserved. 10 ms audio analysis windows and captured-frame timing limit sync precision. High-frequency discontinuity indicators do not replace human listening.'}
    (a.folder/'analysis.json').write_text(json.dumps(output,indent=2),encoding='utf-8')
    assert output['passed'],'Quality analysis failed; inspect the preserved recordings and per-case measurements'
