import type { PointCloudData } from "../../../src/domain/types";
import type { PairedWall } from "../domain/pairedReview";
import { fitWallLines } from "./wallLines";

/** 原图采集不预造建筑模型；在桌面对完整源点拟合墙带及可见高度初值。 */
export async function pairedWallsFromCloud(cloud: PointCloudData, progress: (stage:string)=>void=()=>{}) {
  const fitted = await fitWallLines(cloud, progress);
  const low = fitted.bounds.min[2], high = fitted.bounds.max[2];
  const cell = Math.max(.02, (high-low)/2048), bins = Math.ceil((high-low)/cell)+1;
  const walls:PairedWall[]=[];
  for(const [index, segment] of fitted.segments.entries()){
    const [a,b]=[segment.a,segment.b],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
    const heights=new Uint32Array(bins);let count=0;
    for(let i=0;i<cloud.visible.length;i++){
      if(!cloud.visible[i])continue;
      const x=cloud.positions[i*3]!-a[0],y=cloud.positions[i*3+1]!-a[1],u=(x*dx+y*dy)/length;
      if(u<0||u>length||Math.abs(x*dy-y*dx)/length>.08)continue;
      const bin=Math.min(bins-1,Math.max(0,Math.floor((cloud.positions[i*3+2]!-low)/cell)));
      heights[bin]++;count++;
    }
    if(count<30)continue;
    let cumulative=0,bottom:number|undefined,top:number|undefined;
    for(let bin=0;bin<bins;bin++){
      cumulative+=heights[bin]!;
      if(bottom===undefined&&cumulative>=count*.02)bottom=low+bin*cell;
      if(cumulative>=count*.98){top=low+(bin+1)*cell;break;}
    }
    if(bottom!==undefined&&top!==undefined&&top-bottom>=.8)walls.push({id:`wall-${index}`,axisM:[a,b],bottomM:bottom,topM:Math.min(high,top)});
    progress(`拟合关键帧墙带 ${index+1}/${fitted.segments.length}`);await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(!walls.length)throw Error("可见墙带高度证据不足，请复核点云范围；没有补造墙体。");
  return walls;
}
