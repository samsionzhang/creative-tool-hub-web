(function(root){
 'use strict';
 const origin='https://videocatch.isux.woa.com';
 function adapt(payload){
  if(!payload?.success||!payload.data)throw Error('企业解析服务未返回可下载视频，请确认链接可在 Video Catch 中提取。');
  const d=payload.data;
  const formats=(d.formats||[]).flatMap(f=>{
   let u;try{u=new URL(f.url,origin)}catch{return []}
   if(u.origin!==origin||u.username||u.password||!['/api/video-proxy','/api/vimeo-download'].includes(u.pathname))return [];
   const dimensions=String(f.resolution||'').match(/^(\d+)x(\d+)$/);
   let downloadURL=u.href;
   // Video Catch currently rejects this Bilibili edge CDN; use our restricted proxy.
   const target=u.searchParams.get('url');
   if(target){let cdn;try{cdn=new URL(target)}catch{}
    if(cdn?.protocol==='https:'&&!cdn.username&&!cdn.password&&(!cdn.port||cdn.port==='4483')&&(cdn.hostname==='edge.mountaintoys.cn'||cdn.hostname.endsWith('.edge.mountaintoys.cn'))){downloadURL='/api/video/download?'+new URLSearchParams({url:cdn.href,filename:u.searchParams.get('filename')||'video.mp4'});}
   }
   return [{url:u.href,downloadURL,label:String(f.quality||'MP4')+(f.videoOnly?' · 仅视频':''),kind:'video',ext:'mp4',hasAudio:!f.videoOnly,sizeText:String(f.fileSize||''),width:dimensions?+dimensions[1]:0,height:dimensions?+dimensions[2]:0}];
  });
  if(!formats.length)throw Error('企业解析服务没有返回可用的下载地址。');
  const duration=String(d.duration||'').split(':').reduce((seconds,n)=>seconds*60+(Number(n)||0),0);
  let thumbnail;try{const t=new URL(d.thumbnail,origin);if(t.protocol==='https:'&&((t.origin===origin&&t.pathname==='/api/img-proxy')||t.hostname==='hdslb.com'||t.hostname.endsWith('.hdslb.com')))thumbnail=t.href;}catch{}
  return {title:String(d.title||'视频'),platform:String(d.platform||'视频')+' · 企业网络解析',author:String(d.author||''),thumbnail,duration,formats,notice:'“仅视频”画质不含声音。'};
 }
 async function extract(url,signal){
  let response;try{response=await fetch(origin+'/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',referrerPolicy:'no-referrer',body:JSON.stringify({url}),signal});}catch(e){if(e.name==='AbortError')throw e;throw Error('无法连接企业解析服务，请确认当前网络可以打开 Video Catch。也可使用普通在线解析或本地完整版。');}
  if(!response.ok)throw Error('企业解析服务返回 '+response.status+'，请稍后重试。');
  return adapt(await response.json());
 }
 const api={adapt,extract};if(typeof module==='object'&&module.exports)module.exports=api;else root.EnterpriseVideo=api;
})(globalThis);
