"""LayerClean local-only HTTP app. Python 3.10+, Pillow, NumPy and OpenCV."""
from __future__ import annotations
import argparse
import concurrent.futures
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import struct
import threading
import time
import traceback
from urllib.parse import urlsplit, parse_qs, unquote
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import uuid
import webbrowser
import zipfile

import numpy as np
from PIL import Image, PngImagePlugin
import engine

BASE=Path(__file__).resolve().parent
DATA=BASE/'runtime'
MAX_UPLOAD=512*1024*1024
MAX_EXPANDED=1024*1024*1024
MAX_IMAGES=12
MAX_PIXELS=80_000_000
Image.MAX_IMAGE_PIXELS=MAX_PIXELS
LOCK=threading.RLock()
INPUTS={}
JOBS={}
POOL=concurrent.futures.ThreadPoolExecutor(max_workers=1,thread_name_prefix='layerclean')
TOKEN=secrets.token_urlsafe(32)
PORT=0
PROFILES=engine.load_profiles()


def now():return datetime.now().astimezone().isoformat(timespec='seconds')

def write_json(path,data):
    temp=path.with_suffix('.writing')
    temp.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    os.replace(temp,path)


def clean_name(name):
    name=Path(str(name).replace('\\','/')).name
    name=re.sub(r'[\x00-\x1f<>:"/\\|?*]','_',name).strip(' .')[:150]
    return name or 'image.png'


def public_input(item):
    return {k:item[k] for k in ['id','name','width','height','mode','bytes','preview_url']}


def inspect_png(path,name):
    with path.open('rb') as f:header=f.read(33)
    if len(header)<33 or header[:8]!=b'\x89PNG\r\n\x1a\n':raise ValueError(f'{name} 不是有效 PNG')
    width,height=struct.unpack('>II',header[16:24]);depth=header[24]
    if not width or not height or width*height>MAX_PIXELS:raise ValueError(f'{name} 超过 8000 万像素限制')
    if depth>8:raise ValueError(f'{name} 是 16 位 PNG；为避免位深损失，本版不处理，请先另存为 8 位 PNG')
    with Image.open(path) as im:
        if getattr(im,'is_animated',False):raise ValueError(f'{name} 是动画 PNG，本版仅支持静态图片')
        im.verify()
    with Image.open(path) as im:
        if im.mode not in ['RGB','RGBA','P','L','LA','1']:raise ValueError(f'{name} 的颜色模式暂不支持')
        mode=im.mode
        already_processed=bool(im.info.get('LayerClean'))
        preview=im.convert('RGBA');preview.thumbnail((1600,1200),Image.Resampling.LANCZOS)
        preview.save(path.parent/'preview.png')
    return width,height,mode,already_processed


def ingest(path,filename):
    suffix=Path(filename).suffix.lower()
    if suffix not in ['.png','.zip']:raise ValueError('仅支持 PNG 或包含 PNG 的 ZIP')
    added=[];warnings=[];created=[]
    def add(stream,name,expected):
        if len(added)>=MAX_IMAGES:raise ValueError('一个压缩包最多 12 张 PNG')
        item_id=uuid.uuid4().hex
        folder=DATA/'inputs'/item_id;folder.mkdir()
        created.append(folder)
        output=folder/'source.png'
        copied=0
        with output.open('wb') as f:
            while chunk:=stream.read(1024*1024):
                copied+=len(chunk)
                if copied>MAX_UPLOAD:raise ValueError('单张图片超过 512 MB')
                f.write(chunk)
        with IMAGE_LOCK:width,height,mode,already_processed=inspect_png(output,name)
        if already_processed:raise ValueError(f'{clean_name(name)} 已有 LayerClean 处理标记，请上传未清理的原图，以免重复处理造成偏色')
        record={'id':item_id,'name':clean_name(name),'width':width,'height':height,'mode':mode,'bytes':copied,'preview_url':f'/api/inputs/{item_id}/preview','created':now()}
        write_json(folder/'input.json',record)
        added.append(record)
    try:
        if suffix=='.png':
            with path.open('rb') as f:add(f,filename,path.stat().st_size)
        else:
            # Bound the central-directory parser before ZipFile allocates per-member objects.
            with path.open('rb') as archive:
                archive.seek(max(0,path.stat().st_size-65557));tail=archive.read()
            end=tail.rfind(b'PK\x05\x06')
            if end<0 or len(tail)-end<22:raise ValueError('无效的 ZIP 目录')
            disk,cd_disk,disk_entries,total_entries,cd_size,cd_offset,comment=struct.unpack_from('<4H2IH',tail,end+4)
            if disk or cd_disk or total_entries==65535 or cd_size==0xffffffff:raise ValueError('不支持分卷或 ZIP64 压缩包')
            if total_entries>2000 or cd_size>4*1024*1024:raise ValueError('ZIP 目录过大；请只打包需要处理的 PNG')
            with zipfile.ZipFile(path) as z:
                members=[m for m in z.infolist() if not m.is_dir() and m.filename.lower().endswith('.png') and not m.filename.startswith('__MACOSX/')]
                if not members:raise ValueError('ZIP 中没有找到 PNG 图片')
                if len(members)>MAX_IMAGES:raise ValueError('一个压缩包最多 12 张 PNG')
                if sum(m.file_size for m in members)>MAX_EXPANDED:raise ValueError('PNG 解压总体积超过 1 GB')
                if len(z.infolist())>2000:raise ValueError('压缩包文件数量过多')
                if any(m.file_size>MAX_UPLOAD for m in members):raise ValueError('单张 PNG 超过 512 MB')
                for m in members:
                    if m.flag_bits&1:raise ValueError('不支持加密压缩包')
                    if (m.external_attr>>16)&0o170000==0o120000:raise ValueError('压缩包中含符号链接，已拒绝')
                    # Do not extract paths supplied by the archive. Keep only a display name.
                    with z.open(m) as f:add(f,m.filename,m.file_size)
                ignored=len([m for m in z.infolist() if not m.is_dir()])-len(members)
                if ignored:warnings.append(f'已跳过 {ignored} 个非 PNG 文件')
        with LOCK:
            for item in added:INPUTS[item['id']]=item
        return {'inputs':[public_input(i) for i in added],'warnings':warnings}
    except Exception:
        # Only newly created internal upload folders from this failed transaction.
        for folder in created:
            for child in folder.iterdir():child.unlink()
            folder.rmdir()
        raise


def update_job(job_id,**values):
    with LOCK:
        JOBS[job_id].update(values)
        write_json(DATA/'jobs'/job_id/'job.json',JOBS[job_id])


def load_rgba(input_id):
    with Image.open(DATA/'inputs'/input_id/'source.png') as im:return np.array(im.convert('RGBA'))


def run_job(job_id,input_ids,strength,adaptive):
    with IMAGE_LOCK:_run_job(job_id,input_ids,strength,adaptive)


def _run_job(job_id,input_ids,strength,adaptive):
    start=time.monotonic()
    try:
        analyses=[]
        update_job(job_id,state='running',progress=2,message='正在读取原图，检查两类水印')
        for index,input_id in enumerate(input_ids):
            info=INPUTS[input_id];rgba=load_rgba(input_id)
            ds={}
            for pi,profile in enumerate(PROFILES):
                update_job(job_id,progress=round(3+36*(index+(pi/2))/len(input_ids)),message=f'识别 {index+1}/{len(input_ids)}：{info["name"]} · '+('标志水印' if profile.key=='logo' else '文字水印'))
                ds[profile.key]=engine.detect(rgba,profile)
            analyses.append({'input_id':input_id,'size':(info['width'],info['height']),'detections':ds})
            del rgba
        engine.reconcile_layers(analyses)
        for analysis in analyses:
            if any(d.get('paired_from') for d in analysis['detections'].values()):
                rgba=load_rgba(analysis['input_id'])
                for profile in PROFILES:engine.verify_paired(rgba,analysis['detections'][profile.key],profile)
                del rgba
        update_job(job_id,progress=42,message='已定位水印，正在检查图层配准与透明边界')
        residual_cache={}
        if adaptive:
            for analysis in analyses:
                for profile in PROFILES:
                    det=analysis['detections'][profile.key]
                    owner=det.get('paired_from',analysis['input_id'])
                    key=(owner,profile.key)
                    if key not in residual_cache:
                        source_analysis=next(a for a in analyses if a['input_id']==owner)
                        source_det=source_analysis['detections'][profile.key]
                        if source_det['marks']:
                            rgba=load_rgba(owner)
                            residual_cache[key]=engine.build_residual(rgba,source_det,profile)
                            del rgba
                        else:residual_cache[key]=(None,0)
        results=[]
        for index,analysis in enumerate(analyses):
            input_id=analysis['input_id'];info=INPUTS[input_id]
            update_job(job_id,progress=round(47+46*index/len(analyses)),message=f'清理并校验 {index+1}/{len(analyses)}：{info["name"]}')
            rgba=load_rgba(input_id);alpha_hash=hashlib.sha256(rgba[:,:,3].tobytes()).hexdigest()
            warnings=[];stats={};paired_count=0
            for profile in PROFILES:
                det=analysis['detections'][profile.key]
                owner=det.get('paired_from',input_id)
                residual,count=residual_cache.get((owner,profile.key),(None,0))
                if adaptive and det['marks'] and residual is None:warnings.append(('标志' if profile.key=='logo' else '文字')+'水印可用完整样本不足 6 个，已关闭该类自适应残影清理')
                stats[profile.key]=engine.apply(rgba,det,profile,strength,residual)
                paired_count+=sum(p.get('paired',False) for p in det['marks'])
            marks=sum(stats.values())
            if strength>=1.6 and marks:warnings.append('已使用超强 1.6×：清理幅度高于强力模式，可能引入色差或细节损失，请检查后导出。')
            if not marks:warnings.append('未可靠识别内置水印，未修改像素；下载的是原画的 RGBA 副本。不同水印需要新的识别模板。')
            else:warnings.append('保真清理不能保证完全无痕；请在 100% 视图检查高亮区域和精细纹理。')
            if paired_count:warnings.append(f'{paired_count} 处遮挡水印由同批次图层辅助定位，并已检查目标区域水印信号')
            rejected=sum(d.get('rejected_paired',0) for d in analysis['detections'].values())
            if rejected:warnings.append(f'{rejected} 处辅助候选因目标区域证据不足而跳过，以免误修')
            if info['mode']!='RGBA':warnings.append(f'原图模式 {info["mode"]} 已转换为 RGBA；不自动抠掉绘制背景')
            destination=DATA/'jobs'/job_id/(input_id+'_clean.png')
            source=Image.open(DATA/'inputs'/input_id/'source.png')
            kw={k:source.info[k] for k in ['icc_profile','dpi'] if k in source.info}
            pnginfo=PngImagePlugin.PngInfo();pnginfo.add_text('LayerClean',json.dumps({'version':'1.0.0','job':job_id,'marks':marks,'strength':strength}))
            Image.fromarray(rgba).save(destination,compress_level=6,pnginfo=pnginfo,**kw)
            preview=Image.fromarray(rgba);preview.thumbnail((1600,1200),Image.Resampling.LANCZOS)
            preview.save(DATA/'jobs'/job_id/(input_id+'_preview.png'))
            source.close();del rgba
            with Image.open(destination) as check:
                valid_size=check.size==(info['width'],info['height'])
                valid_alpha=hashlib.sha256(check.getchannel('A').tobytes()).hexdigest()==alpha_hash
            if not valid_size or not valid_alpha:raise RuntimeError('导出校验失败，已停止交付本任务')
            base=f'/api/jobs/{job_id}/items/{input_id}'
            result={'input_id':input_id,'name':info['name'],'state':'done' if marks else 'skipped','width':info['width'],'height':info['height'],'marks':marks,'alpha_equal':valid_alpha,'dimensions_equal':valid_size,'before_url':info['preview_url'],'before_full_url':f'/api/inputs/{input_id}/original','after_url':base+'/preview','after_full_url':base+'/download','download_url':base+'/download','warnings':warnings,'stats':stats,'bytes':destination.stat().st_size,'paired_marks':paired_count,'detections':analysis['detections']}
            results.append(result)
            update_job(job_id,items=results.copy(),completed=index+1)
        update_job(job_id,progress=96,message='正在打包原尺寸 PNG 与校验清单')
        manifest={'tool':'LayerClean 1.0.0','created':now(),'source_untouched':True,'strength':strength,'adaptive':adaptive,'images':[{k:v for k,v in r.items() if k not in ['detections','before_url','before_full_url','after_url','after_full_url','download_url']} for r in results]}
        write_json(DATA/'jobs'/job_id/'validation.json',manifest)
        with zipfile.ZipFile(DATA/'jobs'/job_id/'results.zip','w',compression=zipfile.ZIP_STORED) as z:
            for i,r in enumerate(results):z.write(DATA/'jobs'/job_id/(r['input_id']+'_clean.png'),f'{i+1:02d}_{Path(r["name"]).stem}_clean.png')
            z.write(DATA/'jobs'/job_id/'validation.json','validation.json')
        update_job(job_id,state='done',progress=100,message='处理完成 · 原尺寸与透明通道校验通过',zip_url=f'/api/jobs/{job_id}/zip',elapsed_seconds=round(time.monotonic()-start,1))
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id,state='error',error=str(exc),message='任务未完成：'+str(exc),elapsed_seconds=round(time.monotonic()-start,1))


class Handler(BaseHTTPRequestHandler):
    server_version='LayerClean/1.0'
    def log_message(self,fmt,*args):
        if args and str(args[0]).startswith('GET /api/jobs/'):return
        try:super().log_message(fmt,*args)
        except UnicodeEncodeError:pass

    def secure(self,mutation=False):
        host=self.headers.get('Host','')
        if host not in [f'127.0.0.1:{PORT}',f'localhost:{PORT}']:return False
        origin=self.headers.get('Origin')
        if origin and origin not in [f'http://127.0.0.1:{PORT}',f'http://localhost:{PORT}']:return False
        if mutation and not secrets.compare_digest(self.headers.get('X-Session-Token',''),TOKEN):return False
        return True

    def send_headers(self,content_type,length,status=200,filename=None):
        self.send_response(status)
        self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(length))
        self.send_header('X-Content-Type-Options','nosniff');self.send_header('Cache-Control','no-store')
        self.send_header('Referrer-Policy','same-origin')
        self.send_header('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
        if filename:
            from urllib.parse import quote
            self.send_header('Content-Disposition',"attachment; filename=\"download"+Path(filename).suffix+"\"; filename*=UTF-8''"+quote(filename))
        self.end_headers()

    def json(self,data,status=200):
        raw=json.dumps(data,ensure_ascii=False).encode('utf-8')
        self.send_headers('application/json; charset=utf-8',len(raw),status)
        self.wfile.write(raw)

    def file(self,path,content_type,filename=None):
        if not path.is_file():return self.json({'error':'文件不存在'},404)
        self.send_headers(content_type,path.stat().st_size,filename=filename)
        with path.open('rb') as f:shutil.copyfileobj(f,self.wfile,1024*1024)

    def do_GET(self):
        try:
            if not self.secure():return self.json({'error':'仅允许本机页面访问'},403)
            path=urlsplit(self.path).path
            static={'/':'index.html','/index.html':'index.html','/app.css':'app.css','/app.js':'app.js'}
            if path in static:
                filename=static[path];ct={'html':'text/html; charset=utf-8','css':'text/css; charset=utf-8','js':'text/javascript; charset=utf-8'}[filename.split('.')[-1]]
                return self.file(BASE/'static'/filename,ct)
            if path=='/api/config':return self.json({'app':'LayerClean','session_token':TOKEN,'version':'1.0.0','port':PORT,'limits':{'max_file_mb':512,'max_images':12,'max_pixels_mp':80},'profiles':[{'id':'logo','name':'绿色临时资源标志'},{'id':'text','name':'绿色禁止对外使用文字'}]})
            if path=='/api/history':
                with LOCK:jobs=sorted(JOBS.values(),key=lambda j:j['created'],reverse=True)
                return self.json({'jobs':[{k:j[k] for k in ['id','created','state','total','completed','label']} for j in jobs[:30]]})
            m=re.fullmatch(r'/api/inputs/([a-f0-9]{32})/(preview|original)',path)
            if m:
                iid,kind=m.groups()
                if iid not in INPUTS:return self.json({'error':'输入文件不存在'},404)
                return self.file(DATA/'inputs'/iid/('preview.png' if kind=='preview' else 'source.png'),'image/png')
            m=re.fullmatch(r'/api/jobs/([a-f0-9]{32})',path)
            if m:
                with LOCK:job=JOBS.get(m[1]);result=json.loads(json.dumps(job)) if job else None
                return self.json(result if result else {'error':'任务不存在'},200 if result else 404)
            m=re.fullmatch(r'/api/jobs/([a-f0-9]{32})/(zip|validation)',path)
            if m:
                jid,kind=m.groups()
                if jid not in JOBS or JOBS[jid]['state']!='done':return self.json({'error':'结果尚未就绪'},404)
                return self.file(DATA/'jobs'/jid/('results.zip' if kind=='zip' else 'validation.json'),'application/zip' if kind=='zip' else 'application/json',f'LayerClean_{jid[:8]}.zip' if kind=='zip' else None)
            m=re.fullmatch(r'/api/jobs/([a-f0-9]{32})/items/([a-f0-9]{32})/(preview|download)',path)
            if m:
                jid,iid,kind=m.groups();job=JOBS.get(jid)
                item=next((i for i in job['items'] if i['input_id']==iid),None) if job else None
                if not item:return self.json({'error':'结果不存在'},404)
                return self.file(DATA/'jobs'/jid/(iid+('_preview.png' if kind=='preview' else '_clean.png')),'image/png',Path(item['name']).stem+'_clean.png' if kind=='download' else None)
            self.json({'error':'未找到此页面'},404)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
        except Exception as exc:
            traceback.print_exc();self.json({'error':str(exc)},500)

    def do_POST(self):
        upload=None
        try:
            if not self.secure(True):return self.json({'error':'请求来源或会话凭据无效，请刷新页面'},403)
            path=urlsplit(self.path).path
            length=int(self.headers.get('Content-Length','0'))
            if length<=0:raise ValueError('请求体为空')
            if path=='/api/upload':
                if length>MAX_UPLOAD:return self.json({'error':'上传文件超过 512 MB'},413)
                if not UPLOAD_LOCK.acquire(blocking=False):return self.json({'error':'已有文件正在导入，请稍后再试'},409)
                try:
                    filename=parse_qs(urlsplit(self.path).query).get('filename',[''])[0]
                    if Path(filename).suffix.lower() not in ['.png','.zip']:raise ValueError('仅支持 PNG 或 ZIP')
                    upload=DATA/'incoming'/(uuid.uuid4().hex+'.upload')
                    remaining=length
                    self.connection.settimeout(90)
                    with upload.open('wb') as f:
                        while remaining:
                            chunk=self.rfile.read(min(1024*1024,remaining))
                            if not chunk:raise ValueError('文件上传中断')
                            f.write(chunk);remaining-=len(chunk)
                    result=ingest(upload,filename)
                finally:UPLOAD_LOCK.release()
                return self.json(result)
            if path=='/api/jobs':
                if length>16384:return self.json({'error':'请求过大'},413)
                params=json.loads(self.rfile.read(length));ids=params.get('inputs')
                if not isinstance(ids,list) or not 1<=len(ids)<=MAX_IMAGES or any(not isinstance(i,str) for i in ids):raise ValueError('请选择 1 至 12 张图片')
                if len(set(ids))!=len(ids) or any(i not in INPUTS for i in ids):raise ValueError('图片列表无效，请重新上传')
                strength=float(params.get('strength',1))
                if strength not in [.8,1.,1.1,1.6]:raise ValueError('强度仅支持 0.8、1.0、1.1 或 1.6')
                adaptive=params.get('adaptive',True)
                if not isinstance(adaptive,bool):raise ValueError('adaptive 必须为布尔值')
                with LOCK:
                    if any(j['state'] in ['queued','running'] for j in JOBS.values()):return self.json({'error':'已有任务在运行，请等待完成后再开始'},409)
                    jid=uuid.uuid4().hex;(DATA/'jobs'/jid).mkdir()
                    job={'id':jid,'state':'queued','created':now(),'progress':0,'message':'准备开始','total':len(ids),'completed':0,'items':[],'label':INPUTS[ids[0]]['name']+(f' 等 {len(ids)} 张' if len(ids)>1 else ''),'input_ids':ids,'strength':strength,'adaptive':adaptive}
                    write_json(DATA/'jobs'/jid/'job.json',job)
                    JOBS[jid]=job
                    try:POOL.submit(run_job,jid,ids,strength,adaptive)
                    except Exception:
                        JOBS[jid].update(state='error',error='任务调度失败，请重试')
                        write_json(DATA/'jobs'/jid/'job.json',JOBS[jid])
                        raise
                return self.json({'id':jid})
            self.json({'error':'接口不存在'},404)
        except (ValueError,zipfile.BadZipFile,KeyError) as exc:self.json({'error':str(exc)},400)
        except OSError as exc:self.json({'error':'本地文件读写失败：'+str(exc)},507 if getattr(exc,'errno',None)==28 else 500)
        except Exception as exc:
            traceback.print_exc();self.json({'error':'导入失败：'+str(exc)},500)
        finally:
            if upload and upload.exists():upload.unlink()


UPLOAD_LOCK=threading.Lock()
IMAGE_LOCK=threading.Lock()

def initialize():
    for name in ['inputs','jobs','incoming']:(DATA/name).mkdir(parents=True,exist_ok=True)
    for p in (DATA/'inputs').glob('*/input.json'):
        try:
            item=json.loads(p.read_text(encoding='utf-8'));INPUTS[item['id']]=item
        except (OSError,ValueError,KeyError):pass
    for p in (DATA/'jobs').glob('*/job.json'):
        try:
            job=json.loads(p.read_text(encoding='utf-8'))
            if job['state'] in ['queued','running']:
                job.update(state='error',error='上次服务关闭导致任务中断，请重新处理',message='上次任务已中断');write_json(p,job)
            JOBS[job['id']]=job
        except (OSError,ValueError,KeyError):pass


def main():
    global DATA,PORT
    parser=argparse.ArgumentParser(description='Local transparent PNG cleanup')
    parser.add_argument('--port',type=int,default=8876)
    parser.add_argument('--open',action='store_true')
    parser.add_argument('--data-dir',type=Path)
    args=parser.parse_args()
    if args.data_dir:DATA=args.data_dir.resolve()
    # Reuse an already-running instance rather than sharing mutable job state.
    import urllib.request
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for existing_port in range(args.port,args.port+10):
        try:
            existing_url=f'http://127.0.0.1:{existing_port}/'
            with opener.open(existing_url+'api/config',timeout=.3) as response:
                config=json.loads(response.read())
            if config.get('app')=='LayerClean':
                print('LayerClean is already running: '+existing_url,flush=True)
                if args.open:webbrowser.open(existing_url)
                return
        except Exception:pass
    initialize()
    httpd=None
    for port in range(args.port,args.port+10):
        try:
            httpd=ThreadingHTTPServer(('127.0.0.1',port),Handler);PORT=port;break
        except OSError:continue
    if httpd is None:raise RuntimeError('No free local port')
    httpd.daemon_threads=True
    url=f'http://127.0.0.1:{PORT}/'
    print(f'LayerClean 1.0.0 | {url}',flush=True)
    print('Local only. Keep this console open. Ctrl+C to stop.',flush=True)
    if args.open:webbrowser.open(url)
    try:httpd.serve_forever(poll_interval=.5)
    except KeyboardInterrupt:print('Stopping LayerClean...')
    finally:httpd.server_close();POOL.shutdown(wait=True,cancel_futures=True)

if __name__=='__main__':main()
