'use strict';
// This path accepts masks only from our source-image segmentation worker, never an image API.
async function originalPersonTask(strong=false){
  const original=source,originalName=name,controller=new AbortController();aiController=controller;
  setBusy(true);$('cancel').hidden=true;$('ai-cancel').hidden=false;
  for(const id of ['ai-person','ai-strong','ai-background'])$(id).disabled=true;
  aiProgress(5,'准备原图分割');$('ai-status').textContent='正在本机分析原图，不上传图片、不调用生成式 API。首次需加载插画模型。';
  const engine=new Worker('./worker.js'),timeout=setTimeout(()=>controller.abort(),600000);
  try{
    const result=await new Promise(async(resolve,reject)=>{
      controller.signal.addEventListener('abort',()=>reject(Error('已取消，原图与已有结果保留')),{once:true});
      engine.onmessage=({data})=>{if(data.status){$('ai-status').textContent=data.status;aiProgress(25,'原图模型计算中 · 阶段进度');return;}data.error?reject(Error(data.error)):resolve(data);};
      engine.onerror=()=>reject(Error('原图分割模型运行失败，未生成结果'));
      try{const bitmap=await createImageBitmap(original);if(controller.signal.aborted){bitmap.close();return;}engine.postMessage({bitmap,model:'anime'},[bitmap]);}catch(e){reject(e);}
    });
    validateSourceMask(result,original.width,original.height);
    result.alpha=cleanSourceAlpha(result.alpha,strong);
    validateSourceMask(result,original.width,original.height);
    if(source!==original||controller.signal.aborted)throw Error('任务已取消或原图已更换');
    aiProgress(80,'检查原图坐标并合成透明图');
    const matte=document.createElement('canvas');matte.width=result.width;matte.height=result.height;
    const mx=matte.getContext('2d'),im=mx.createImageData(matte.width,matte.height);
    for(let i=0;i<result.alpha.length;i++){im.data[i*4]=im.data[i*4+1]=im.data[i*4+2]=255;im.data[i*4+3]=result.alpha[i];}
    mx.putImageData(im,0,0);
    const output=document.createElement('canvas');output.width=original.width;output.height=original.height;
    const ox=output.getContext('2d');ox.drawImage(original,0,0);ox.globalCompositeOperation='destination-in';ox.drawImage(matte,0,0,output.width,output.height);
    const blob=await new Promise((resolve,reject)=>output.toBlob(b=>b?resolve(b):reject(Error('透明 PNG 导出失败')),'image/png'));output.width=output.height=1;
    if(controller.signal.aborted)throw Error('任务已取消');
    const preview=document.createElement('canvas'),scale=Math.min(1,2048/Math.max(original.width,original.height));preview.width=Math.round(original.width*scale);preview.height=Math.round(original.height*scale);preview.getContext('2d').drawImage(original,0,0,preview.width,preview.height);
    const before=await new Promise(resolve=>preview.toBlob(resolve,'image/png'));if(!before||controller.signal.aborted)throw Error('任务已取消或预览生成失败');
    const card=document.createElement('article'),title=document.createElement('h4'),download=document.createElement('button'),edit=document.createElement('button');
    title.textContent=`原图分割 · 未重绘 · ${original.width} × ${original.height} · 请检查边缘`;
    download.textContent='下载原图人物 PNG';download.onclick=()=>save(blob,originalName+'_原图人物.png');
    edit.textContent='在原图上检查 / 修正选区';edit.onclick=()=>{if(busy||source!==original)return;referenceMask?.close();referenceMask=null;fullMask=matte;mc.clearRect(0,0,mask.width,mask.height);mc.drawImage(matte,0,0,mask.width,mask.height);rawMask=mc.getImageData(0,0,mask.width,mask.height);autoMask=rawMask;undo=[];setView('mask');canvas.scrollIntoView({behavior:'smooth',block:'center'});status('选区直接来自原图。绿色为保留区域，可检查发丝、太阳和装饰；修正后从左侧导出。');};
    card.append(title,resultPreview(blob,before,'person'),download,retryCutoutButton(blob,original,originalName),edit);$('ai-results').append(card);aiProgress(100,'原图分割完成 · 待检查边缘');
    $('ai-status').textContent='已使用原图坐标分割并保留原始人物像素。不会套用生成图轮廓；发丝残留、太阳或装饰的误选仍需检查。';
  }catch(e){$('ai-status').textContent=e.message;$('ai-progress-label').textContent=controller.signal.aborted?'已取消':'处理失败 · 未导出';}
  finally{engine.terminate();clearTimeout(timeout);aiController=null;setBusy(false);$('ai-cancel').hidden=true;for(const id of ['ai-person','ai-strong','ai-background'])$(id).disabled=false;}
}
