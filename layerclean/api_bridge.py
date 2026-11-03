"""Transport adapter; processing reuses the unchanged desktop server."""
import server as s
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
import json,uuid,re
s.DATA=Path('/layerclean-data')
def request(method,path,raw):
    route=urlsplit(path).path
    if method=='GET':
        if route=='/api/config':return {'app':'LayerClean','session_token':s.TOKEN,'version':'1.0.0-web-full','port':0,'limits':{'max_file_mb':512,'max_images':12,'max_pixels_mp':80},'profiles':[{'id':'logo','name':'绿色临时资源标志'},{'id':'text','name':'绿色禁止对外使用文字'}]}
        if route=='/api/history':return {'jobs':[{k:j[k] for k in ['id','created','state','total','completed','label']} for j in sorted(s.JOBS.values(),key=lambda j:j['created'],reverse=True)[:30]]}
        m=re.fullmatch(r'/api/jobs/([a-f0-9]{32})',route)
        if m:return s.JOBS.get(m[1],{'error':'任务不存在'})
        raise ValueError('接口不存在')
    if method!='POST':raise ValueError('不支持的请求方式')
    if route=='/api/upload':
        if len(raw)>s.MAX_UPLOAD:raise ValueError('上传文件超过 512 MB')
        name=parse_qs(urlsplit(path).query).get('filename',[''])[0]
        if Path(name).suffix.lower() not in ['.png','.zip']:raise ValueError('仅支持 PNG 或 ZIP')
        p=s.DATA/'incoming'/(uuid.uuid4().hex+'.upload')
        try:p.write_bytes(raw);return s.ingest(p,name)
        finally:p.unlink(missing_ok=True)
    if route=='/api/jobs':
        params=json.loads(raw);ids=params.get('inputs');strength=float(params.get('strength',1));adaptive=params.get('adaptive',True)
        if not isinstance(ids,list) or not 1<=len(ids)<=s.MAX_IMAGES or any(not isinstance(i,str) for i in ids):raise ValueError('请选择 1 至 12 张图片')
        if len(set(ids))!=len(ids) or any(i not in s.INPUTS for i in ids):raise ValueError('图片列表无效，请重新导入')
        if strength not in [.8,1.,1.1,1.6] or not isinstance(adaptive,bool):raise ValueError('清理参数无效')
        if any(j['state'] in ['queued','running'] for j in s.JOBS.values()):raise ValueError('已有任务正在运行')
        jid=uuid.uuid4().hex;(s.DATA/'jobs'/jid).mkdir()
        job={'id':jid,'state':'queued','created':s.now(),'progress':0,'message':'准备开始','total':len(ids),'completed':0,'items':[],'label':s.INPUTS[ids[0]]['name']+(f' 等 {len(ids)} 张' if len(ids)>1 else ''),'input_ids':ids,'strength':strength,'adaptive':adaptive}
        s.JOBS[jid]=job;s.write_json(s.DATA/'jobs'/jid/'job.json',job);return {'id':jid}
    raise ValueError('接口不存在')
def file_path(path):
    m=re.fullmatch(r'/api/inputs/([a-f0-9]{32})/(preview|original)',path)
    if m and m[1] in s.INPUTS:return str(s.DATA/'inputs'/m[1]/('preview.png' if m[2]=='preview' else 'source.png'))
    m=re.fullmatch(r'/api/jobs/([a-f0-9]{32})/(zip|validation)',path)
    if m and s.JOBS.get(m[1],{}).get('state')=='done':return str(s.DATA/'jobs'/m[1]/('results.zip' if m[2]=='zip' else 'validation.json'))
    m=re.fullmatch(r'/api/jobs/([a-f0-9]{32})/items/([a-f0-9]{32})/(preview|download)',path)
    if m and any(i['input_id']==m[2] for i in s.JOBS.get(m[1],{}).get('items',[])):return str(s.DATA/'jobs'/m[1]/(m[2]+('_preview.png' if m[3]=='preview' else '_clean.png')))
    return ''
def run(jid):
    job=s.JOBS[jid];s.run_job(jid,job['input_ids'],job['strength'],job['adaptive'])
