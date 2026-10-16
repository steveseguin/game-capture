"""Supplemental FFmpeg/AMD driver characterization, not an app workflow test."""
import argparse,json,subprocess,time,hashlib,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--ffmpeg',type=Path,required=True);p.add_argument('--fixture',type=Path,required=True);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
out=a.report.resolve();out.mkdir(parents=True,exist_ok=True);results={'scope':'Bundled FFmpeg and driver characterization; no application transport receiver','ffmpegSha256':hashlib.sha256(a.ffmpeg.read_bytes()).hexdigest(),'cases':[]}
def run(args,**kwargs):return subprocess.run([str(a.ffmpeg),*map(str,args)],capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW,timeout=120,**kwargs)
for codec,encoder in [('h264','h264_amf'),('hevc','hevc_amf'),('av1','av1_amf')]:
    name=codec+'-720p30';file=out/(name+'.mkv');started=time.monotonic()
    extra=['-bf','0','-forced_idr','1','-aud','1','-header_spacing','1'] if codec=='h264' else ['-forced_idr','1','-aud','1','-header_insertion_mode','idr'] if codec=='hevc' else []
    args=['-hide_banner','-y','-i',a.fixture,'-t','10','-map','0:v:0','-map','0:a:0','-c:v',encoder,'-usage','lowlatency','-quality','balanced','-rc','cbr','-enforce_hrd','1','-async_depth','1','-b:v','4000k','-maxrate','4000k','-bufsize','4000k','-g','30','-pix_fmt','yuv420p' if codec=='av1' else 'nv12',*extra,'-c:a','aac',file]
    encoded=run(args);(out/(name+'-encode.log')).write_bytes(encoded.stderr)
    row={'codec':codec,'encoder':encoder,'encodeExit':encoded.returncode,'encodeSeconds':time.monotonic()-started};results['cases'].append(row)
    if encoded.returncode==0:
        decoded=run(['-v','error','-xerror','-i',file,'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'])
        (out/(name+'-decode.log')).write_bytes(decoded.stderr)
        probe=run(['-v','info','-copyts','-i',file,'-an','-vf','showinfo','-fps_mode','passthrough','-f','null','-'])
        probe_text=probe.stderr.decode(errors='replace');(out/(name+'-frames.log')).write_text(probe_text,encoding='utf-8')
        assert probe.returncode==0
        pts=[float(v) for v in re.findall(r'\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:([-\d.e+]+)',probe_text)]
        actual=re.search(r'Stream #0:0[^\n]*Video: (\w+)',probe_text).group(1)
        width,height=map(int,re.search(r'\bs:(\d+)x(\d+)',probe_text).groups())
        gaps=[y-x for x,y in zip(pts,pts[1:])]
        row.update(actualCodec=actual,frames=len(pts),width=width,height=height,maxFrameGapMs=max(gaps)*1000,monotonic=all(g>0 for g in gaps),cleanDecode=decoded.returncode==0 and not decoded.stderr,encodedBytes=file.stat().st_size)
        row['passed']=row['cleanDecode'] and row['actualCodec']==codec and len(pts)>=299 and row['monotonic'] and max(gaps)<.035
    else:row['passed']=False
    (out/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(row),flush=True)
results['passed']=all(c['passed'] for c in results['cases']);(out/'results.json').write_text(json.dumps(results,indent=2));assert results['passed']
