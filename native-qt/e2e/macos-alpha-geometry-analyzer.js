'use strict';
const assert=require('assert/strict');
const {analyze,analyzeBlackScene}=require('./macos-alpha-analyzer');

function analyzeGeometry(frame,[width,height],composition='raw') {
  const sample=frame.geometries?.find(g=>g.sourceWidth===width&&g.sourceHeight===height);
  assert(sample,'Missing receiver geometry samples');assert(sample.identity>0,'Missing fixture identity');
  // Existing observers exclude six output pixels around sharp boundaries.
  // Geometry samples normalize the content width to 640; a portrait content
  // area is narrower than the output canvas, so convert that same pixel margin.
  const contentWidth=Math.min(frame.width,width*frame.height/height);
  assert(contentWidth>0);const boundaryExclusion=6*640/contentWidth;
  let summary;
  if(composition==='raw')summary=analyze({samples:[sample]},{nativeWidth:width,minSamples:1,minIdentities:1,boundaryExclusion});
  else if(composition==='black')summary=analyzeBlackScene([sample],{nativeWidths:[width],minSamples:1,minIdentities:1,boundaryExclusion});
  else {
    assert.equal(composition,'white');
    const linear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
    const nonlinear=x=>x<=.0031308?x*12.92:1.055*x**(1/2.4)-.055;
    const matches=(pixel,color,alpha)=>pixel[3]>=250&&color.every((v,c)=>{
      const a=alpha/255,expected=255*nonlinear(Math.min(1,linear(v*a/255)+1-a));
      return Math.abs(pixel[c]-expected)<=10;
    });
    assert(sample.bands.every((p,i)=>matches(p,[240,60,30],i*85)),'White scene band mismatch');
    const left=(sample.identity*9%(width-80))*640/width,right=left+80*640/width;
    let checked=0;
    for(let i=0;i<sample.edge.length;i++){
      const x=4+i*8;if(Math.abs(x-left)<boundaryExclusion||Math.abs(x-right)<boundaryExclusion||Math.min(x%160,160-x%160)<boundaryExclusion)continue;
      const moving=x>left&&x<right;++checked;
      assert(matches(sample.edge[i],moving?[30,90,240]:[240,60,30],moving?170:Math.floor(x/160)*85),'White scene moving alpha edge mismatch');
    }
    summary={checkedEdgePixels:checked};
  }
  const padding=sample.padding;
  assert(Array.isArray(padding));assert.equal(padding.length,width*360===height*640?0:6);
  for(const pixel of padding){
    if(composition==='raw')assert(pixel[3]<=5,'Aspect-fit padding is not transparent');
    else assert(pixel[3]>=250&&pixel.slice(0,3).every(v=>Math.abs(v-(composition==='white'?255:0))<=10),'Aspect-fit padding did not reveal the OBS background');
  }
  return {identity:sample.identity,sourceWidth:width,sourceHeight:height,contentWidthPixels:contentWidth,boundaryOutputPixels:6,paddingPixels:padding.length,...summary};
}
module.exports={analyzeGeometry};
