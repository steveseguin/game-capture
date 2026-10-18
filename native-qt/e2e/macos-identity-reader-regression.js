#!/usr/bin/env node
'use strict';
// Offline regression gate using the actual received cursor-obscured frame.
// Packaged application workflows are required separately.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {decodeAnchoredRows,requireMoving}=require('./macos-media-receiver');
const fixture=path.join(__dirname,'fixtures/macos-cursor-obscured-identity.png');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
  '2ae05f073c7640771902e5a2fc325a97562e38f783c89a0d66c6c0f02c16a09a');
const width=1280,height=720,ffmpeg=process.argv.find(a=>a.startsWith('--ffmpeg='))?.slice(9)||'ffmpeg';
const pixels=execFileSync(ffmpeg,['-v','error','-i',fixture,'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','-'],
  {maxBuffer:width*height*4+1024,timeout:10000});
assert.equal(pixels.length,width*height*4);
const rows=[.4,.5,.6].map(f=>pixels.subarray(Math.floor(height*f)*width*4,(Math.floor(height*f)+1)*width*4));
const recovered=decodeAnchoredRows(rows,width);
assert.deepEqual(recovered.rows.map(row=>row.id),[25378,27426,25378]);
assert.equal(recovered.id,25378);assert.equal(recovered.unreadable,false);assert.equal(recovered.disagreement,true);
function stamp(row,id) {
  const result=Buffer.from(row),anchor=recovered.rows[0],span=(anchor.magenta-anchor.cyan)/.75,left=anchor.cyan-span*.1;
  for(let bit=0;bit<16;bit++) {
    const x=Math.round(left+span*(.2+(bit+.5)*.6/16)),value=(id>>bit)&1?255:0;
    result[x*4]=result[x*4+1]=result[x*4+2]=value;
  }
  return result;
}
assert.equal(decodeAnchoredRows(rows.map(row=>stamp(row,900)),width).id,900);
const ambiguous=decodeAnchoredRows(rows.map((row,i)=>stamp(row,100+i)),width);
assert.equal(ambiguous.id,null);assert.equal(ambiguous.unreadable,true);
for (const level of [0,128,255]) {
  const missing=decodeAnchoredRows(Array.from({length:3},()=>Buffer.alloc(width*4,level)),width);
  assert.equal(missing.id,null);assert.equal(missing.unreadable,true);assert.equal(missing.disagreement,true);
}
const observation={observations:Array.from({length:24},(_,i)=>({id:1000+i,mediaTime:i/60})),tracks:[{codec:'video/h264'}]};
assert.equal(requireMoving(observation,'Ordered fixture'),24);
assert.throws(()=>requireMoving({...observation,identityObserved:false},'Timing only'),/cannot verify moving content/);
assert.throws(()=>requireMoving({...observation,observerError:'Frame snapshot failed'},'Observer error'),/Frame snapshot failed/);
observation.observations[12].id=900;
assert.throws(()=>requireMoving(observation,'Reversed fixture'),/reversed\/corrupt/);
assert.throws(()=>requireMoving({...observation,identityReadFailures:1},'Ambiguous rows'),/no agreeing barcode rows/);
const rollover={...observation,observations:Array.from({length:24},(_,i)=>({id:(65525+i)%65536,mediaTime:i/60}))};
assert.equal(requireMoving(rollover,'Valid rollover'),24);
console.log('Identity reader gate passed: actual cursor occlusion recovered; whole-frame reversal and ambiguous rows rejected; rollover preserved. Application testing is separate.');
