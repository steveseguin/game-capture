'use strict';
const assert=require('assert/strict');
function analyze(data,{nativeWidth=640,minSamples=60,minIdentities=30,boundaryExclusion=6}={}){
  const samples=data.samples;assert(samples.length>=minSamples,'Too few received frames');
  const useful=samples.filter(s=>s.identity>0);assert(useful.length>=minSamples);
  const identities=new Set(),failures=[];let checked=0;
  for(const sample of useful){
    identities.add(sample.identity);let bad=false;
    for(let stripe=0;stripe<4;stripe++){
      const [r,g,b,a]=sample.bands[stripe];
      if(Math.abs(a-stripe*85)>5||(stripe&&[Math.abs(r-240),Math.abs(g-60),Math.abs(b-30)].some(x=>x>8)))bad=true;
    }
    const left=(sample.identity*9%(nativeWidth-80))*640/nativeWidth,right=left+80*640/nativeWidth;
    for(let i=0;i<sample.edge.length;i++){
      const x=4+i*8;
      // Exclude compression/filter boundaries, not entire mismatched frames.
      if(Math.abs(x-left)<boundaryExclusion||Math.abs(x-right)<boundaryExclusion||Math.min(x%160,160-x%160)<boundaryExclusion)continue;
      const moving=x>left&&x<right,stripe=Math.floor(x/160),expected=moving?[30,90,240,170]:[240,60,30,stripe*85];
      const pixel=sample.edge[i];++checked;
      if(Math.abs(pixel[3]-expected[3])>5||(expected[3]&&pixel.slice(0,3).some((v,c)=>Math.abs(v-expected[c])>10)))bad=true;
    }
    if(bad)failures.push(sample.identity);
  }
  assert(identities.size>=minIdentities,'Received output is not moving');
  const summary={samples:useful.length,distinctIdentities:identities.size,checkedEdgePixels:checked,failedFrames:failures.length,failedIdentities:failures.slice(0,20)};
  assert.equal(failures.length,0,'Paired color/alpha pixels differ: '+JSON.stringify(summary));return summary;
}
function analyzeComposition(data){
  // OBS 32.2.2 default.effect PSDrawNonlinearAlpha: premultiply in
  // nonlinear sRGB, then blend in linear space. The source sets flags=0.
  const linear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
  const nonlinear=x=>x<=.0031308?x*12.92:1.055*x**(1/2.4)-.055;
  const summary={};
  for(const name of ['blackComposition','whiteComposition']){
    const frames=data[name];assert(Array.isArray(frames)&&frames.length>=60,'Missing OBS '+name);
    const ids=new Set();let failures=0;
    for(const frame of frames){
      ids.add(frame.identity);let bad=false;
      for(let stripe=0;stripe<4;stripe++){
        const pixel=frame.bands[stripe],a=stripe/3;
        if(pixel[3]<250)bad=true;
        for(let channel=0;channel<3;channel++){
          const foreground=[240,60,30][channel];
          if(name==='blackComposition'){
            // OBS's nonlinear-alpha path over black should apply alpha once.
            if(Math.abs(pixel[channel]-foreground*a)>12)bad=true;
          }else{
            const expected=255*nonlinear(Math.min(1,linear(foreground*a/255)+(1-a)));
            if(Math.abs(pixel[channel]-expected)>10)bad=true;
          }
        }
      }
      if(bad)++failures;
    }
    assert(ids.size>=30,'OBS composition stopped moving');
    summary[name]={samples:frames.length,distinctIdentities:ids.size,failedFrames:failures};
    assert.equal(failures,0,'OBS composition pixels differ: '+JSON.stringify(summary[name]));
  }
  return summary;
}
module.exports={analyze,analyzeComposition};

// Actual opaque OBS scene over black. Keep the original composition tolerance
// and compression-boundary exclusion while checking the moving alpha edge.
function analyzeBlackScene(samples,{nativeWidths=[640],minSamples=60,minIdentities=30,boundaryExclusion=6}={}){
  assert(samples.length>=minSamples,'Too few OBS scene frames');
  const ids=new Set(),failures=[];
  for(const sample of samples){
    ids.add(sample.identity);
    const matches=(pixel,foreground,alpha)=>pixel[3]>=250&&foreground.every((v,c)=>Math.abs(pixel[c]-v*alpha/255)<=12);
    let valid=sample.identity>0&&sample.bands.every((p,i)=>matches(p,[240,60,30],i*85));
    if(valid)valid=nativeWidths.some(width=>{
      const left=(sample.identity*9%(width-80))*640/width,right=left+80*640/width;
      return sample.edge.every((p,i)=>{
        const x=4+i*8;if(Math.abs(x-left)<boundaryExclusion||Math.abs(x-right)<boundaryExclusion||Math.min(x%160,160-x%160)<boundaryExclusion)return true;
        const moving=x>left&&x<right;
        return matches(p,moving?[30,90,240]:[240,60,30],moving?170:Math.floor(x/160)*85);
      });
    });
    if(!valid)failures.push(sample.identity);
  }
  assert(ids.size>=minIdentities,'OBS scene is frozen');
  const summary={samples:samples.length,distinctIdentities:ids.size,failedFrames:failures.length,failedIdentities:failures.slice(0,20)};
  assert.equal(failures.length,0,'OBS scene color/alpha/identity mismatch: '+JSON.stringify(summary));return summary;
}
module.exports.analyzeBlackScene=analyzeBlackScene;
