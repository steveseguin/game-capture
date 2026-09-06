'use strict';
// rVFC observes compositor submissions; missed callbacks are recorded rather
// than counted as dropped video. All times here use the browser's clock.
exports.start=async page=>{
  await page.evaluate(()=>{
    const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth>0);
    if(!video)throw Error('No playing video for presentation trace');
    const state={video,rows:[],handle:null};window.reviewPresentationTrace=state;
    const sample=(now,m)=>{
      state.rows.push({now,presentationTime:m.presentationTime,expectedDisplayTime:m.expectedDisplayTime,
        mediaTime:m.mediaTime,presentedFrames:m.presentedFrames,receiveTime:m.receiveTime,
        processingDuration:m.processingDuration,rtpTimestamp:m.rtpTimestamp,width:m.width,height:m.height});
      if(state.rows.length<10000)state.handle=video.requestVideoFrameCallback(sample);
    };
    state.handle=video.requestVideoFrameCallback(sample);
  });
};
exports.stop=async page=>page.evaluate(()=>{
  const s=window.reviewPresentationTrace;
  if(!s)throw Error('Presentation trace was not started');
  s.video.cancelVideoFrameCallback(s.handle);delete window.reviewPresentationTrace;
  let missedCallbacks=0,backwardMediaTimes=0,maxPresentationGapMs=0,maxReceiveGapMs=0;
  const gaps=[];
  for(let i=1;i<s.rows.length;i++){
    const a=s.rows[i-1],b=s.rows[i],gap=b.presentationTime-a.presentationTime;
    const missed=Math.max(0,b.presentedFrames-a.presentedFrames-1);missedCallbacks+=missed;
    if(b.mediaTime<a.mediaTime)backwardMediaTimes++;
    maxPresentationGapMs=Math.max(maxPresentationGapMs,gap);
    if(Number.isFinite(a.receiveTime)&&Number.isFinite(b.receiveTime))maxReceiveGapMs=Math.max(maxReceiveGapMs,b.receiveTime-a.receiveTime);
    if(gap>100)gaps.push({before:a,after:b,gapMs:gap,missedCallbacks:missed});
  }
  return {rows:s.rows,missedCallbacks,backwardMediaTimes,maxPresentationGapMs,maxReceiveGapMs,gaps};
});
