#!/usr/bin/env python3
"""Offline encoder/decoder diagnostic gate, not packaged application testing."""
import argparse,hashlib,json,subprocess
from pathlib import Path
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument('--ffmpeg',type=Path,required=True)
parser.add_argument('--report',type=Path,required=True)
parser.add_argument('--cpu-used',default='8')
args=parser.parse_args();args.report.mkdir(parents=True,exist_ok=False)
encoder=args.ffmpeg.resolve();encoded=args.report/'encoded.ivf';count=1000;width=640;height=360
command=[str(encoder),'-hide_banner','-loglevel','error','-nostats','-nostdin','-filter_threads','1',
 '-f','rawvideo','-pix_fmt','bgra','-video_size','640x360','-framerate','30','-i','pipe:0','-an',
 '-c:v','libvpx-vp9','-b:v','4000k','-minrate','4000k','-maxrate','4000k','-bufsize','8000k',
 '-deadline','realtime','-cpu-used',args.cpu_used,'-threads','4','-row-mt','1','-tile-columns','2','-tile-rows','1',
 '-frame-parallel','1','-lag-in-frames','0','-auto-alt-ref','0','-g','1','-keyint_min','1','-max-intra-rate','100',
 '-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','iec61966-2-1','-colorspace','smpte170m','-color_range','tv',
 '-vf','scale=in_range=pc:out_range=tv:out_color_matrix=bt601','-fps_mode','passthrough','-flush_packets','1','-f','ivf',str(encoded)]
with (args.report/'encode.log').open('wb') as log:
 process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=log)
 try:
  for identity in range(1,count+1):
   image=np.empty((height,width,4),dtype=np.uint8)
   for stripe in range(4):image[:,stripe*160:(stripe+1)*160]=[30,60,240,stripe*85]
   for bit in range(16):
    color=255 if identity>>bit&1 else 0;image[:45,bit*40:(bit+1)*40]=[color,color,color,255]
   left=identity*9%(width-80);image[height//2:,left:left+80]=[240,90,30,170]
   process.stdin.write(image.tobytes())
  process.stdin.close();assert process.wait(timeout=60)==0
 finally:
  if process.poll() is None:process.kill();process.wait()
failures=[];decoded=0
with (args.report/'decode.log').open('wb') as log:
 process=subprocess.Popen([str(encoder),'-v','error','-i',str(encoded),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],stdout=subprocess.PIPE,stderr=log)
 try:
  while True:
   raw=process.stdout.read(width*height*3)
   if not raw:break
   assert len(raw)==width*height*3;decoded+=1;image=np.frombuffer(raw,dtype=np.uint8).reshape(height,width,3)
   identity=sum(1<<bit for bit in range(16) if int(image[22,bit*40+20].sum())>384)
   bad=[];left=decoded*9%(width-80);right=left+80
   for x in range(4,width,8):
    if min(abs(x-left),abs(x-right),x%160,160-x%160)<6:continue
    expected=[30,90,240] if left<x<right else [240,60,30]
    pixel=image[270,x].astype(int);delta=np.abs(pixel-np.array(expected))
    if delta.max()>10:bad.append({'x':x,'rgb':pixel.tolist(),'expected':expected,'distance':min(abs(x-left),abs(x-right))})
   if identity!=decoded or bad:failures.append({'expectedId':decoded,'decodedId':identity,'pixels':bad})
  assert process.wait(timeout=10)==0
 finally:
  if process.poll() is None:process.kill();process.wait()
result={'scope':'Synthetic exact BGRA to pinned FFmpeg VP9 and independent decode diagnostic gate; no Syphon, OBS or packaged app',
 'encoderSha256':hashlib.sha256(encoder.read_bytes()).hexdigest(),'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
 'command':command,'frames':decoded,'mismatchedFrames':len(failures),'failures':failures,'passed':decoded==count and not failures}
(args.report/'results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:result[k] for k in ['frames','mismatchedFrames','passed']}))
raise SystemExit(0 if result['passed'] else 1)
