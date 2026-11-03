(function(root){
 'use strict';
 async function load(url,{signal,onProgress=()=>{},kind='video'}={}){
  let response;try{response=await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'});}catch(e){if(e.name==='AbortError')throw e;throw Error('文件连接失败，请确认公司网络可用，或重新解析后重试。');}
  const type=response.headers.get('content-type')||'';
  if(!response.ok||/json|text\/|html/i.test(type)){
   let detail='';try{const d=await response.json();detail=d.error||d.detail||'';}catch{}
   throw Error('获取视频失败（'+response.status+'）'+(detail?'：'+String(detail).slice(0,180):'。请重新解析后重试。'));
  }
  if(!response.body)throw Error('文件没有返回内容，请重试。');
  const total=Number(response.headers.get('content-length'))||0;
  const reader=response.body.getReader(),chunks=[];let received=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;received+=value.length;if(received>536870912)throw Error('文件超过网页版单次下载大小，请使用本地完整版。');chunks.push(value);onProgress(received,total);}}catch(e){await reader.cancel().catch(()=>{});throw e;}
  const blob=new Blob(chunks,{type:kind==='audio'?'audio/mp4':'video/mp4'});
  const prefix=new Uint8Array(await blob.slice(0,16).arrayBuffer());
  if(prefix.length<12||String.fromCharCode(...prefix.slice(4,8))!=='ftyp')throw Error('来源没有返回有效的 MP4 文件，请重新解析；不会将错误内容保存成视频。');
  return blob;
 }
 const api={load};if(typeof module==='object'&&module.exports)module.exports=api;else root.VideoMedia=api;
})(globalThis);
