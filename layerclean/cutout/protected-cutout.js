'use strict';
const protectedPanel=document.createElement('section');protectedPanel.className='protected-panel';
protectedPanel.innerHTML=`<span class="mode-tag">Sunburst · 自动识别关键部位</span><h3>自动识别脸和手，无需圈选</h3><p>点击后自动识别脸与双手，再调用 Sunburst。结果通过对齐检查后，在识别区内保留原图的不透明像素。识别不完整或变化过大时会停止，不要求手动圈选。</p><div class="row"><button id="protect-run" class="primary">Sunburst 自动精细抠图</button><button id="protect-import">处理已有 AI 透明 PNG（不消耗额度）</button><button id="protect-reapply" disabled>重新检查已有结果（不调用 AI）</button><input id="protect-file" type="file" accept="image/png" hidden></div><p class="small">首次使用会下载脸手识别模型到本机缓存。自动识别不上传图片；Sunburst 出图会发送图片至你配置的 API。需要本地助手、Python 3.12+ 与增强组件。</p><p id="protect-status" role="status"></p><div id="protect-results"></div>`;
aiPanel.append(protectedPanel);
let protectCandidate=null;
function resetProtection(){document.querySelectorAll('#protect-results img').forEach(img=>URL.revokeObjectURL(img.src));$('protect-results').replaceChildren();protectCandidate=null;$('protect-reapply').disabled=true;}
function protectionReady(){if(!source){$('protect-status').textContent='请先导入原图。';return false;}if(!cutoutApi.isLocalHelper){cutoutApi.open();return false;}return true;}
function blobBase64(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('无法读取图片'));reader.readAsDataURL(blob);});}
async function runProtected(existing,options={}){
  if(busy||aiController||!protectionReady())return;
  if(!existing&&!cutoutApi.available()){cutoutApi.open();return;}
  const original=source,originalName=name,controller=new AbortController();aiController=controller;setBusy(true);$('cancel').hidden=true;$('ai-cancel').hidden=false;
  for(const id of ['ai-person','ai-strong','ai-background','person-engine','protect-run','protect-import','protect-reapply'])$(id).disabled=true;
  const timeout=setTimeout(()=>controller.abort(),600000);let aligned,polygons=[];
  try{
    const capability=await fetch('/api/cutout-capabilities',{signal:controller.signal});
    const ready=await capability.json();if(!capability.ok||!ready.registration||!ready.auto_regions)throw Error(ready.error||'请更新并重启本地助手，再安装增强组件；尚未调用 AI');
    const scaled=document.createElement('canvas'),scale=Math.min(1,2048/Math.max(original.width,original.height));scaled.width=Math.round(original.width*scale);scaled.height=Math.round(original.height*scale);scaled.getContext('2d').drawImage(original,0,0,scaled.width,scaled.height);
    const input=await new Promise(resolve=>scaled.toBlob(resolve,'image/jpeg',.96));if(!input)throw Error('原图预处理失败');
    aiProgress(8,'自动识别脸与双手');$('ai-status').textContent='正在本机自动识别关键部位，首次会下载模型；尚未调用 Sunburst。';
    const detection=await fetch('/api/detect-regions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:await blobBase64(input)}),signal:controller.signal});
    const anatomy=await detection.json();if(!detection.ok)throw Error(anatomy.error||'自动识别失败，未调用图像 API');
    if(anatomy.width!==scaled.width||anatomy.height!==scaled.height||!Array.isArray(anatomy.regions)||!anatomy.faces||anatomy.hands<2*anatomy.faces)throw Error('自动识别不完整，未调用图像 API');
    polygons=anatomy.regions;
    $('protect-status').textContent=existing?'正在本机对齐已有 AI 结果…':'正在调用 GPT Image 2.5 Sunburst，通常需要数分钟…';aiProgress(10,existing?'本机图像对齐':'GPT Image 2.5 Sunburst · 等待模型');$('ai-status').textContent=$('protect-status').textContent;
    let candidate=existing;
    if(!candidate){const ratio=original.width/original.height;if(ratio<1/3||ratio>3)throw Error('此长宽比不受模型支持');const w=ratio>=1?2048:Math.round(2048*ratio/16)*16,h=ratio>=1?Math.round(2048/ratio/16)*16:2048;
      candidate=await cutoutApi.run('protected-person',{image:input,size:`${w}x${h}`,quality:options.strong?'xhigh':'high',prompt:'Extract ONLY the human character from this image onto genuine transparent alpha. Clean hair boundaries and remove scenery, sun discs, floating pets and detached magic effects. Preserve original canvas coordinates, scale, composition, hands, fingers, facial identity and pose. Do not recenter, crop, beautify or invent anatomy. Only noncritical hair and garment edges may be subtly repaired. Keep opaque skin and clothing solid, never fade them into the background. Additional background-removal requirements (never override face/hand identity preservation): '+$('ai-instructions').value},controller.signal);}
    protectCandidate=candidate;aiProgress(65,'本机对齐并检查匹配质量');
    const response=await fetch('/api/register-cutout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:await blobBase64(input),candidate:await blobBase64(candidate),regions:polygons}),signal:controller.signal});
    const data=await response.json();if(!response.ok)throw Error(data.error||'对齐失败，未生成结果');
    if(data.width!==scaled.width||data.height!==scaled.height||typeof data.image!=='string'||data.inliers<24||data.checked_regions!==polygons.filter(p=>p.kind!=='erase').length)throw Error('对齐或关键部位校验失败');
    aligned=await createImageBitmap(new Blob([Uint8Array.from(atob(data.image),c=>c.charCodeAt(0))],{type:'image/png'}));
    aiProgress(85,'自动还原关键部位原图像素');
    const output=document.createElement('canvas');output.width=original.width;output.height=original.height;const ox=output.getContext('2d');ox.drawImage(aligned,0,0,output.width,output.height);
    // Restore source RGB only within detected opaque anatomy; preserve edge alpha.
    const originalCanvas=document.createElement('canvas');originalCanvas.width=output.width;originalCanvas.height=output.height;const sx=originalCanvas.getContext('2d');sx.drawImage(original,0,0);
    const lock=document.createElement('canvas');lock.width=output.width;lock.height=output.height;const lx=lock.getContext('2d');lx.fillStyle='#fff';
    for(const {points} of polygons.filter(p=>p.kind!=='erase')){lx.beginPath();points.forEach(([x,y],i)=>i?lx.lineTo(x*lock.width,y*lock.height):lx.moveTo(x*lock.width,y*lock.height));lx.closePath();lx.fill();}
    let count=0;for(let y=0;y<output.height;y+=128){const h=Math.min(128,output.height-y),dst=ox.getImageData(0,y,output.width,h),src=sx.getImageData(0,y,output.width,h),mask=lx.getImageData(0,y,output.width,h);for(let i=3;i<mask.data.length;i+=4)if(dst.data[i]<240)mask.data[i]=0;count+=copyProtectedPixels(dst.data,src.data,mask.data);ox.putImageData(dst,0,y);}
    if(count<16)throw Error('保护区过小，未生成结果');
    const before=await new Promise(resolve=>originalCanvas.toBlob(resolve,'image/jpeg',.98));
    const result=await new Promise(resolve=>output.toBlob(resolve,'image/png'));output.width=output.height=originalCanvas.width=originalCanvas.height=lock.width=lock.height=1;
    if(!result||controller.signal.aborted)throw Error('已取消或导出失败');
    const card=document.createElement('article'),title=document.createElement('h4'),notice=document.createElement('p'),download=document.createElement('button');
    title.textContent=`${existing?'已有 AI 图本机处理':'GPT Image 2.5 Sunburst'} · 自动识别手脸 · 原图像素保护 · ${original.width} × ${original.height}`;notice.textContent=`自动识别 ${anatomy.faces} 张脸、${anatomy.hands} 只手；保留 ${count.toLocaleString()} 个原图像素。对齐匹配点 ${data.inliers}。保护区外可能发生 AI 改动，请逐一检查两只手、脸和边界，确认没有多余手指或拼接痕迹。`;notice.className='small';
    download.textContent='下载透明 PNG';download.onclick=()=>save(result,originalName+'_自动保护人物.png');
    card.append(title,notice,resultPreview(result,before||input,'person'),download,retryCutoutButton(result,original,originalName,polygons));$('protect-results').append(card);aiProgress(100,'合成完成 · 请检查关键部位');$('ai-status').textContent=existing?'已有 AI 图本机对齐完成，请检查新结果。':'GPT Image 2.5 Sunburst 已返回；手脸保护检查通过，请检查下方新结果。';$('protect-status').textContent='自动识别区域内的不透明像素已还原原图。请对照检查整体效果；自动识别并不保证所有细节都正确。';
  }catch(e){$('protect-status').textContent=controller.signal.aborted?'已停止，未交付新结果':e.message;$('ai-status').textContent=$('protect-status').textContent;$('ai-progress-label').textContent='未交付结果';}
  finally{aligned?.close();clearTimeout(timeout);aiController=null;setBusy(false);$('ai-cancel').hidden=true;for(const id of ['ai-person','ai-strong','ai-background','person-engine','protect-run','protect-import','protect-reapply'])$(id).disabled=false;$('protect-reapply').disabled=!protectCandidate;}
}
$('protect-run').onclick=()=>runProtected();$('protect-import').onclick=()=>{if(protectionReady())$('protect-file').click();};$('protect-file').onchange=e=>{const file=e.target.files[0];e.target.value='';if(file){if(file.type!=='image/png'||file.size>16*1024*1024){$('protect-status').textContent='请选择小于 16 MB 的 AI 透明 PNG';return;}runProtected(file);}};

$('protect-reapply').onclick=()=>{if(protectCandidate)runProtected(protectCandidate);};