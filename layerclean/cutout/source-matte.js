'use strict';
// The provider contributes alpha only. Never copy its generated RGB into a cutout.
function applySourceAlpha(original, matte) {
  if(original.length!==matte.length||original.length%4)throw Error('选区与原图像素尺寸不匹配');
  for(let i=3;i<original.length;i+=4)original[i]=Math.round(original[i]*matte[i]/255);
  return original;
}
function validateSourceMask(result,width,height){
  if(result.space!=='source'||result.sourceWidth!==width||result.sourceHeight!==height)throw Error('选区不是当前原图的分割结果，已拒绝导出');
  if(!Number.isInteger(result.width)||!Number.isInteger(result.height)||result.width<1||result.height<1||result.width>4096||result.height>4096||result.alpha?.length!==result.width*result.height)throw Error('选区数据不完整，已拒绝导出');
  if(Math.abs(result.width/result.height-width/height)>2/result.height)throw Error('选区坐标比例不匹配，已拒绝导出');
  let solid=0;for(const a of result.alpha){if(!Number.isFinite(a)||a<0||a>255)throw Error('选区包含无效数据');if(a>127)solid++;}
  if(solid/result.alpha.length<.01||solid/result.alpha.length>.98)throw Error('未得到有效人物选区，已保留原图，请调整识别模式');
}
function cleanSourceAlpha(alpha,strong=false){
  const out=new Uint8ClampedArray(alpha.length),low=strong?.55:.48,high=strong?.67:.62;
  for(let i=0;i<alpha.length;i++){const t=Math.max(0,Math.min(1,(alpha[i]/255-low)/(high-low)));out[i]=Math.round(255*t*t*(3-2*t));}return out;
}
function copyProtectedPixels(destination,original,protection){
  if(destination.length!==original.length||destination.length!==protection.length||destination.length%4)throw Error('保护区像素尺寸不匹配');
  let count=0;for(let i=0;i<destination.length;i+=4)if(protection[i+3]>0){destination[i]=original[i];destination[i+1]=original[i+1];destination[i+2]=original[i+2];destination[i+3]=original[i+3];count++;}return count;
}
function refineCutoutAlpha(pixels,matte,protection){
  if(pixels.length!==matte.length||pixels.length%4||(protection&&protection.length!==pixels.length))throw Error('二次抠图尺寸不匹配');
  let prior=0,remaining=0;
  for(let i=3;i<pixels.length;i+=4){prior+=pixels[i];if(!protection||!protection[i])pixels[i]=Math.round(pixels[i]*matte[i]/255);remaining+=pixels[i];}
  return {prior,remaining};
}
if(typeof module!=='undefined')module.exports={applySourceAlpha,validateSourceMask,cleanSourceAlpha,copyProtectedPixels,refineCutoutAlpha};
