"""Summarize real packaged publisher runs, including encoder/muxer children.

Run after profiling, so media decoding cannot contaminate CPU measurements.
CPU machine percentages divide process CPU by logical CPU count; heterogeneous
cores make this an occupancy measure, not a guarantee of gaming headroom.
"""
import argparse,json,statistics,subprocess,re,csv
from pathlib import Path
import numpy as np

p=argparse.ArgumentParser();p.add_argument('folder',type=Path);p.add_argument('--ffmpeg',required=True)
a=p.parse_args();report=json.loads((a.folder/'results.json').read_text());rows=[]
for case in report['cases']:
    directory=a.folder/case['id'];row={'id':case['id'],'configuration':case.get('configuration'), 'error':case.get('error')}
    rows.append(row)
    resources=directory/'resources.jsonl'
    if resources.exists():
        samples=[json.loads(s) for s in resources.read_text().splitlines()][5:-3]
        if samples:
            cpu=[s['treeCpuPercentOneCore']/s['logicalCpus'] for s in samples]
            row.update(cpuMachineMean=statistics.mean(cpu),cpuMachineP95=float(np.percentile(cpu,95)),
                treeRssMiB=statistics.mean(s['treeRss']/1048576 for s in samples),
                systemCpuMean=statistics.mean(s['systemCpuPercent'] for s in samples))
    d=case.get('lastDiagnostics',{}).get('video',{})
    row.update(encoder=d.get('active_encoder'),hardware=d.get('hardware_encoder'),
               captured=d.get('frames_captured'),sent=d.get('frames_sent'),dropped=d.get('frames_dropped'),
               encodeTimeouts=d.get('encode_timeouts'))
    if case.get('wireMeter'):
        all_rates=[value*8/1e6 for _,value in sorted(case['wireMeter']['uploadSeconds'].items())]
        rates=all_rates[5:-3]
        if rates:row.update(udpIpv4MbpsMean=statistics.mean(rates),udpIpv4MbpsPeak=max(rates))
        if all_rates:row['udpIpv4StartupPeakMbps']=max(all_rates[:5])
    trace=directory/'frame-trace.csv'
    if trace.exists():
        arrivals={};captures={};submits={};readback=[];queued=[];encoded=[]
        entries=list(csv.DictReader(trace.open()));cutoff=int(entries[0]['now100ns'])+50000000
        for entry in entries:
            stage=entry['stage'];now=int(entry['now100ns']);cap=int(entry['capture100ns']);pts=int(entry['output100ns'])
            if stage=='capture-arrival':arrivals[pts]=now
            elif stage=='capture':
                captures[cap]=now
                if cap in arrivals and now>cutoff:readback.append((now-arrivals[cap])/10000)
            elif stage=='submit':
                submits[pts]=now
                if cap in captures and now>cutoff:queued.append((now-captures[cap])/10000)
            elif stage=='packet' and pts in submits and now>cutoff:encoded.append((now-submits[pts])/10000)
        row['timingProfileMs']={name:{'n':len(v),'median':statistics.median(v),'p95':float(np.percentile(v,95))}
            for name,v in [('captureReadback',readback),('encoderQueue',queued),('encoderOutput',encoded)] if v}
    for phase in case['phases']:
        file=Path(phase['recording'])
        cmd=[a.ffmpeg,'-hide_banner','-v','error','-xerror','-i',str(file),'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-']
        decoded=subprocess.run(cmd,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW,timeout=120)
        row['cleanDecode']=decoded.returncode==0 and not decoded.stderr
        if decoded.stderr:row['decodeError']=decoded.stderr.decode(errors='replace')[-1000:]
        codec=d.get('active_codec','H.264').lower().replace('.','')
        requested=case.get('configuration',{}).get('codec','h264').lower().replace('.','').replace('hevc','h265')
        if codec!=requested:row['configurationError']=f'Requested {requested}, actually encoded {codec}'
        elementary_format='hevc' if codec in ('hevc','h265') else 'ivf' if codec in ('av1','vp8','vp9') else 'h264'
        packets=subprocess.run([a.ffmpeg,'-hide_banner','-i',str(file),'-map','0:v:0','-c','copy','-f',elementary_format,'-'],capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW,timeout=60)
        assert packets.returncode==0,packets.stderr.decode(errors='replace')[-1000:]
        duration=re.search(rb'Duration: (\d+):(\d+):([\d.]+)',packets.stderr)
        if duration:
            h,m,s=map(float,duration.groups());seconds=3600*h+60*m+s
            row.update(videoMbps=len(packets.stdout)*8/seconds/1e6,containerMbps=file.stat().st_size*8/seconds/1e6)
        # This observes encoded input to the muxer. It excludes AAC/transport
        # overhead and isn't a claim about subsecond wire pacing.
        samples=phase.get('diagnostics',[])[5:-3];rates=[]
        for before,after in zip(samples,samples[1:]):
            dt=(after['wall']-before['wall'])/1000
            rates.append((after['output']['video_input_bytes']-before['output']['video_input_bytes'])*8/dt/1e6)
        if rates:row['videoOneSecondPeakMbps']=max(rates)
    print(json.dumps(row),flush=True)
output={'publisherSha256':report['sha256'],'cases':rows}
(a.folder/'summary.json').write_text(json.dumps(output,indent=2))
assert rows and all(row.get('cleanDecode') and not row.get('error') and not row.get('configurationError') for row in rows), 'Decode/configuration validation failed; inspect summary.json'
