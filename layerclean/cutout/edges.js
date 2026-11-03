/* Refine probabilities, not image colours. Keep the original matte for reversible tuning. */
(function(root){
 function refineMatte(image,guide,mode='crisp',threshold=.6){
  const {width:w,height:h}=image,src=image.data,out=new Uint8ClampedArray(src.length);
  if(mode==='raw')return new ImageData(new Uint8ClampedArray(src),w,h);
  const band=mode==='soft'?.38:.025,low=threshold-band,high=threshold+band;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const i=(y*w+x)*4,p=src[i+3]/255;let a=p;
   // Joint bilateral filtering only in uncertain regions: smooth noise without blurring across RGB edges.
   if(p>.025&&p<.975){let sum=0,weight=0;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
     const xx=x+dx,yy=y+dy;if(xx<0||xx>=w||yy<0||yy>=h)continue;
     const j=(yy*w+xx)*4;let d=0;
     for(let c=0;c<3;c++)d+=(guide[i+c]-guide[j+c])**2;
     const q=Math.exp(-(dx*dx+dy*dy)/4-d/1800);
     sum+=q*src[j+3]/255;weight+=q;
    }a=sum/weight;
   }
   const t=Math.max(0,Math.min(1,(a-low)/(high-low)));
   out[i]=out[i+1]=out[i+2]=255;out[i+3]=Math.round(255*t*t*(3-2*t));
  }
  if(mode==='crisp'){
   // Retain the largest connected subject. Do not turn detached background islands opaque.
   const labels=new Int32Array(w*h),queue=new Int32Array(w*h);let label=0,best=0,bestSize=0;
   for(let start=0;start<w*h;start++){
    if(labels[start]||out[start*4+3]<128)continue;
    label++;let head=0,tail=1;queue[0]=start;labels[start]=label;
    while(head<tail){const i=queue[head++],x=i%w;
     for(const j of [x?i-1:-1,x<w-1?i+1:-1,i-w,i+w])if(j>=0&&j<w*h&&!labels[j]&&out[j*4+3]>=128){labels[j]=label;queue[tail++]=j;}
    }if(tail>bestSize){bestSize=tail;best=label;}
   }
   if(!bestSize){for(let i=3;i<out.length;i+=4)out[i]=0;return new ImageData(out,w,h);}
   for(let i=0;i<w*h;i++)if(labels[i]&&labels[i]!==best)out[i*4+3]=0;
   // Low-alpha pixels survive only beside the retained subject, never as floating haze.
   for(let i=0;i<w*h;i++)if(!labels[i]&&out[i*4+3]){
    let near=false;const x=i%w,y=Math.floor(i/w);
    for(let dy=-2;dy<=2&&!near;dy++)for(let dx=-2;dx<=2;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<w&&yy>=0&&yy<h&&labels[yy*w+xx]===best){near=true;break}}
    if(!near)out[i*4+3]=0;
   }
  }
  return new ImageData(out,w,h);
 }
 root.refineMatte=refineMatte;
 // A one-pixel matte contraction removes fringe without changing source colours.
 // Always work from a copy, so the full original selection remains undoable.
 root.refineStrongEdges=function(image){
  const {width:w,height:h,data:src}=image,out=new Uint8ClampedArray(src);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const i=(y*w+x)*4;let minimum=src[i+3];
   for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
    const xx=x+dx,yy=y+dy;if(xx>=0&&xx<w&&yy>=0&&yy<h)minimum=Math.min(minimum,src[(yy*w+xx)*4+3]);
   }
   out[i+3]=Math.round(minimum*.8+src[i+3]*.2);
   if(out[i+3]<55)out[i+3]=0;
  }
  return new ImageData(out,w,h);
 };
})(globalThis);
