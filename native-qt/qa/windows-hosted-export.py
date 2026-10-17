"""Export allowlisted Windows workflow evidence; never upload discovery/settings/signaling logs."""
from pathlib import Path
import hashlib,json,re,shutil
root=Path(__file__).resolve().parents[1]
raw=root/'qa/reports/windows-packaged-media';out=raw/'export';out.mkdir(parents=True,exist_ok=True)
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def clean(value):
    value=re.sub(r'(?i)(?:https?|wss?)://[^\s"<>]+','<url>',str(value))
    value=re.sub(r'(?i)bearer\s+\S+','Bearer <redacted>',value)
    value=re.sub(r'gcwin[0-9a-f]+|\b[0-9a-f]{48}\b','<owned-session>',value)
    return value[:4000]
export={'scope':__doc__,'media':[],'diagnostics':[]}
if (raw/'result.json').exists():
    r=read(raw/'result.json');export['campaign']={k:r.get(k) for k in ['scope','sourceRevision','steps','passed','archiveSha256','executableSha256','manifestSha256','session','videoControllers','endedUtc']}
    export['campaign']['error']=clean(r.get('error',''));export['rawCampaignSha256']=sha(raw/'result.json')
for file in raw.glob('media/*/results.json'):
    r=read(file);e={k:r.get(k) for k in ['scope','passed','executableSha256','manifestSha256','harnessSha256','receiverHarnessSha256',
        'host','requested','browserVersion','activeEncoder','hardwareEncoder','publisherCounters','initialDistinct','exitCode','exitSignal','sourceClosureReported']}
    e['error']=clean(r.get('error',''));e['rawResultsSha256']=sha(file);e['phases']={}
    for name,phase in r.get('phases',{}).items():
        p={k:phase[k] for k in ['started','ended','observations','width','height','identityReadFailures','rowDisagreements','identityObserved'] if k in phase}
        p['tracks']=[{k:t[k] for k in ['codec','framesDecoded','framesReceived','framesDropped','packetsReceived','packetsLost','bytesReceived','frameWidth','frameHeight','framesPerSecond','freezeCount','totalFreezesDuration'] if k in t} for t in phase.get('tracks',[])]
        e['phases'][name]=p
    export['media'].append(e)
    log=file.parent/'private-publisher.log'
    if log.exists():
        lines=[clean(line) for line in log.read_text(errors='replace').splitlines() if re.search(r'\[(VideoEncoder|MFEncoder|FFmpegEncoder|WindowCapture|Capture(?:::[A-Za-z0-9_]+)?|GraphicsCapture)\]',line)]
        (out/(file.parent.name+'-native.log')).write_text('\n'.join(lines[:200])+'\n')
for file in raw.glob('diagnostics/*/results.json'):
    r=read(file);export['diagnostics'].append({'rawResultsSha256':sha(file),'executableSha256':r['sha256'],
        'results':[{k:c[k] for k in ['name','passed','reads','incomplete'] if k in c} for c in r['results']]})
for name in ['result.json','backend-selection.json','dependency-revisions.json','capability-gate.log']:
    file=root/'qa/reports/windows-build-gate'/name
    if file.exists():shutil.copy2(file,out/('build-'+name))
if (raw/'release-artifact-manifest.json').exists():shutil.copy2(raw/'release-artifact-manifest.json',out/'release-artifact-manifest.json')
if (raw/'runtime-dependencies.json').exists():shutil.copy2(raw/'runtime-dependencies.json',out/'runtime-dependencies.json')
for file in [Path(__file__),root/'qa/windows-packaged-media.ps1',root/'e2e/windows-hosted-media.js',root/'e2e/macos-media-receiver.js']:
    shutil.copy2(file,out/file.name)
(out/'results.json').write_text(json.dumps(export,indent=2)+'\n')
print(json.dumps({'export':str(out),'mediaReports':len(export['media']),'diagnosticsReports':len(export['diagnostics'])}))
