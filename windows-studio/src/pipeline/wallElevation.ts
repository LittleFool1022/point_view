import type {PointCloudData} from '../../../src/domain/types';
import {wallLength,type Wall} from '../domain/building';
export interface ElevationOptions {bottomM:number;topM:number;slabM:number;cellM:number}
export interface OpeningCandidate {id:string;kind:'door'|'window'|'unknown';offsetM:number;widthM:number;bottomM:number;heightM:number;supportPoints:number;cues:string[]}
export interface WallElevation {
 wallId:string;axisM:Wall['axisM'];options:ElevationOptions;lengthM:number;columns:number;rows:number;
 uMin:Float32Array;uMax:Float32Array;zMin:Float32Array;zMax:Float32Array;counts:Uint32Array;rgb:Uint8Array;depthM:Float32Array;pointCount:number;sourcePointCount:number;
 candidates:OpeningCandidate[];
}
const median=(v:number[])=>{if(!v.length)return 0;v.sort((a,b)=>a-b);return v[Math.floor(v.length/2)]!;};
/** 全量可见源点参与墙局部坐标投影，预览采样不参与此计算。 */
export async function buildWallElevation(cloud:PointCloudData,wall:Wall,floorM:number,options:ElevationOptions,progress:(s:string)=>void=()=>{}) :Promise<WallElevation>{
 const {bottomM,topM,slabM,cellM}=options,lengthM=wallLength(wall);
 if(![bottomM,topM,slabM,cellM,lengthM,floorM,...wall.axisM.flat()].every(Number.isFinite)||lengthM<.01||topM<=bottomM||topM-bottomM>30||slabM<.02||slabM>1||cellM<.01||cellM>.1)throw Error('立面范围或分辨率无效。');
 const columns=Math.ceil(lengthM/cellM),rows=Math.ceil((topM-bottomM)/cellM),n=columns*rows;
 if(n>2_000_000)throw Error('立面过大，请缩小高度范围或提高网格尺寸。');
 const uMin=new Float32Array(n).fill(Infinity),uMax=new Float32Array(n).fill(-Infinity),zMin=new Float32Array(n).fill(Infinity),zMax=new Float32Array(n).fill(-Infinity);
 const counts=new Uint32Array(n),rgbSum=new Float64Array(n*3),depthSum=new Float64Array(n),ux=(wall.axisM[1][0]-wall.axisM[0][0])/lengthM,uy=(wall.axisM[1][1]-wall.axisM[0][1])/lengthM;let pointCount=0;
 for(let i=0;i<cloud.visible.length;i++){
  if(!cloud.visible[i])continue;
  const x=cloud.positions[i*3]!-wall.axisM[0][0],y=cloud.positions[i*3+1]!-wall.axisM[0][1],z=cloud.positions[i*3+2]!,u=x*ux+y*uy,d=-x*uy+y*ux;
  if(u<0||u>=lengthM||z<bottomM||z>=topM||Math.abs(d)>slabM)continue;
  const key=Math.floor((z-bottomM)/cellM)*columns+Math.floor(u/cellM);counts[key]++;depthSum[key]+=d;pointCount++;uMin[key]=Math.min(uMin[key]!,u);uMax[key]=Math.max(uMax[key]!,u);zMin[key]=Math.min(zMin[key]!,z);zMax[key]=Math.max(zMax[key]!,z);
  for(let k=0;k<3;k++)rgbSum[key*3+k]+=cloud.colors[i*3+k]!;
  if(i%500000===0){progress(`投影墙面证据 ${Math.floor(i/cloud.visible.length*100)}%`);await new Promise(r=>setTimeout(r,0));}
 }
 const rgb=new Uint8Array(n*3),depthM=new Float32Array(n).fill(NaN);
 for(let i=0;i<n;i++)if(counts[i]){depthM[i]=depthSum[i]!/counts[i]!;for(let k=0;k<3;k++)rgb[i*3+k]=Math.round(rgbSum[i*3+k]!/counts[i]!);}
 const elevation:WallElevation={wallId:wall.id,axisM:structuredClone(wall.axisM),options:{...options},lengthM,columns,rows,uMin,uMax,zMin,zMax,counts,rgb,depthM,pointCount,sourcePointCount:cloud.visible.length,candidates:[]};
 elevation.candidates=detectElevationCandidates(elevation,floorM,cloud.attributes?.hasColor!==false);return elevation;
}
/** 颜色/深度相对主墙面的差异产生候选，不将无点区域直接认作洞口。 */
export function detectElevationCandidates(e:WallElevation,floorM:number,hasColor=true){
 const {columns:w,rows:h,counts,rgb,depthM,options:o}=e,n=w*h,channels:[number[],number[],number[]]=[[],[],[]],ds:number[]=[];
 for(let i=0;i<n;i++)if(counts[i]!>=2){ds.push(depthM[i]!);for(let k=0;k<3;k++)channels[k]!.push(rgb[i*3+k]!);}
 if(ds.length<50)return [];
 const background=channels.map(median),baseDepth=median(ds),sum=background.reduce((a,b)=>a+b,0)+1,baseChroma=background.map(v=>v/sum);
 const colorMask=new Uint8Array(n),depthMask=new Uint8Array(n);
 for(let i=0;i<n;i++)if(counts[i]!>=2){
  const r=rgb[i*3]!,g=rgb[i*3+1]!,b=rgb[i*3+2]!,s=r+g+b+1,chroma=Math.hypot(r/s-baseChroma[0]!,g/s-baseChroma[1]!,b/s-baseChroma[2]!),brightness=(r+g+b)/3-background.reduce((a,b)=>a+b,0)/3;
  colorMask[i]=hasColor&&(chroma>.11||brightness< -55)?1:0;depthMask[i]=Math.abs(depthM[i]!-baseDepth)>.035?1:0;
 }
 const candidates:OpeningCandidate[]=[];
 // 颜色和深度分别连通，避免轻微墙面起伏把多个门连成一大片。
 for(const [pass,mask] of [colorMask,depthMask].entries()){
 for(let z=0;z<h;z++){let occupied=0,hits=0;for(let x=0;x<w;x++){const i=z*w+x;if(counts[i]!>=2){occupied++;hits+=mask[i]!;}}if(occupied>w*.4&&hits>occupied*.75)mask.fill(0,z*w,(z+1)*w);}
 // 用局部多数平滑掉单点噪声，再闭合窄框条；不会填充大范围缺测区域。
 const smooth=new Uint8Array(n);
 for(let z=1;z<h-1;z++)for(let x=1;x<w-1;x++){let hits=0;for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++)hits+=mask[(z+dz)*w+x+dx]!;if(hits>=4)smooth[z*w+x]=1;}
 const radius=Math.min(3,Math.max(1,Math.round(.06/o.cellM))),dilated=new Uint8Array(n),closed=new Uint8Array(n);
 for(let z=0;z<h;z++)for(let x=0;x<w;x++)if(smooth[z*w+x])for(let dz=-radius;dz<=radius;dz++)for(let dx=-radius;dx<=radius;dx++)if(z+dz>=0&&z+dz<h&&x+dx>=0&&x+dx<w)dilated[(z+dz)*w+x+dx]=1;
 for(let z=radius;z<h-radius;z++)for(let x=radius;x<w-radius;x++){let full=true;for(let dz=-radius;dz<=radius&&full;dz++)for(let dx=-radius;dx<=radius;dx++)if(!dilated[(z+dz)*w+x+dx]){full=false;break;}if(full)closed[z*w+x]=1;}
 const visited=new Uint8Array(n);
 for(let start=0;start<n;start++){
  if(!closed[start]||visited[start])continue;
  const queue=[start];visited[start]=1;let left=w,right=0,low=h,high=0,area=0,points=0,color=0,depth=0,realLeft=Infinity,realRight=-Infinity,realBottom=Infinity,realTop=-Infinity;
  for(let j=0;j<queue.length;j++){const k=queue[j]!,x=k%w,z=Math.floor(k/w);left=Math.min(left,x);right=Math.max(right,x);low=Math.min(low,z);high=Math.max(high,z);area++;points+=counts[k]!;color+=colorMask[k]!;depth+=depthMask[k]!;if(counts[k]){realLeft=Math.min(realLeft,e.uMin[k]!);realRight=Math.max(realRight,e.uMax[k]!);realBottom=Math.min(realBottom,e.zMin[k]!);realTop=Math.max(realTop,e.zMax[k]!);}
   for(const [dx,dz]of [[-1,0],[1,0],[0,-1],[0,1]]){const nx=x+dx!,nz=z+dz!;if(nx<0||nx>=w||nz<0||nz>=h)continue;const next=nz*w+nx;if(closed[next]&&!visited[next]){visited[next]=1;queue.push(next);}}
  }
  const widthM=realRight-realLeft,heightM=realTop-realBottom,bottomM=realBottom,fill=area/((right-left+1)*(high-low+1));
  if(widthM<.45||widthM>Math.min(8,e.lengthM*.9)||heightM<.6||heightM>3.5||points<80||fill<.35||low<=radius||high>=h-radius-1)continue;
  const sill=bottomM-floorM,kind=pass===1?'unknown':sill>=-.12&&sill<=.2&&heightM>=1.5&&heightM<=2.8&&widthM<=2.5?'door':sill>.35&&sill<2.2?'window':'unknown';
  const cues=[...(color>area*.15?['颜色区别']:[]),...(depth>area*.15?['深度变化']:[]),'矩形区域'];
  candidates.push({id:crypto.randomUUID(),kind,offsetM:realLeft,widthM:Math.min(widthM,e.lengthM-realLeft),bottomM,heightM,supportPoints:points,cues});
 }
 }
 const retained:OpeningCandidate[]=[];
 for(const c of candidates){if(retained.some(a=>{const overlap=Math.max(0,Math.min(a.offsetM+a.widthM,c.offsetM+c.widthM)-Math.max(a.offsetM,c.offsetM))*Math.max(0,Math.min(a.bottomM+a.heightM,c.bottomM+c.heightM)-Math.max(a.bottomM,c.bottomM));return overlap/Math.min(a.widthM*a.heightM,c.widthM*c.heightM)>.7;}))continue;retained.push(c);}
 return retained.sort((a,b)=>a.offsetM-b.offsetM).slice(0,100);
}
/** 框选仍统计原始投影证据，不把空白框或截图坐标直接变成建筑构件。 */
export function candidateFromBox(e:WallElevation,bounds:[number,number,number,number]):OpeningCandidate{
 const [a,b,c,d]=bounds,left=Math.max(0,Math.min(a,c)),right=Math.min(e.lengthM,Math.max(a,c)),bottomM=Math.max(e.options.bottomM,Math.min(b,d)),top=Math.min(e.options.topM,Math.max(b,d));let supportPoints=0;
 if(![a,b,c,d].every(Number.isFinite)||right-left<.1||top-bottomM<.1)throw Error('请框选有效门窗边界。');
 for(let z=0;z<e.rows;z++)for(let x=0;x<e.columns;x++){const u=(x+.5)*e.options.cellM,v=e.options.bottomM+(z+.5)*e.options.cellM;if(u>=left&&u<=right&&v>=bottomM&&v<=top)supportPoints+=e.counts[z*e.columns+x]!;}
 if(supportPoints<20)throw Error('选区内墙面证据不足，不能仅凭空白创建识别候选。');
 return {id:crypto.randomUUID(),kind:'unknown',offsetM:left,widthM:right-left,bottomM,heightM:top-bottomM,supportPoints,cues:['人工框选立面证据']};
}
