'use strict';
// Lossless storage for large native receiver observations. Never discard the
// original until the written gzip reproduces its exact SHA-256 digest.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function compressRecordings(report,subdirectory='receiver') {
  const directory=path.join(report,subdirectory),records=[];
  for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.json')).sort()){
    const file=path.join(directory,name),bytes=fs.readFileSync(file),digest=hash(bytes);
    const encoded=zlib.gzipSync(bytes,{level:6}),destination=file+'.gz';
    fs.writeFileSync(destination,encoded,{flag:'wx'});
    assert.equal(hash(zlib.gunzipSync(fs.readFileSync(destination))),digest,'Compressed observation did not round-trip');
    records.push({original:path.join(subdirectory,name),originalBytes:bytes.length,originalSha256:digest,
      compressed:path.join(subdirectory,name+'.gz'),compressedBytes:encoded.length,compressedSha256:hash(encoded)});
    fs.unlinkSync(file);
  }
  const manifest={scope:'Lossless gzip encoding only; observation bytes preserved and verified before removing originals',
    utilitySha256:hash(fs.readFileSync(__filename)),records};
  fs.writeFileSync(path.join(report,'recording-compression.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {files:records.length,originalBytes:records.reduce((n,r)=>n+r.originalBytes,0),compressedBytes:records.reduce((n,r)=>n+r.compressedBytes,0)};
}
module.exports={compressRecordings};
