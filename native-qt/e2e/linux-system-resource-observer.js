'use strict';
// Compare the packaged app's actual diagnostics with the host's free(1) output.
const assert=require('assert/strict'),{execFileSync}=require('child_process');
module.exports=function(system){
  assert(Number.isFinite(system.cpu_percent)&&system.cpu_percent>=0&&system.cpu_percent<=100,'CPU usage unavailable/out of range');
  assert(Number.isFinite(system.memory_percent)&&system.memory_percent>=0&&system.memory_percent<=100,'Memory usage unavailable/out of range');
  const output=execFileSync('free',['--bytes'],{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:5000});
  const row=output.split('\n').find(line=>line.startsWith('Mem:')).trim().split(/\s+/).slice(1).map(Number);
  const total=row[0],available=row[5];assert(total>0&&Number.isFinite(available));
  assert.equal(system.memory_total_bytes,total,'Memory total differs from free(1)');
  assert(system.memory_used_bytes>0&&system.memory_used_bytes<=total);
  // Sampling is independent and the application caches for 250 ms. Allow normal
  // browser/encoder allocation churn, while rejecting wrong units or cache accounting.
  const tolerance=Math.max(128*1024*1024,total*.01);
  assert(Math.abs(system.memory_used_bytes-(total-available))<=tolerance,'Memory usage disagrees with available-memory accounting');
  assert(Math.abs(system.memory_percent-100*system.memory_used_bytes/total)<.001);
  return {passed:true,application:system,reference:{totalBytes:total,availableBytes:available},toleranceBytes:tolerance};
};
