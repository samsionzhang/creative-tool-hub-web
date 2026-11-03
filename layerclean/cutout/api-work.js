'use strict';
const aiPanel=document.createElement('section');
aiPanel.className='api-work';
aiPanel.innerHTML=`<div class="mode-heading ai-mode-heading"><span class="mode-tag">Sunburst 大模型可选 · 本地能力保留</span><h3>Sunburst 精细抠图与 AI 背景补全</h3><p>自动模式下，已配置 API 就使用 GPT Image 2.5 Sunburst；未配置则使用本地分割。使用 Sunburst 时自动识别脸和手，无需圈选；识别不完整或变化过大的结果会被拒绝。</p></div><p class="small">Sunburst 会将图片发送至你配置的平台，消耗模型额度；本地分割不上传。生成结果需检查边缘和人物完整性，不会在调用失败后偷偷切回本地模型。</p><label for="person-engine">人物抠图引擎</label><select id="person-engine"><option value="auto">自动：有 API 用 Sunburst，无 API 用本地</option><option value="sunburst">GPT Image 2.5 Sunburst · API</option><option value="local">本地插画分割 · 不上传 / 不消耗额度</option></select><p id="person-engine-status" class="small" role="status"></p><label for="ai-instructions">补充要求</label><textarea id="ai-instructions" rows="2" placeholder="例如：只保留人物和发丝，去掉头顶太阳及周围特效"></textarea><div class="row"><button id="ai-person" class="ai-action"><strong>原图精细人物抠图</strong><small>Sunburst / 本地 · 按上方引擎处理</small></button><button id="ai-strong" class="ai-action ai-action-strong"><strong>原图发丝边缘精修</strong><small>Sunburst 强力 / 本地边缘清理</small></button><button id="ai-background" class="ai-action"><strong>AI 移除人物 · 补全背景</strong><small>生成被遮挡场景 · 输出背景 PNG</small></button><button id="ai-cancel" hidden>停止等待</button></div><p id="ai-status" role="status" class="small">未配置 API 时，一键分离与画笔功能照常可用。</p><section id="helper-download-panel" class="helper-download-panel" aria-labelledby="helper-download-title"><div class="helper-download-copy"><span class="helper-eyebrow">AI 大模型增强 · 本地助手</span><h3 id="helper-download-title">下载本地抠图助手</h3><p>使用 TimiAI 背景补全或保护关键部位的 AI 精修，需要先下载并启动本地助手，再配置你的 API Key。选择本地分割时在本机完成；选择 Sunburst 时调用图像 API。</p><ol><li>下载 ZIP 并解压</li><li>双击 start.bat 启动助手</li><li>在本地页面右上角配置 API Key</li></ol><p class="small">Windows · 需要 Python 3.10+（已安装 Codex 时可使用其自带运行环境）。配置保存在当前本地浏览器，后续打开可继续使用。默认抠图无需下载。</p></div><div class="helper-download-actions"><a id="helper-download-button" class="helper-download-button" href="api-helper.zip" download="本地抠图助手.zip">↓ 下载本地抠图助手 <small>ZIP 本地包 · 点击直接下载</small></a><a class="helper-open-link" href="http://127.0.0.1:8897/layerclean/cutout/" target="_blank" rel="noopener noreferrer">已安装？打开本地助手 ↗</a></div></section><div id="ai-results"></div>`;
document.querySelector('.work').append(aiPanel);
if(cutoutApi.isLocalHelper){
  document.querySelector('.helper-eyebrow').textContent='本地助手已启动';
  const configure=document.createElement('button');configure.className='helper-configure-button';configure.textContent='⚙ 配置 AI 大模型 · API 设置';configure.onclick=()=>cutoutApi.open();document.querySelector('.helper-download-actions').prepend(configure);
  document.querySelector('.helper-open-link').hidden=true;
}
let aiController=null;
const progressBox=document.createElement('div');progressBox.className='ai-progress';progressBox.hidden=true;progressBox.innerHTML='<div><span id="ai-progress-label"></span><strong id="ai-percent">0%</strong></div><progress id="ai-progress-bar" max="100" value="0" aria-label="AI 处理进度"></progress>';$('ai-status').before(progressBox);
function aiProgress(value,label){progressBox.hidden=false;$('ai-percent').textContent=value+'%';$('ai-progress-bar').value=value;$('ai-progress-label').textContent=label;}
function resultPreview(blob,original,kind){
  const box=document.createElement('div');box.className='ai-preview';
  const controls=document.createElement('div');controls.className='ai-preview-controls';
  const viewport=document.createElement('div');viewport.className='ai-preview-stage';viewport.dataset.view='after';viewport.dataset.background='checker';
  const after=new Image(),before=new Image();after.src=URL.createObjectURL(blob);before.src=URL.createObjectURL(original);after.alt=kind==='person'?'AI 人物提取结果':'AI 补全背景结果';before.alt='处理前原图';after.className='ai-after';before.className='ai-before';
  const divider=document.createElement('span');divider.className='ai-divider';divider.setAttribute('aria-hidden','true');viewport.append(after,before,divider);
  const slider=document.createElement('input');slider.type='range';slider.min=0;slider.max=100;slider.value=50;slider.setAttribute('aria-label','前后对比分界位置');slider.hidden=true;slider.oninput=()=>viewport.style.setProperty('--split',slider.value+'%');
  function group(label,items,attribute){const g=document.createElement('div');g.className='ai-preview-group';g.setAttribute('role','group');g.setAttribute('aria-label',label);for(const [value,text] of items){const b=document.createElement('button');b.textContent=text;b.type='button';b.setAttribute('aria-pressed',String(viewport.dataset[attribute]===value));b.onclick=()=>{viewport.dataset[attribute]=value;g.querySelectorAll('button').forEach(el=>el.setAttribute('aria-pressed',String(el===b)));slider.hidden=viewport.dataset.view!=='compare';};g.append(b);}controls.append(g);}
  group('处理前后',[['before','原图'],['after',kind==='person'?'抠图后':'补全后'],['compare','前后对比']],'view');group('预览底色',[['checker','透明底'],['black','黑色底'],['white','白色底']],'background');
  const note=document.createElement('p');note.className='small';note.textContent='前后对比：左侧原图，右侧结果。拖动下方滑块调整分界；底色仅用于预览，下载文件保持原始透明通道。';box.append(controls,viewport,slider,note);return box;
}
function clearAiResults(){document.querySelectorAll('#ai-results img').forEach(img=>URL.revokeObjectURL(img.src));$('ai-results').replaceChildren();}
async function aiTask(kind,strong=false){
  if(busy||aiController)return;
  if(!source){$('ai-status').textContent='请先导入图片。';return;}
  if(kind==='person'){await dispatchPersonTask(strong);return;}
  if(!cutoutApi.available()){cutoutApi.open();return;}
  const c=document.createElement('canvas'),scale=Math.min(1,2048/Math.max(source.width,source.height));c.width=Math.round(source.width*scale);c.height=Math.round(source.height*scale);c.getContext('2d').drawImage(source,0,0,c.width,c.height);
  const ratio=source.width/source.height;if(ratio>3||ratio<1/3){$('ai-status').textContent='此图长宽比超过模型支持范围（3:1），请先裁剪后再使用 API。';return;}
  const resolution=strong?2048:1536;const w=ratio>=1?resolution:Math.round(resolution*ratio/16)*16,h=ratio>=1?Math.round(resolution/ratio/16)*16:resolution;
  aiController=new AbortController();setBusy(true);$('cancel').hidden=true;$('ai-cancel').hidden=false;$('ai-strong').disabled=$('ai-person').disabled=$('ai-background').disabled=true;
  $('ai-status').textContent='正在调用图像模型，通常需要数分钟。每次点击只提交一次，不会自动重试。';
  const timeout=setTimeout(()=>aiController?.abort(),600000);
  aiProgress(5,'准备图片');let waitingAt=Date.now();const progressTimer=setInterval(()=>aiProgress(Math.min(90,15+Math.floor(75*(1-Math.exp(-(Date.now()-waitingAt)/120000)))),'等待模型 · 预估进度（平台未提供实时百分比）'),1000);
  try{
    const image=await new Promise(resolve=>c.toBlob(resolve,'image/jpeg',.93));
    aiProgress(15,'提交图片 · 预估进度');waitingAt=Date.now();
    const prompt=(kind==='person'?'Segmentation only: preserve the exact original character, including hands, individual fingers, face, hair, clothing and worn accessories. Do not redraw, repair, beautify or invent any existing character details. The alpha channel will be used as a mask over the original source pixels, so match every contour at its exact original canvas coordinates. Extract only the human character with all individual hair strands, clothing and worn accessories. Remove scenery, sun disks, pets, floating creatures and detached effects. Preserve exact pose, face, colors, scale and location. Output genuine alpha transparency, never draw a checkerboard or solid background.':'Remove the human character, pets, floating creatures and foreground magic effects. Reconstruct the occluded background naturally using the surrounding scenery. Preserve the existing scene, perspective, style and lighting. Output the complete opaque background without holes.')+(strong?' Carefully separate every hair strand and open all background gaps between hair, hands and weapons. Remove white fringes and background colour contamination. Preserve thin strands, antialiased alpha edges and opaque character interiors. Do not merge the hair into a solid silhouette.':'')+' Keep the original full canvas composition, do not crop or reposition. Additional requirements: '+$('ai-instructions').value;
    let blob=await cutoutApi.run(kind,{image,size:`${w}x${h}`,prompt,quality:strong?'xhigh':'high'},aiController.signal);
    clearInterval(progressTimer);aiProgress(95,'结果已返回，检查图片');
    const bitmap=await createImageBitmap(blob),check=document.createElement('canvas');check.width=bitmap.width;check.height=bitmap.height;const cc=check.getContext('2d');cc.drawImage(bitmap,0,0);const pixels=cc.getImageData(0,0,check.width,check.height).data;let clear=0,solid=0;for(let i=3;i<pixels.length;i+=4){if(pixels[i]<10)clear++;if(pixels[i]>200)solid++;}bitmap.close();
    if(kind==='person'&&(!clear||!solid))throw Error('模型没有返回有效透明人物图（可能是不透明背景或棋盘格）。本次结果未标为透明 PNG，原来的本地选区保持不变。');
    const outputWidth=check.width,outputHeight=check.height;
    const card=document.createElement('article'),title=document.createElement('h4'),button=document.createElement('button');
    title.textContent=(kind==='person'?'AI 选区 · 原图人物像素 · 透明 PNG':'AI 补全背景')+` · ${outputWidth} × ${outputHeight}`;button.textContent='下载此 PNG';button.onclick=()=>save(blob,name+(kind==='person'?'_AI人物':'_AI补全背景')+'.png');card.append(title,resultPreview(blob,image,kind),button);    $('ai-results').append(card);aiProgress(100,'处理完成');
    $('ai-status').textContent=kind==='person'?'已按原图尺寸导出：人物颜色来自原图，AI 仅决定透明范围，不重画人物。请用前后对比检查手指、发丝及残留背景；误选可用画笔修正。':'背景补全已返回，采用模型实际输出尺寸。生成内容可能改变场景细节，请检查后下载。';
  }catch(e){$('ai-status').textContent=aiController?.signal.aborted?'已停止等待，未获得完成结果。':e.message;$('ai-progress-label').textContent=aiController?.signal.aborted?'已停止等待':'处理失败';}finally{clearInterval(progressTimer);clearTimeout(timeout);aiController=null;setBusy(false);$('ai-cancel').hidden=true;$('ai-strong').disabled=$('ai-person').disabled=$('ai-background').disabled=false;}
}
$('ai-strong').onclick=()=>aiTask('person',true);$('ai-person').onclick=()=>aiTask('person');$('ai-background').onclick=()=>aiTask('background');$('ai-cancel').onclick=()=>aiController?.abort();
window.addEventListener('pagehide',()=>{aiController?.abort();clearAiResults();});

function updatePersonEngine(){const selected=$('person-engine').value;const remote=selected==='sunburst'||selected==='auto'&&cutoutApi.available();$('person-engine-status').textContent=remote?'本次人物抠图：GPT Image 2.5 Sunburst · 自动识别脸和手 · 无需圈选':'本次人物抠图：本地插画模型 · 不调用 Sunburst';}
async function dispatchPersonTask(strong=false){
  updatePersonEngine();const selected=$('person-engine').value;
  if(selected==='local'||selected==='auto'&&!cutoutApi.available()){await originalPersonTask(strong);return;}
  if(!cutoutApi.isLocalHelper||!cutoutApi.available()){cutoutApi.open();$('ai-status').textContent='请在本地助手配置 API 后使用 Sunburst；也可明确选择本地引擎。';return;}
  if(!protectionReady()){protectedPanel.scrollIntoView({behavior:'smooth',block:'start'});$('ai-status').textContent='请先导入原图，并在本地助手中使用 Sunburst。';return;}
  await runProtected(undefined,{strong});
}
$('person-engine').onchange=updatePersonEngine;window.addEventListener('cutout-api-change',updatePersonEngine);updatePersonEngine();
