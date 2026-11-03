import type {PointCloudData} from '../../../src/domain/types';
import {validateStroke,type BrushStroke} from '../domain/brush';
type Bounds={min:[number,number,number];max:[number,number,number]};
/** 原件点号的紧凑均匀网格。刷子只查询投影与笔画相交的格，不改变源件顺序。 */
export class BrushIndex {
  private readonly cells=32;
  private readonly offsets:Uint32Array;
  private readonly indices:Uint32Array;
  private readonly occupied:number[]=[];
  private readonly step:number[];
  constructor(readonly cloud:PointCloudData,readonly bounds:Bounds){
    const n=cloud.visible.length,size=this.cells**3,counts=new Uint32Array(size);
    this.step=bounds.max.map((v,a)=>Math.max((v-bounds.min[a]!)/this.cells,1e-6));
    const p=cloud.positions,c=this.cells,min=bounds.min,step=this.step;
    const bucket=(i:number)=>Math.min(c-1,Math.max(0,Math.floor((p[i*3]!-min[0])/step[0]!)))+c*(Math.min(c-1,Math.max(0,Math.floor((p[i*3+1]!-min[1])/step[1]!)))+c*Math.min(c-1,Math.max(0,Math.floor((p[i*3+2]!-min[2])/step[2]!))));
    for(let i=0;i<n;i++)counts[bucket(i)]!++;
    this.offsets=new Uint32Array(size+1);
    for(let i=0;i<size;i++){this.offsets[i+1]=this.offsets[i]!+counts[i]!;if(counts[i])this.occupied.push(i);}
    const cursors=this.offsets.slice(0,size);this.indices=new Uint32Array(n);
    for(let i=0;i<n;i++){const b=bucket(i);this.indices[cursors[b]!] = i;cursors[b]!++;}
  }
  select(stroke:BrushStroke):Uint32Array {
    validateStroke(stroke);const s=stroke,m=s.matrix,v=s.viewMatrix,[width,height]=s.viewport,r=s.radiusPx;
    // 每个深度格为2个CSS像素；判定厚度始终使用相机坐标中的米。
    const scale=2,w=Math.ceil(width/scale),h=Math.ceil(height/scale),paint=new Uint8Array(w*h);
    let x0=width,y0=height,x1=0,y1=0;
    const path:Array<[number,number]>=[];
    for(let i=0;i<s.path.length;i++){const p=s.path[i]!,last=path.at(-1);if(!last||i===s.path.length-1||Math.hypot(p[0]-last[0],p[1]-last[1])>=Math.max(1,r/3))path.push(p);x0=Math.min(x0,p[0]-r);y0=Math.min(y0,p[1]-r);x1=Math.max(x1,p[0]+r);y1=Math.max(y1,p[1]+r);}
    for(let k=0;k<Math.max(1,path.length-1);k++){
      const a=path[k]!,b=path[Math.min(k+1,path.length-1)]!,dx=b[0]-a[0],dy=b[1]-a[1],len=dx*dx+dy*dy;
      const left=Math.max(0,Math.floor((Math.min(a[0],b[0])-r)/scale)),right=Math.min(w-1,Math.floor((Math.max(a[0],b[0])+r)/scale)),top=Math.max(0,Math.floor((Math.min(a[1],b[1])-r)/scale)),bottom=Math.min(h-1,Math.floor((Math.max(a[1],b[1])+r)/scale));
      for(let py=top;py<=bottom;py++)for(let px=left;px<=right;px++){
        const x=(px+.5)*scale,y=(py+.5)*scale,t=len?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/len)):0;
        if((x-a[0]-t*dx)**2+(y-a[1]-t*dy)**2<=r*r)paint[py*w+px]=1;
      }
    }
    const left=x0/width*2-1,right=x1/width*2-1,top=1-y0/height*2,bottom=1-y1/height*2;
    const nearest=s.depth==='surface'?new Float32Array(w*h).fill(Infinity):undefined;
    const p=this.cloud.positions,visible=this.cloud.visible,hits:number[]=[];
    const pixel=(i:number)=>{
      const x=p[i*3]!,y=p[i*3+1]!,z=p[i*3+2]!,q=m[3]!*x+m[7]!*y+m[11]!*z+m[15]!;
      if(q<=0)return -1;
      const u=(m[0]!*x+m[4]!*y+m[8]!*z+m[12]!)/q,t=(m[1]!*x+m[5]!*y+m[9]!*z+m[13]!)/q,d=(m[2]!*x+m[6]!*y+m[10]!*z+m[14]!)/q;
      if(u<left||u>right||t<bottom||t>top||u< -1||u>1||t< -1||t>1||d< -1||d>1)return -1;
      const px=Math.min(w-1,Math.floor((u+1)*width/(2*scale))),py=Math.min(h-1,Math.floor((1-t)*height/(2*scale))),at=py*w+px;
      return paint[at]?at:-1;
    };
    for(const cell of this.occupied){
      const bx=cell%this.cells,by=Math.floor(cell/this.cells)%this.cells,bz=Math.floor(cell/(this.cells*this.cells));
      let minU=Infinity,maxU=-Infinity,minV=Infinity,maxV=-Infinity,minD=Infinity,maxD=-Infinity,crosses=false;
      for(let corner=0;corner<8;corner++){
        const x=this.bounds.min[0]+(bx+(corner&1))*this.step[0]!,y=this.bounds.min[1]+(by+((corner>>1)&1))*this.step[1]!,z=this.bounds.min[2]+(bz+((corner>>2)&1))*this.step[2]!,q=m[3]!*x+m[7]!*y+m[11]!*z+m[15]!;
        if(q<=0){crosses=true;continue;}
        const u=(m[0]!*x+m[4]!*y+m[8]!*z+m[12]!)/q,t=(m[1]!*x+m[5]!*y+m[9]!*z+m[13]!)/q,d=(m[2]!*x+m[6]!*y+m[10]!*z+m[14]!)/q;
        minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,t);maxV=Math.max(maxV,t);minD=Math.min(minD,d);maxD=Math.max(maxD,d);
      }
      if(!crosses&&(maxU<left||minU>right||maxV<bottom||minV>top||maxD< -1||minD>1))continue;
      for(let j=this.offsets[cell]!;j<this.offsets[cell+1]!;j++){
        const i=this.indices[j]!;if(!visible[i])continue;const at=pixel(i);if(at<0)continue;hits.push(i);
        if(nearest){const depth=-(v[2]!*p[i*3]!+v[6]!*p[i*3+1]!+v[10]!*p[i*3+2]!+v[14]!);if(depth<nearest[at]!)nearest[at]=depth;}
      }
    }
    if(!nearest)return Uint32Array.from(hits);
    let count=0;
    for(const i of hits){const at=pixel(i),depth=-(v[2]!*p[i*3]!+v[6]!*p[i*3+1]!+v[10]!*p[i*3+2]!+v[14]!);if(at>=0&&depth<=nearest[at]!+s.thicknessM+1e-6)hits[count++]=i;}
    return Uint32Array.from(hits.slice(0,count));
  }
}
