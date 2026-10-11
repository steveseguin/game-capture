import argparse, json, subprocess
from pathlib import Path
import numpy as np
parser=argparse.ArgumentParser(description='Isolate libvpx startup quantization; a diagnostic control, not application testing.')
parser.add_argument('--ffmpeg',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
ff=str(args.ffmpeg.resolve())
out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
w,h,n=1280,720,12
results=[]
for kind in ['color','alpha']:
 r,g,b=32,96,255
 y=((66*r+129*g+25*b+128)>>8)+16
 u=((-38*r-74*g+112*b+128)>>8)+128
 v=((112*r-94*g-18*b+128)>>8)+128
 frame=(bytes([y])*(w*h)+bytes([u,v])*(w*h//4)) if kind=='color' else bytes([255])*(w*h)
 rate=12000 if kind=='color' else 3000
 args=[ff,'-y','-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','nv12' if kind=='color' else 'gray',
 '-video_size',f'{w}x{h}','-framerate','60','-i','pipe:0','-an','-c:v','libvpx-vp9','-b:v',f'{rate}k','-maxrate',f'{rate}k','-bufsize',f'{rate*2}k',
 '-deadline','realtime','-cpu-used','8','-threads','4','-lag-in-frames','0','-row-mt','1','-tile-columns','2','-tile-rows','1','-frame-parallel','1',
 '-g','1','-keyint_min','1','-minrate',f'{rate}k','-max-intra-rate','100','-pix_fmt','yuv420p','-color_range','tv' if kind=='color' else 'pc']
 if kind=='color':args+=['-colorspace','smpte170m','-color_primaries','bt709','-color_trc','iec61966-2-1']
 args+=['-f','ivf',str(out/(kind+'.ivf'))]
 subprocess.run(args,input=frame*n,check=True)
 raw=subprocess.check_output([ff,'-hide_banner','-loglevel','error','-i',str(out/(kind+'.ivf')),'-f','rawvideo','-pix_fmt','rgb24' if kind=='color' else 'gray','pipe:1'])
 channels=3 if kind=='color' else 1
 a=np.frombuffer(raw,np.uint8).reshape(n,h,w,channels)
 report=dict(kind=kind,command=args,frames=[dict(index=i,mean=a[i].mean((0,1)).tolist(),minimum=a[i].min((0,1)).tolist(),maximum=a[i].max((0,1)).tolist()) for i in [0,1,2,3,11]],
  firstToLastMaximumMeanChannelDifference=np.abs(a[0].astype(float)-a[-1]).mean((0,1)).max().item(),firstToLastMaximumChannelDifference=np.abs(a[0].astype(int)-a[-1]).max().item())
 results.append(report)
 print(json.dumps({k:v for k,v in report.items() if k!='command'},indent=2))
(out/'results.json').write_text(json.dumps(results,indent=2))
