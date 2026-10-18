#!/usr/bin/env python3
"""Decode copied incoming Opus packets directly with libopus, preserving RTP time.

No browser PCM conversion, re-encoding, gap filling or packet concealment is
used. Arrival times locate the resume phase approximately, not absolute playout.
"""
from array import array
import argparse,base64,ctypes as C,ctypes.util,gzip,hashlib,json,math,sys
from pathlib import Path

def decode(report):
    meta=json.loads((report/'received-opus.json').read_text());raw=(report/meta['path']).read_bytes()
    assert not meta['error'] and not meta['writeError'] and hashlib.sha256(raw).hexdigest()==meta['sha256']
    packets=[json.loads(line) for line in raw.splitlines()];assert len(packets)==meta['frames']==meta['workerFrames']
    stream=next(s for s in meta['streams'] if s['id']==meta['selectedId']);assert stream['codec']['mimeType'].lower()=='audio/opus' and stream['codec']['clockRate']==48000
    selected=[p for p in packets if p['id']==meta['selectedId']];assert selected
    lib=C.CDLL(ctypes.util.find_library('opus'));lib.opus_get_version_string.restype=C.c_char_p
    lib.opus_decoder_create.argtypes=[C.c_int,C.c_int,C.POINTER(C.c_int)];lib.opus_decoder_create.restype=C.c_void_p
    lib.opus_decoder_destroy.argtypes=[C.c_void_p]
    lib.opus_decode_float.argtypes=[C.c_void_p,C.c_void_p,C.c_int,C.POINTER(C.c_float),C.c_int,C.c_int]
    lib.opus_packet_get_nb_samples.argtypes=[C.c_void_p,C.c_int,C.c_int]
    err=C.c_int();decoder=lib.opus_decoder_create(48000,2,C.byref(err));assert decoder and err.value==0
    audio=array('f');observations=[];expected=None;discontinuities=[]
    try:
        for p in selected:
            payload=base64.b64decode(p['data'],validate=True);assert 0<len(payload)<=4096
            source=C.create_string_buffer(payload);samples=lib.opus_packet_get_nb_samples(source,len(payload),48000);assert 0<samples<=5760
            stamp=p['rtpTimestamp']
            if expected is not None and stamp!=expected:discontinuities.append({'expected':expected,'actual':stamp,'atFrame':len(audio)//2})
            expected=(stamp+samples)&0xffffffff
            out=(C.c_float*(5760*2))();count=lib.opus_decode_float(decoder,source,len(payload),out,5760,0);assert count==samples
            pcm=out[:count*2];assert all(math.isfinite(v) for v in pcm)
            levels=[math.sqrt(sum(v*v for v in pcm[ch::2])/count) for ch in range(2)]
            observations.append({'rtpTimestamp':stamp,'observedAtMs':p['observedAtMs'],'firstFrame':len(audio)//2,'frames':count,'rms':levels})
            audio.extend(pcm)
    finally:lib.opus_decoder_destroy(decoder)
    return meta,audio,observations,discontinuities,lib.opus_get_version_string().decode()

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('report',type=Path);args=parser.parse_args()
    meta,audio,observations,discontinuities,version=decode(args.report)
    phase=json.loads(gzip.decompress((args.report/'streamRecreated-continuous.json.gz').read_bytes()))
    checked=[r for r in observations if phase['started']+500<=r['observedAtMs']<=phase['ended']];assert checked
    if sys.byteorder!='little':audio.byteswap()
    data=audio.tobytes()
    with (args.report/'received-opus-decoded.f32le').open('xb') as out:out.write(data)
    result={'scope':__doc__,'libopusVersion':version,'encodedSha256':meta['sha256'],
        'selectedId':meta['selectedId'],'decodedSha256':hashlib.sha256(data).hexdigest(),'decodedFrames':len(audio)//2,
        'rtpDiscontinuities':discontinuities,'resumeSettlingMs':500,'resumePackets':len(checked),
        'resumeMinimumRms':min(v for r in checked for v in r['rms']),
        'resumeLowPackets':[r for r in checked if min(r['rms'])<.05],'packets':observations}
    result['resumeLevelChecksPassed']=not result['resumeLowPackets'] and not discontinuities
    with (args.report/'received-opus-analysis.json').open('x') as out:json.dump(result,out,indent=2);out.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k!='packets'}))

if __name__=='__main__':main()
