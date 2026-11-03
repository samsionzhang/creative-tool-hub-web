(function(root){
 'use strict';
 function localURL(source){let video='';try{const u=new URL(source);if(u.protocol==='https:'&&['www.bilibili.com','m.bilibili.com','bilibili.com'].includes(u.hostname)&&/^\/video\/(BV\w+|av\d+)/i.test(u.pathname))video=u.href;}catch{}return 'http://127.0.0.1:8771/'+(video?'?'+new URLSearchParams({video}):'');}
 function init(){
  const dialog=document.getElementById('premium-dialog'),status=document.getElementById('premium-copy-status');let source='';
  function open(raw='',quality='高清'){source=raw;document.getElementById('premium-title').textContent='登录 B站，检查 '+quality+' 画质';document.getElementById('premium-local').href=localURL(source);status.textContent='';dialog.showModal();}
  document.getElementById('premium-open').onclick=()=>open(document.getElementById('video-url').value,'1080P / 4K');
  document.getElementById('premium-close').onclick=()=>dialog.close();
  document.getElementById('premium-copy').onclick=async()=>{try{const video=new URL(localURL(source)).searchParams.get('video');if(!video)throw Error('请先填入视频链接');await navigator.clipboard.writeText(video);status.textContent='链接已复制。打开本地高清助手后可直接检查画质。';}catch(e){status.textContent=e.message||'请手动复制视频链接。';}};
  return {open};
 }
 if(typeof module==='object'&&module.exports)module.exports={localURL};else root.BiliPremium=init();
})(globalThis);
