'use strict';
// Lossless storage for large native receiver observations. Never discard the
// original until the written gzip reproduces its exact SHA-256 digest.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function readManifest(report) {
  const file=path.join(report,'recording-compression.json'),utilitySha256=hash(fs.readFileSync(__filename));
  if(!fs.existsSync(file))return {scope:'Lossless gzip encoding only; observation bytes preserved and verified before removing originals',utilitySha256,records:[]};
  const manifest=JSON.parse(fs.readFileSync(file));
  assert.equal(manifest.utilitySha256,utilitySha256,'Compression utility changed during this workflow');
  return manifest;
}
function saveManifest(report,manifest) {
  const file=path.join(report,'recording-compression.json'),temporary=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  fs.renameSync(temporary,file);
}
function compressRecording(report,relative) {
  report=path.resolve(report);const file=path.resolve(report,relative);
  assert(file.startsWith(report+path.sep)&&file.endsWith('.json'),'Expected a JSON recording within this report');
  const bytes=fs.readFileSync(file),digest=hash(bytes),destination=file+'.gz';
  if(!fs.existsSync(destination))fs.writeFileSync(destination,zlib.gzipSync(bytes,{level:6}),{flag:'wx'});
  const encoded=fs.readFileSync(destination);
  assert.equal(hash(zlib.gunzipSync(encoded)),digest,'Compressed observation did not round-trip');
  const record={original:path.relative(report,file),originalBytes:bytes.length,originalSha256:digest,
    compressed:path.relative(report,destination),compressedBytes:encoded.length,compressedSha256:hash(encoded)};
  const manifest=readManifest(report),existing=manifest.records.find(r=>r.original===record.original);
  if(existing)assert.deepEqual(existing,record,'Recording changed after compression');
  else manifest.records.push(record);
  // Publish the verified byte mapping before removing the uncompressed copy.
  // If an earlier attempt stopped here, a retry verifies the same bytes.
  saveManifest(report,manifest);
  fs.unlinkSync(file);
  return record;
}
function compressRecordings(report,subdirectory='receiver') {
  const directory=path.join(report,subdirectory);
  for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.json')).sort()){
    compressRecording(report,path.join(subdirectory,name));
  }
  const manifest=readManifest(report),records=manifest.records;saveManifest(report,manifest);
  return {files:records.length,originalBytes:records.reduce((n,r)=>n+r.originalBytes,0),compressedBytes:records.reduce((n,r)=>n+r.compressedBytes,0)};
}
module.exports={compressRecording,compressRecordings};
