'use strict';
// Analyzer gates only. Real packaged OBS workflows remain required.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),zlib=require('zlib'),assert=require('assert/strict');
const {analyzeAlphaCompositeSequence}=require(path.join(path.resolve(process.argv[2]),'scripts/obs-websocket-vdoninja-source-check.cjs'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function png(rgba,width,height){
 function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
  for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  const size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([size,body,checksum]);}
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const stride=width*4,rows=Buffer.alloc((stride+1)*height);
 for(let y=0;y<height;y++)rgba.copy(rows,y*(stride+1)+1,y*stride,(y+1)*stride);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gc-alpha-quantization-')),width=64,height=64;
const paths=[path.join(dir,'reference.png'),path.join(dir,'candidate.png')];
const base=Buffer.alloc(width*height*4);for(let i=0;i<base.length;i+=4){base[i]=32;base[i+1]=96;base[i+2]=254;base[i+3]=255;}
function sample(rgba,index){const bytes=png(rgba,width,height);fs.writeFileSync(paths[index],bytes);
 return {sample:index+1,ok:true,classification:'valid',width,height,detectedVisualEpoch:'pre',connectionEpoch:'pre',
  compositePixelSha256:hash(rgba),screenshot:{outputPath:paths[index],sha256:hash(bytes)}};}
try {
 for(const [name,delta,whole,expected] of [['mean-at-bound',4,true,true],['mean-over-bound',5,true,false],['peak-at-bound',18,false,true],['peak-over-bound',19,false,false]]){
  const candidate=Buffer.from(base);for(let i=0;i<(whole?candidate.length:4);i+=4)candidate[i]+=delta;
  const result=analyzeAlphaCompositeSequence([sample(base,0),sample(candidate,1)],{pattern:'alpha-opaque',requiredUsefulSampleCount:2,expectedVisualEpoch:'pre',requireEvidenceFiles:true});
  assert.equal(result.ok,expected,name+': '+result.failureReasons.join(', '));
  assert.deepEqual(result.staticImageTolerance,{maximumMeanChannelError:4,maximumChannelDelta:18});
  console.log('PASS gate '+name);
 }
}finally {for(const file of paths)if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);}
