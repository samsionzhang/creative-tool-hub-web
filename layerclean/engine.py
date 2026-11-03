"""Local, conservative repeated-overlay cleanup. No remote service or source coordinates."""
from __future__ import annotations
import math
from pathlib import Path
from dataclasses import dataclass
import cv2
import numpy as np
from PIL import Image

cv2.setNumThreads(2)
ASSETS = Path(__file__).parent / 'profiles'

@dataclass
class Profile:
    key: str
    masks: np.ndarray
    coef: np.ndarray
    roi: tuple


def load_profiles():
    result = []
    for key, roi in [('logo', (38,154,738,404)), ('text', (470,20,1260,300))]:
        with np.load(ASSETS / (key + '.npz'), allow_pickle=False) as z:
            masks, coef = z['masks'].astype(np.float32), z['coef'].astype(np.float32)
        if masks.ndim != 3 or coef.size != len(masks)*4 or not np.isfinite(masks).all() or not np.isfinite(coef).all():
            raise ValueError('水印模板损坏')
        result.append(Profile(key, masks, coef, roi))
    return result


def highpass(a, sigma):
    return a - cv2.GaussianBlur(a, (0,0), max(.3,sigma))


def signal(rgba):
    a = rgba[:,:,:3].astype(np.float32)
    q = 255 - a[:,:,1] + (a[:,:,0]+a[:,:,2])*.5
    q[rgba[:,:,3] < 200] = 255
    return q


def visible_signal(rgba, sigma):
    valid=(rgba[:,:,3]>230).astype(np.float32)
    q=signal(rgba)
    avg=cv2.GaussianBlur(q*valid,(0,0),sigma)/np.maximum(.001,cv2.GaussianBlur(valid,(0,0),sigma))
    valid=cv2.erode(valid,np.ones((3,3),np.uint8))
    return (q-avg)*valid,valid


def masked_match(image,valid,template):
    ones=np.ones(template.shape,np.float32)
    def corr(a,b):return cv2.matchTemplate(a.astype(np.float32),b.astype(np.float32),cv2.TM_CCORR)
    count=corr(valid,ones);den=np.maximum(count,1)
    si=corr(image,ones);sii=corr(image*image,ones)
    st=corr(valid,template);stt=corr(valid,template*template)
    sit=corr(image,template)
    vi=np.maximum(0,sii-si*si/den);vt=np.maximum(0,stt-st*st/den)
    score=(sit-si*st/den)/np.sqrt(np.maximum(vi*vt,1e-8))
    score[(count<template.size*.22)|(vi<1)|(vt<.005)]=-1
    return np.clip(score,-1,1)


def scaled_masks(profile, scale):
    h,w = profile.masks.shape[1:]
    size = (max(1,round(w*scale)), max(1,round(h*scale)))
    if size == (w,h): return profile.masks
    return np.stack([cv2.resize(m,size,interpolation=cv2.INTER_AREA if scale<1 else cv2.INTER_LINEAR) for m in profile.masks])


def peaks(scores, template_shape, threshold=.58, cap=160):
    h,w = template_shape
    found=[]
    for _ in range(cap):
        _,s,_,(x,y) = cv2.minMaxLoc(scores)
        if s < threshold: break
        found.append((x,y,float(s)))
        rx=max(8,round(w*.72)); ry=max(8,round(h*.72))
        scores[max(0,y-ry):y+ry+1,max(0,x-rx):x+rx+1]=-1
    return found


def detect(rgba, profile):
    H,W=rgba.shape[:2]
    factor=min(1.,2030/W,1400/H)
    size=(max(1,round(W*factor)),max(1,round(H*factor)))
    small=cv2.resize(rgba,size,interpolation=cv2.INTER_AREA)
    hp=highpass(signal(small),4)
    transparent=np.mean(small[:,:,3]<230)>.02
    visible,valid=visible_signal(small,4) if transparent else (None,None)
    scale_candidates=[]
    for value in [W/8120,H/4134,1.,.5,.25,.125,1.5,2.]:
        if .09<=value<=3 and all(abs(math.log(value/v))>.04 for v in scale_candidates): scale_candidates.append(value)
    best=None
    for scale in scale_candidates:
        masks=scaled_masks(profile,scale)
        mh,mw=masks.shape[1:]
        sw,sh=round(mw*factor),round(mh*factor)
        if sw<30 or sh<15:continue
        stencil=cv2.resize(-masks[0],(sw,sh),interpolation=cv2.INTER_AREA)
        stencil=highpass(stencil,4)
        x0,y0,x1,y1=[round(v*scale*factor) for v in profile.roi]
        x1=min(sw,x1);y1=min(sh,y1)
        template=stencil[y0:y1,x0:x1]
        if min(template.shape)<8 or template.shape[0]>=hp.shape[0] or template.shape[1]>=hp.shape[1] or template.std()<.005:continue
        scores=cv2.matchTemplate(hp,template,cv2.TM_CCOEFF_NORMED)
        if transparent:scores=np.maximum(scores,masked_match(visible,valid,template))
        matches=peaks(scores,template.shape)
        if not matches:continue
        merit=sum((s-.45)**2 for _,_,s in matches)
        if best is None or merit>best[0]:best=(merit,scale,masks,x0,y0,matches)
    if best is None:return {'key':profile.key,'scale':1.,'marks':[],'confidence':0.}
    _,scale,masks,x0s,y0s,matches=best
    # Refine against a source-free mask at native resolution.
    rx0,ry0,rx1,ry1=[round(v*scale) for v in profile.roi]
    full_template=highpass(-masks[0],12*scale)[ry0:ry1,rx0:rx1]
    h,w=full_template.shape
    marks=[];radius=max(3,math.ceil(2/factor))
    for sx,sy,score in matches:
        ox=round((sx-x0s)/factor);oy=round((sy-y0s)/factor)
        left=max(0,ox+rx0-radius);top=max(0,oy+ry0-radius)
        right=min(W,ox+rx0+w+radius+1);bottom=min(H,oy+ry0+h+radius+1)
        patch=rgba[top:bottom,left:right]
        if patch.shape[0]<h or patch.shape[1]<w:continue
        mat=cv2.matchTemplate(highpass(signal(patch),12*scale),full_template,cv2.TM_CCOEFF_NORMED)
        if transparent:
            ph,pv=visible_signal(patch,max(1,12*scale))
            mat=np.maximum(mat,masked_match(ph,pv,full_template))
        _,fine,_,(dx,dy)=cv2.minMaxLoc(mat)
        if fine<.55:continue
        x=left+dx-rx0;y=top+dy-ry0
        if any(abs(x-p['x'])<w*.4 and abs(y-p['y'])<h*.4 for p in marks):continue
        marks.append({'x':x,'y':y,'confidence':round(float(fine),4),'paired':False})
    # Repeated-overlay preset: an isolated correlation is not enough to authorize edits.
    if len(marks)<3: marks=[]
    return {'key':profile.key,'scale':scale,'marks':marks,'confidence':round(float(np.median([p['confidence'] for p in marks])),4) if marks else 0.}


def reconcile_layers(analyses):
    """Transfer missing marks only after independently verifying same-canvas registration."""
    import copy
    originals=copy.deepcopy(analyses)
    for target in analyses:
        for key in ['logo','text']:
            t=target['detections'][key]
            own=t['marks']
            if len(own)<3:continue
            peers=[a for a in originals if a['input_id']!=target['input_id'] and a['size']==target['size'] and abs(a['detections'][key]['scale']/t['scale']-1)<.005]
            if not peers:continue
            peer=max(peers,key=lambda a:len(a['detections'][key]['marks']))
            pm=peer['detections'][key]['marks']
            if len(pm)<=len(own):continue
            tol=max(4,8*t['scale'])
            agrees=sum(any(abs(p['x']-q['x'])<=tol and abs(p['y']-q['y'])<=tol for q in pm) for p in own)
            if agrees>=3 and agrees/len(own)>=.75:
                t['marks']=own+[dict(p,paired=True) for p in pm if not any(abs(p['x']-q['x'])<=tol and abs(p['y']-q['y'])<=tol for q in own)]
                t['paired_from']=peer['input_id']
    return analyses


def verify_paired(rgba,det,profile):
    masks=scaled_masks(profile,det['scale']);h,w=masks.shape[1:];H,W=rgba.shape[:2]
    kept=[];rejected=0
    for p in det['marks']:
        if not p.get('paired'):kept.append(p);continue
        x,y=p['x'],p['y'];x0=max(x,0);y0=max(y,0);x1=min(x+w,W);y1=min(y+h,H)
        patch=rgba[y0:y1,x0:x1]
        mask=masks[0,y0-y:y1-y,x0-x:x1-x]
        ph,valid=visible_signal(patch,max(1,12*det['scale']))
        template=highpass(-mask,max(1,12*det['scale']))
        valid=valid>.5
        if np.count_nonzero(valid)<30 or np.std(ph[valid])<.05 or np.std(template[valid])<.0001:rejected+=1;continue
        score=float(np.corrcoef(ph[valid],template[valid])[0,1])
        if np.isfinite(score) and score>=.15:kept.append(dict(p,target_confidence=round(score,4)))
        else:rejected+=1
    det['marks']=kept;det['rejected_paired']=rejected
    return rejected


def inverse(patch,masks,coef):
    n=len(masks);rgb=patch[:,:,:3].astype(np.float32);out=rgb.copy()
    for j,m in enumerate(masks):out+=m[:,:,None]*(coef[j]*rgb-coef[n+j*3:n+j*3+3])
    return out


def build_residual(rgba,det,profile):
    masks=scaled_masks(profile,det['scale']);h,w=masks.shape[1:];H,W=rgba.shape[:2]
    samples=[]
    # Stack + median can consume three copies. Bound scratch memory to about 256 MiB.
    max_samples=min(20,max(0,int(256*1024*1024/(max(1,h*w)*3*4*3))))
    if max_samples<6:return None,0
    for p in sorted(det['marks'],key=lambda p:-p['confidence']):
        x,y=p['x'],p['y']
        if x<0 or y<0 or x+w>W or y+h>H:continue
        patch=rgba[y:y+h,x:x+w]
        if np.mean(patch[:,:,3]>250)<.98:continue
        clean=np.clip(np.round(inverse(patch,masks,profile.coef)),0,255)
        samples.append(highpass(clean,max(1,4*det['scale'])))
        if len(samples)>=max_samples:break
    if len(samples)<6:return None, len(samples)
    med=np.median(np.stack(samples),axis=0)
    k=max(3,round(13*det['scale'])|1)
    support=cv2.dilate((masks[0]>.1).astype(np.uint8),np.ones((k,k),np.uint8)).astype(np.float32)
    support=cv2.GaussianBlur(support,(0,0),max(.4,det['scale']))
    return np.clip(med,-12,12)*support[:,:,None],len(samples)


def apply(rgba,det,profile,strength=1.,residual=None):
    masks=scaled_masks(profile,det['scale']);h,w=masks.shape[1:];H,W=rgba.shape[:2]
    touched=0
    for p in det['marks']:
        x,y=p['x'],p['y'];x0=max(0,x);y0=max(0,y);x1=min(W,x+w);y1=min(H,y+h)
        if x1<=x0 or y1<=y0:continue
        sx=x0-x;sy=y0-y;ex=sx+x1-x0;ey=sy+y1-y0
        source=rgba[y0:y1,x0:x1].copy()
        local=masks[:,sy:ey,sx:ex]
        cleaned=np.clip(np.round(inverse(source,local,profile.coef)),0,255)
        if residual is not None:cleaned-=residual[sy:ey,sx:ex]
        original=source[:,:,:3].astype(np.float32)
        cleaned=original+strength*(cleaned-original)
        rgba[y0:y1,x0:x1,:3]=np.clip(np.round(cleaned),0,255).astype(np.uint8)
        rgba[y0:y1,x0:x1][source[:,:,3]==0]=source[source[:,:,3]==0]
        touched+=1
    return touched
