import type {PointCloudData} from '../../../src/domain/types';
import {projectPairedPoint,type PairedFocus,type PairedCandidate,type PairedWall} from '../domain/pairedReview';
/** 全部可见源点先按3cm去重，再按8px取近深度，保持显示预算与分析输入分离。 */
export async function keyframeSupport(cloud:PointCloudData,focus:PairedFocus,walls:PairedWall[],candidates:PairedCandidate[],instances:Uint16Array,progress:(s:string)=>void=()=>{}){
 if(instances.length!==512*512)throw Error('识别语义图尺寸无效。');
 const width=focus.camera.width,height=focus.camera.height,columns=Math.ceil(width/8),bins=columns*Math.ceil(height/8);
 const depth=new Float32Array(bins).fill(Infinity),indices=new Int32Array(bins).fill(-1),pixelsX=new Float32Array(bins),pixelsY=new Float32Array(bins),seen=new Set<string>();
 const center=[focus.frame.TWorldCamera[3]!,focus.frame.TWorldCamera[7]!,focus.frame.TWorldCamera[11]!];
 for(let i=0;i<cloud.visible.length;i++){
  if(!cloud.visible[i])continue;
  const p=[cloud.positions[i*3]!,cloud.positions[i*3+1]!,cloud.positions[i*3+2]!];
  if(!p.every(Number.isFinite)||(p[0]!-center[0]!)**2+(p[1]!-center[1]!)**2+(p[2]!-center[2]!)**2>=49)continue;
  const key=p.map(v=>Math.floor(v/.03)).join(',');if(seen.has(key))continue;seen.add(key);
  const uv=projectPairedPoint(p,focus);if(!uv||uv[0]<0||uv[0]>=width||uv[1]<0||uv[1]>=height)continue;
  const bin=Math.floor(uv[1]/8)*columns+Math.floor(uv[0]/8);
  if(uv[2]<depth[bin]!){depth[bin]=uv[2];indices[bin]=i;pixelsX[bin]=uv[0];pixelsY[bin]=uv[1];}
  if(i%500000===0){progress(`将识别区域关联完整源点 ${Math.round(i/cloud.visible.length*100)}%`);await new Promise(resolve=>setTimeout(resolve,0));}
 }
 const supports=candidates.map(()=>[] as number[]);
 for(let i=0;i<bins;i++)if(indices[i]!>=0){
  // 邻格内8px半径的近表面也参与遮挡，避免格边界及体素抽样留下远墙漏点。
  let occluded=false;const x=i%columns,y=Math.floor(i/columns);
  for(let dy=-1;dy<=1&&!occluded;dy++)for(let dx=-1;dx<=1;dx++){
   const xx=x+dx,yy=y+dy;if(xx<0||xx>=columns||yy<0||yy>=Math.ceil(height/8))continue;const other=yy*columns+xx;
   if(indices[other]!>=0&&depth[other]!+.05<depth[i]!&&(pixelsX[other]!-pixelsX[i]!)**2+(pixelsY[other]!-pixelsY[i]!)**2<=64){occluded=true;break;}
  }
  if(occluded)continue;
  const mask=instances[Math.min(511,Math.floor(pixelsY[i]!/height*512))*512+Math.min(511,Math.floor(pixelsX[i]!/width*512))]!;if(mask>0&&mask<=supports.length)supports[mask-1]!.push(indices[i]!);}
 const percentile=(a:number[],q:number)=>{const index=(a.length-1)*q,lo=Math.floor(index);return a[lo]!+(a[Math.ceil(index)]!-a[lo]!)*(index-lo);};
 return candidates.map((candidate,index)=>{
  const support=supports[index]!;let best:{wall:PairedWall;u:number[];z:number[]}|undefined;
  for(const wall of walls){const [a,b]=wall.axisM,dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),u:number[]=[],z:number[]=[];
   for(const i of support){const x=cloud.positions[i*3]!-a[0],y=cloud.positions[i*3+1]!-a[1],offset=(x*dx+y*dy)/length;if(Math.abs(x*dy-y*dx)/length<.08&&offset>=0&&offset<=length){u.push(offset);z.push(cloud.positions[i*3+2]!);}}
   if(u.length>(best?.u.length??0))best={wall,u,z};
  }
  const count=best?.u.length??0,fraction=count/Math.max(1,support.length);let envelope:PairedCandidate['envelope'];
  if(best&&count>=30&&fraction>=.25){best.u.sort((a,b)=>a-b);best.z.sort((a,b)=>a-b);const u:[number,number]=[percentile(best.u,.02),percentile(best.u,.98)],z:[number,number]=[percentile(best.z,.02),percentile(best.z,.98)];if(u[1]>u[0]&&z[1]>z[0])envelope={u,z};}
  return {...candidate,wallId:best?.wall.id,wallSupportPoints:count,wallSupportFraction:fraction,envelope};
 });
}
