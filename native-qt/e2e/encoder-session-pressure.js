'use strict';
// Bounded real hardware-session pressure. Only harness-owned helpers are stopped.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
exports.start=async function({ffmpeg,launch,name}) {
  const helpers=[],evidence={maximumHelpers:12,exhausted:false,attempts:[]};
  async function close() {
    for(const child of helpers)if(child.exitCode===null&&child.signalCode===null)child.kill();
    const deadline=Date.now()+5000;
    while(helpers.some(c=>c.exitCode===null&&c.signalCode===null)&&Date.now()<deadline)await sleep(50);
    if(helpers.some(c=>c.exitCode===null&&c.signalCode===null))throw Error('Session-pressure helpers did not exit');
  }
  try {
    for(let i=0;i<evidence.maximumHelpers;++i) {
      const child=launch(ffmpeg,['-hide_banner','-loglevel','error','-nostats','-progress','pipe:1',
        '-re','-f','lavfi','-i','color=c=black:s=640x360:r=10','-an','-c:v','h264_nvenc',
        '-preset','p1','-t','180','-f','null','-'],`${name}-pressure-${i+1}`);
      helpers.push(child);
      let output='',error='';child.stdout.on('data',d=>{output+=d.toString();});
      child.stderr.on('data',d=>{error+=d.toString();});
      let spawnError;child.on('error',e=>{spawnError=e;});
      const deadline=Date.now()+7000;
      while(!/frame=\s*[1-9]\d*/.test(output)&&child.exitCode===null&&!spawnError&&Date.now()<deadline)await sleep(50);
      if(spawnError)throw spawnError;
      const ready=/frame=\s*[1-9]\d*/.test(output);
      evidence.attempts.push({pid:child.pid,ready,exitCode:child.exitCode,error});
      if(!ready) {
        evidence.exhausted=child.exitCode!==null&&/OpenEncodeSessionEx|too many.*sessions|out of memory/i.test(error);
        break;
      }
    }
    return {evidence,close};
  } catch(error) {await close();throw error;}
};
