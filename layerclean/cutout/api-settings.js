'use strict';
// Personal configuration stays in this browser; never embedded in the site bundle.
window.cutoutApi = (() => {
  const isLocalHelper=location.origin==='http://127.0.0.1:8897';
  if(!isLocalHelper){
    const download=document.createElement('a');download.id='api-download';download.className='helper-header-download';download.href='api-helper.zip';download.download='本地抠图助手.zip';download.textContent='↓ 下载本地抠图助手';
    document.querySelector('header').insertBefore(download,document.querySelector('header a:last-child'));
    return Object.freeze({isLocalHelper:false,available(){return false;},open(){document.getElementById('helper-download-panel')?.scrollIntoView({behavior:'smooth',block:'center'});document.getElementById('helper-download-button')?.focus({preventScroll:true});},async run(){throw Error('请先下载并启动本地抠图助手，再配置 TimiAI API。');}});
  }
  const storageKey='layerclean-personal-api-v1';
  let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey)||'{}')}catch{}
  let key=typeof saved.key==='string'?saved.key:'', endpoint=saved.endpoint||'https://api.timiai.woa.com/ai_api_manage/llmproxy/images/edits';
  const el = id => document.getElementById(id);
  const dialog = document.createElement('dialog');
  dialog.id = 'api-dialog';
  dialog.setAttribute('aria-labelledby', 'api-title');
  dialog.innerHTML = `<form id="api-form">
    <div class="api-heading"><div><h2 id="api-title">API Key 管理</h2><p>人物精细抠图固定使用 Sunburst；以下模型选择用于背景补全</p></div><button type="button" id="api-close" aria-label="关闭 API 设置">×</button></div>
    <div class="api-platform">个人图像 API <div class="api-test-controls"><span id="api-badge">未配置</span><button type="button" id="api-test">测试连接</button></div></div>
    <details><summary>高级设置（已预设 TimiAI，无需修改）</summary><label for="api-endpoint">图像编辑接口地址（HTTPS）</label><input id="api-endpoint" type="url" placeholder="填入平台提供的完整 images/edits 地址" autocomplete="off"></details>
    <label for="api-key">API Key</label><div class="api-key-row"><input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="输入你的 API Key"><button type="button" id="api-reveal" aria-label="显示密钥">显示</button></div>
    <p class="small">（为保证安全性此处不提供网址跳转，请自行前往timiai复制API）</p>
    <p class="small">默认记住到当前浏览器，下次打开可继续使用。换浏览器或从网站切换到本地助手时，需要分别保存一次。可随时清除。</p>
    <p class="small">支持 multipart 图像编辑接口。内部平台仅在其允许的使用范围和网络中配置；图片直接发送至你填写的平台。</p>
    <p class="small">平台不支持网页跨域调用？<a href="api-helper.zip" download>下载个人 API 助手</a> · <a href="http://127.0.0.1:8897/layerclean/cutout/" target="_blank" rel="noopener noreferrer">打开已启动的本地助手 ↗</a>，解压启动后在本地页面配置（需要 Python 3.10+）。</p>
    <label for="api-image-model">图像模型</label><select id="api-image-model"><option value="gpt-image-2.5-sunburst-r1">GPT Image 2.5 Sunburst · 精细</option><option value="gpt-image-2.5-flare-r1">GPT Image 2.5 Flare · 快速</option><option value="gpt-image-2-r1">GPT Image 2</option><option value="custom">自定义模型</option></select>
    <input id="api-custom-model" placeholder="平台文档中的模型 ID" aria-label="自定义模型 ID" hidden>
    <label for="api-auth">认证格式</label><select id="api-auth"><option value="raw">Authorization: API Key</option><option value="bearer">Authorization: Bearer API Key</option></select>
    <p class="small">测试连接会发送一张内置小样图，验证当前模型能否实际出图，消耗少量额度；不会上传你的素材。</p>
    <p id="api-message" role="status">未配置 API 时，继续使用浏览器内的默认抠图能力。</p>
    <div class="row"><button type="button" id="api-clear">清除密钥</button><button class="primary" id="api-verify" type="submit">保存并记住</button></div>
  </form>`;
  document.body.append(dialog);
  const entry = document.createElement('button');
  entry.id = 'api-settings'; entry.type = 'button'; entry.className='helper-api-entry';entry.textContent = '配置 AI 大模型 · API 设置';
  document.querySelector('header').insertBefore(entry, document.querySelector('header a:last-child'));
  el('api-image-model').value=saved.model||'gpt-image-2.5-sunburst-r1';el('api-auth').value=saved.auth||'raw';el('api-custom-model').value=saved.custom||'';el('api-custom-model').hidden=el('api-image-model').value!=='custom';
  if(key){el('api-badge').textContent='已保存到本机';entry.textContent='API 设置 · 已保存';}
  function message(text) { el('api-message').textContent = text; }
  entry.onclick = () => { el('api-key').value = key; el('api-endpoint').value = endpoint; dialog.showModal(); };
  el('api-image-model').onchange = () => { el('api-custom-model').hidden = el('api-image-model').value !== 'custom'; };
  el('api-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { el('api-key').value = ''; el('api-key').type = 'password'; el('api-reveal').textContent = '显示'; });
  el('api-reveal').onclick = () => { const visible = el('api-key').type === 'password'; el('api-key').type = visible ? 'text' : 'password'; el('api-reveal').textContent = visible ? '隐藏' : '显示'; el('api-reveal').setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥'); };
  el('api-clear').onclick = () => { key = '';try{localStorage.removeItem(storageKey)}catch{} el('api-key').value = ''; el('api-badge').textContent = '未配置'; entry.textContent = '配置 AI 大模型 · API 设置'; message('已清除密钥，继续使用默认本地能力。');window.dispatchEvent(new Event('cutout-api-change')); };
  el('api-form').onsubmit = async event => {
    event.preventDefault();
    const candidate = el('api-key').value.trim();
    if (!candidate) { message('请输入 API Key，或关闭弹窗继续使用本地能力。'); return; }
    try {
      const url = new URL(el('api-endpoint').value.trim());
      if(url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error();
      if(el('api-image-model').value === 'custom' && !el('api-custom-model').value.trim()) { message('请填写模型 ID。'); return; }
      key = candidate; endpoint = url.href;
      try{localStorage.setItem(storageKey,JSON.stringify({key,endpoint,model:el('api-image-model').value,auth:el('api-auth').value,custom:el('api-custom-model').value}))}catch{message('当前浏览器不允许保存，配置仅在本次页面生效。');return;}
       window.dispatchEvent(new Event('cutout-api-change'));el('api-badge').textContent = '已配置 · 未测试'; entry.textContent = 'API 设置 · 已配置'; message('已记住到当前浏览器，后续打开自动恢复。尚未发起调用。关闭弹窗后点击 AI 背景补全进行实际测试，会消耗模型额度。');
    } catch { message('请填写平台的完整 HTTPS 图像编辑接口地址，不要在地址中包含密钥或参数。'); }
  };
  let testController=null;
  dialog.addEventListener('close',()=>testController?.abort());
  el('api-test').onclick=async()=>{
    if(testController)return;
    const connection={key:el('api-key').value.trim(),endpoint:el('api-endpoint').value.trim(),model:el('api-image-model').value==='custom'?el('api-custom-model').value.trim():el('api-image-model').value,auth:el('api-auth').value};
    if(!connection.key||!connection.model){message('请先填写 API Key 并选择模型。');return;}
    try{const url=new URL(connection.endpoint);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error();}catch{message('接口地址无效，请检查高级设置。');return;}
    const controls=[...dialog.querySelectorAll('input,select,button')].filter(node=>node.id!=='api-close');
    controls.forEach(node=>node.disabled=true);testController=new AbortController();
    const timer=setTimeout(()=>testController?.abort(),600000);
    el('api-badge').textContent='测试中…';message('正在用内置小样测试当前 Key 和模型，通常需要数分钟，请勿重复提交。');
    try{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,64,64);ctx.fillStyle='#167b60';ctx.fillRect(20,20,24,24);
      const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const result=await window.cutoutApi.run('background',{connection,image,size:'1024x1024',quality:'low',prompt:'Keep this simple green square on a plain white background. Return one image.'},testController.signal);
      const bitmap=await createImageBitmap(result);bitmap.close();
      el('api-badge').textContent='测试通过';message('测试通过：当前 Key 和所选模型已成功返回图片。点击“保存并记住”保留当前配置。');
    }catch(error){el('api-badge').textContent='测试未通过';message(error.message);}
    finally{clearTimeout(timer);testController=null;controls.forEach(node=>node.disabled=false);}
  };
  return Object.freeze({
    isLocalHelper:true,
    available() { return Boolean(key && endpoint); },
    open() { entry.click(); },
    async run(task, payload, signal) {
      if(!['background','protected-person'].includes(task))throw Error('人物生成仅用于关键部位保护流程，将自动识别原图脸和手。');
      const connection=payload.connection||{key,endpoint,model:el('api-image-model').value==='custom'?el('api-custom-model').value.trim():el('api-image-model').value,auth:el('api-auth').value};
      if (!connection.key || !connection.endpoint) throw Error('请先配置 API；也可继续使用默认本地分离。');
      const form = new FormData();
      const model=task==='protected-person'?'gpt-image-2.5-sunburst-r1':connection.model;
      form.append('model',model); form.append('image',payload.image,'input.jpg'); form.append('n','1'); form.append('quality',payload.quality||'high'); form.append('size',payload.size); form.append('output_format','png'); form.append('background',task === 'protected-person' ? 'transparent' : 'opaque'); form.append('prompt',payload.prompt);
      let response;
      const localHelper=location.origin==='http://127.0.0.1:8897';
      if(!localHelper && new URL(connection.endpoint).hostname==='api.timiai.woa.com')throw Error('TimiAI 不能从公网网页直接调用。请在 API 设置中下载并启动个人 API 助手，然后打开本地页面 http://127.0.0.1:8897/layerclean/cutout/，在那里保存 Key 后使用。');
      const headers={Authorization:(connection.auth==='bearer'?'Bearer ':'')+connection.key};
      if(localHelper)headers['X-Image-Endpoint']=connection.endpoint;
      try { response = await fetch(localHelper?'/api/image-edit':connection.endpoint,{method:'POST',headers,body:form,signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'}); }
      catch(e) { if(signal?.aborted) throw Error('已停止等待。已提交的任务仍可能计费，请勿连续重复提交。'); throw Error('无法连接接口。请检查平台网络和浏览器跨域支持；默认本地模式仍可使用。'); }
      if(!response.ok) throw Error(`接口返回 ${response.status}。请检查密钥、模型权限或额度。未自动重试。`);
      const data = await response.json(); const encoded = data.data?.[0]?.b64_json;
      if(typeof encoded !== 'string' || !encoded.length || encoded.length > 90000000) throw Error('接口未返回有效的图片数据。');
      const bytes = Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      if(!payload.connection){el('api-badge').textContent = '调用成功'; entry.textContent = 'API 设置 · 已连接';}
      return new Blob([bytes],{type:'image/png'});
    }
  });
})();
