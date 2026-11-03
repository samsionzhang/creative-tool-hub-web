'use strict';
function retryCutoutButton(blob,owner,fileName,regions=[],round=1){
  const button=document.createElement('button');button.className='primary retry-cutout';button.textContent='再抠一次 · 继续清理当前结果';
  button.onclick=()=>retryCutout(blob,owner,fileName,regions,round);return button;
}
async function retryCutout(blob,owner,fileName,regions=[],round=1){
  if(busy||aiController)return;
  if(source!==owner){$('ai-status').textContent='原图已更换，请在当前图片的结果上继续处理。';return;}
  const controller=new AbortController();aiController=controller;setBusy(true);$('cancel').hidden=true;$('ai-cancel').hidden=false;
  aiProgress(5,'准备上一次抠图结果');$('ai-status').textContent='正在对当前透明图再抠一次；本机处理，不调用 API，不重绘人物。';
  let input,engine;const resources=[],timeout=setTimeout(()=>controller.abort(),600000);
  function newCanvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;resources.push(c);return c;}
  try{
    input=await createImageBitmap(blob);if(controller.signal.aborted)throw Error('已取消');
    const current=newCanvas(input.width,input.height),cx=current.getContext('2d');cx.drawImage(input,0,0);
    const probe=newCanvas(128,128),px=probe.getContext('2d');px.drawImage(current,0,0,128,128);const sample=px.getImageData(0,0,128,128).data;if(!sample.some((v,i)=>i%4===3&&v>0))throw Error('当前人物选区为空，请先完成一次抠图');
    engine=new Worker('./worker.js');
    const maskData=await new Promise(async(resolve,reject)=>{
      controller.signal.addEventListener('abort',()=>reject(Error('已取消')),{once:true});
      engine.onmessage=({data})=>{if(data.status){aiProgress(35,'分析上一次结果 · 阶段进度');$('ai-status').textContent=data.status;return;}data.error?reject(Error(data.error)):resolve(data);};
      engine.onerror=()=>reject(Error('二次抠图模型运行失败'));
      try{const bitmap=await createImageBitmap(input);if(controller.signal.aborted){bitmap.close();return;}engine.postMessage({bitmap,model:'anime'},[bitmap]);}catch(e){reject(e);}
    });
    validateSourceMask(maskData,input.width,input.height);maskData.alpha=cleanSourceAlpha(maskData.alpha,true);validateSourceMask(maskData,input.width,input.height);
    aiProgress(80,'清理残留并保留已有透明区域');
    const small=newCanvas(maskData.width,maskData.height),sx=small.getContext('2d'),im=sx.createImageData(small.width,small.height);
    for(let i=0;i<maskData.alpha.length;i++)im.data.set([255,255,255,maskData.alpha[i]],i*4);sx.putImageData(im,0,0);
    const output=newCanvas(input.width,input.height),ox=output.getContext('2d');ox.drawImage(small,0,0,output.width,output.height);
    let lock,lx;if(regions.some(r=>r.kind!=='erase')){lock=newCanvas(input.width,input.height);lx=lock.getContext('2d');lx.fillStyle='#fff';for(const {points} of regions.filter(r=>r.kind!=='erase')){lx.beginPath();points.forEach(([x,y],i)=>i?lx.lineTo(x*lock.width,y*lock.height):lx.moveTo(x*lock.width,y*lock.height));lx.closePath();lx.fill();}}
    let prior=0,remaining=0;
    for(let y=0;y<input.height;y+=128){const h=Math.min(128,input.height-y),pixels=cx.getImageData(0,y,input.width,h),matte=ox.getImageData(0,y,input.width,h),protection=lx?.getImageData(0,y,input.width,h);
      const totals=refineCutoutAlpha(pixels.data,matte.data,protection?.data);prior+=totals.prior;remaining+=totals.remaining;ox.putImageData(pixels,0,y);
    }
    if(!prior)throw Error('当前人物选区为空，请先完成一次抠图');
    if(remaining/prior<.7)throw Error('本次可能误删过多人物内容，已保留上一版，请使用画笔局部清理');
    if(controller.signal.aborted||source!==owner)throw Error('已取消');
    const result=await new Promise(resolve=>output.toBlob(resolve,'image/png'));if(!result||controller.signal.aborted)throw Error('已取消或导出失败');
    const card=document.createElement('article'),title=document.createElement('h4'),note=document.createElement('p'),download=document.createElement('button');
    title.textContent=`再抠一次 · 第 ${round} 轮清理 · ${input.width} × ${input.height}`;
    note.className='small';note.textContent='上一次结果已保留。本轮只收紧透明范围，不重绘人物；自动识别的关键部位保持不变。可切换黑白底检查，反复清理可能损失细发丝。';
    const preview=resultPreview(result,blob,'person');preview.querySelector('.ai-preview-group button').textContent='上一次';
    download.textContent='下载本轮 PNG';download.onclick=()=>save(result,fileName+'_再抠'+round+'.png');
    card.append(title,note,preview);
    card.append(download,retryCutoutButton(result,owner,fileName,regions,round+1));$('ai-results').append(card);
    aiProgress(100,'二次抠图完成');$('ai-status').textContent=remaining===prior?'本轮没有识别出可进一步去除的部分；请检查选区或使用画笔。':'已生成本轮结果，上一版仍可查看和下载。';card.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){$('ai-status').textContent=(controller.signal.aborted?'已取消':e.message)+'。上一版结果未改动。';$('ai-progress-label').textContent='未生成新版本';}
  finally{engine?.terminate();input?.close();resources.forEach(c=>c.width=c.height=1);clearTimeout(timeout);aiController=null;setBusy(false);$('ai-cancel').hidden=true;}
}
const retryCurrent=document.createElement('button');retryCurrent.id='retry-current';retryCurrent.className='primary';retryCurrent.textContent='再抠一次 · 当前人物';retryCurrent.disabled=!source;$('person').after(retryCurrent);
retryCurrent.onclick=async()=>{if(busy||aiController||!source)return;const owner=source,fileName=name;setBusy(true);try{const blob=await png('person');setBusy(false);await retryCutout(blob,owner,fileName);}catch(e){status(e.message);setBusy(false);}};
