import type { PointCloudData } from "../../../src/domain/types";
import { createMaskRule, type AutoCleanOperation, type MaskClipRule } from "../domain/cleaning";
import { evaluateWallPreservation, fitWallLines, selectArchitecturalOutline, type WallSegment } from "./wallLines";

type P=[number,number];
export interface AutoCleanOptions { outdoor:boolean; indoor:boolean }
export interface AutoCleanSuggestion {
  rules:MaskClipRule[];
  outdoorRemoved:number;
  indoorRemoved:number;
  visibleBefore:number;
  discoveredWallCount:number;
  wallsChanged:boolean;
  warnings:string[];
  baselineWalls?:WallSegment[];
  outdoorIndices?:number[];
  indoorIndices?:number[];
}

const distanceToSegment=(p:P,s:WallSegment)=>{
  const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],length2=dx*dx+dy*dy;
  const t=length2?Math.max(0,Math.min(1,((p[0]-s.a[0])*dx+(p[1]-s.a[1])*dy)/length2)):0;
  return Math.hypot(p[0]-s.a[0]-t*dx,p[1]-s.a[1]-t*dy);
};
const quantile=(sorted:number[],q:number)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.floor((sorted.length-1)*q)))]!;
const layerCount=(value:number)=>{let bits=value>>>0,count=0;while(bits){bits&=bits-1;count++;}return count;};

function makeRule(indices:number[],cloud:PointCloudData,operation:AutoCleanOperation):MaskClipRule|undefined{
  if(!indices.length)return undefined;
  const rule=createMaskRule(Uint32Array.from(indices),cloud.visible.length);rule.operation=operation;return rule;
}

/** 自动清理只产生可撤销的原件点号掩码；不改 positions、normals 或原始 visible。 */
export async function suggestAutoClean(cloud:PointCloudData,options:AutoCleanOptions,progress:(stage:string)=>void):Promise<AutoCleanSuggestion>{
  const warnings:string[]=[],visibleBefore=cloud.visible.reduce((sum,value)=>sum+(value?1:0),0);
  if(!options.outdoor&&!options.indoor)return {rules:[],outdoorRemoved:0,indoorRemoved:0,visibleBefore,discoveredWallCount:0,wallsChanged:false,warnings};
  let walls:WallSegment[],rotation:number;
  try{
    const fitted=await fitWallLines(cloud,progress);
    const main=[...fitted.segments].sort((a,b)=>Math.hypot(b.b[0]-b.a[0],b.b[1]-b.a[1])-Math.hypot(a.b[0]-a.a[0],a.b[1]-a.a[1]))[0]!;
    let angle=Math.atan2(main.b[1]-main.a[1],main.b[0]-main.a[0]);while(angle>Math.PI/4)angle-=Math.PI/2;while(angle<-Math.PI/4)angle+=Math.PI/2;rotation=-angle;
    const cs=Math.cos(rotation),sn=Math.sin(rotation),rotated=fitted.segments.map(segment=>({...segment,a:[segment.a[0]*cs-segment.a[1]*sn,segment.a[0]*sn+segment.a[1]*cs] as P,b:[segment.b[0]*cs-segment.b[1]*sn,segment.b[0]*sn+segment.b[1]*cs] as P}));
    walls=selectArchitecturalOutline(rotated,0).kept;
  }catch{
    return {rules:[],outdoorRemoved:0,indoorRemoved:0,visibleBefore,discoveredWallCount:0,wallsChanged:false,warnings:['建筑结构证据不足，未执行自动清理；原始点保持不变。']};
  }
  if(walls.length<2)return {rules:[],outdoorRemoved:0,indoorRemoved:0,visibleBefore,discoveredWallCount:0,wallsChanged:false,warnings:['建筑外轮廓不足，未执行自动清理。']};
  const cs=Math.cos(rotation),sn=Math.sin(rotation),project=(x:number,y:number):P=>[x*cs-y*sn,x*sn+y*cs];
  const wallPoints=walls.flatMap(wall=>[wall.a,wall.b]),pad=.35;
  const minX=Math.min(...wallPoints.map(p=>p[0]))-pad,maxX=Math.max(...wallPoints.map(p=>p[0]))+pad,minY=Math.min(...wallPoints.map(p=>p[1]))-pad,maxY=Math.max(...wallPoints.map(p=>p[1]))+pad;
  const inside=(p:P)=>p[0]>=minX&&p[0]<=maxX&&p[1]>=minY&&p[1]<=maxY;
  const normals=cloud.normals,wallNormal=(index:number)=>{
    if(!normals)return false;const nx=normals[index*3]!,ny=normals[index*3+1]!,nz=normals[index*3+2]!;return nx*nx+ny*ny+nz*nz>64&&Math.abs(nz)<=44;
  };

  // 室外结构保护格网：连续垂直结构不能因为位于建筑包络外就被当作植被。
  const cell=.25,fitBounds=fitBoundsOf(cloud,project),nx=Math.ceil((fitBounds.max[0]-fitBounds.min[0])/cell)+1,ny=Math.ceil((fitBounds.max[1]-fitBounds.min[1])/cell)+1,gridSize=nx*ny,structureAvailable=gridSize<=4_000_000;
  const counts=new Uint32Array(structureAvailable?gridSize:0),normalCounts=new Uint32Array(structureAvailable?gridSize:0),low=new Float32Array(structureAvailable?gridSize:0).fill(Infinity),high=new Float32Array(structureAvailable?gridSize:0).fill(-Infinity),layers=new Uint32Array(structureAvailable?gridSize:0);
  if(structureAvailable)for(let i=0;i<cloud.visible.length;i++)if(cloud.visible[i]){
    const p=project(cloud.positions[i*3]!,cloud.positions[i*3+1]!),z=cloud.positions[i*3+2]!,gx=Math.max(0,Math.min(nx-1,Math.floor((p[0]-fitBounds.min[0])/cell))),gy=Math.max(0,Math.min(ny-1,Math.floor((p[1]-fitBounds.min[1])/cell))),key=gy*nx+gx;
    counts[key]++;if(wallNormal(i))normalCounts[key]++;low[key]=Math.min(low[key]!,z);high[key]=Math.max(high[key]!,z);layers[key]|=1<<((Math.floor(z/.25)%32+32)%32);
  }
  const outdoorIndices:number[]=[];
  if(options.outdoor&&structureAvailable){
    for(let i=0;i<cloud.visible.length;i++)if(cloud.visible[i]){
      const p=project(cloud.positions[i*3]!,cloud.positions[i*3+1]!);if(inside(p))continue;
      if(wallNormal(i))continue;
      const gx=Math.max(0,Math.min(nx-1,Math.floor((p[0]-fitBounds.min[0])/cell))),gy=Math.max(0,Math.min(ny-1,Math.floor((p[1]-fitBounds.min[1])/cell))),key=gy*nx+gx;
      const structural=counts[key]!>=8&&high[key]!-low[key]!>=1.2&&layerCount(layers[key]!)>=4&&(!normals||normalCounts[key]!>=4);
      if(!structural)outdoorIndices.push(i);
    }
    if(outdoorIndices.length>visibleBefore*.7){warnings.push('室外候选比例异常，已放弃室外自动清理。');outdoorIndices.length=0;}
  }else if(options.outdoor)warnings.push('室外范围过大，未执行室外自动清理。');

  const indoorIndices:number[]=[];
  if(options.indoor){
    const zSample:number[]=[],stride=Math.max(1,Math.ceil(visibleBefore/200_000));let cursor=0,insideCount=0;
    for(let i=0;i<cloud.visible.length;i++)if(cloud.visible[i]&&inside(project(cloud.positions[i*3]!,cloud.positions[i*3+1]!))){insideCount++;if(cursor++%stride===0)zSample.push(cloud.positions[i*3+2]!);}
    zSample.sort((a,b)=>a-b);
    if(zSample.length<100){warnings.push('室内高度证据不足，未执行室内自动清理。');}
    else{
      const floor=quantile(zSample,.02),ceiling=quantile(zSample,.98),height=ceiling-floor;
      if(height<.8)warnings.push('室内高度范围不足，未执行室内自动清理。');
      else{
        const indoorCell=.15,inx=Math.max(1,Math.ceil((maxX-minX)/indoorCell)),iny=Math.max(1,Math.ceil((maxY-minY)/indoorCell)),n=inx*iny;
        const counts=new Uint32Array(n),cellNormalCounts=new Uint32Array(n),cellLayers=new Uint32Array(n),low=new Float32Array(n).fill(Infinity),high=new Float32Array(n).fill(-Infinity),cellOf=new Int32Array(cloud.visible.length).fill(-1);
        for(let i=0;i<cloud.visible.length;i++)if(cloud.visible[i]){
          const p=project(cloud.positions[i*3]!,cloud.positions[i*3+1]!),z=cloud.positions[i*3+2]!;if(!inside(p)||z<=floor+.12||z>=ceiling-.12)continue;
          if(walls.some(wall=>distanceToSegment(p,wall)<=.22))continue;
          const x=Math.max(0,Math.min(inx-1,Math.floor((p[0]-minX)/indoorCell))),y=Math.max(0,Math.min(iny-1,Math.floor((p[1]-minY)/indoorCell))),key=y*inx+x;
          cellOf[i]=key;counts[key]++;if(wallNormal(i))cellNormalCounts[key]++;low[key]=Math.min(low[key]!,z);high[key]=Math.max(high[key]!,z);cellLayers[key]|=1<<((Math.floor(z/.25)%32+32)%32);
        }
        // 法向 + 跨高度 + 墙连接关系：保护贯通层高的结构柱及与墙相连的连续墙体，不再整批保留低矮/未到顶的家具竖面。
        const structuralCell=new Uint8Array(n),reqLayers=Math.max(4,Math.min(6,Math.floor(height/.45))),nearCeiling=ceiling-Math.max(.28,height*.12),minStructSpan=Math.max(1.4,height*.65);
        const isWallContinuous=(key:number)=>{
          const span=high[key]!-low[key]!,hasNorm=!normals||cellNormalCounts[key]!>=Math.max(3,Math.floor(counts[key]!*.2));
          return counts[key]!>=4&&high[key]!>=ceiling-Math.max(.35,height*.15)&&span>=Math.max(1.2,height*.5)&&layerCount(cellLayers[key]!)>=3&&hasNorm;
        };
        const wallQueue=new Int32Array(n);let wallHead=0,wallTail=0;
        for(let key=0;key<n;key++)if(counts[key]){
          const span=high[key]!-low[key]!,hasNorm=!normals||cellNormalCounts[key]!>=Math.max(3,Math.floor(counts[key]!*.2));
          if(counts[key]!>=6&&high[key]!>=nearCeiling&&span>=minStructSpan&&layerCount(cellLayers[key]!)>=reqLayers&&hasNorm){structuralCell[key]=1;wallQueue[wallTail++]=key;}
          else if(isWallContinuous(key)){
            const x=key%inx,y=Math.floor(key/inx),cx=minX+(x+.5)*indoorCell,cy=minY+(y+.5)*indoorCell;
            if(walls.some(wall=>distanceToSegment([cx,cy],wall)<=.35)){structuralCell[key]=1;wallQueue[wallTail++]=key;}
          }
        }
        while(wallHead<wallTail){
          const key=wallQueue[wallHead++]!,x=key%inx,y=Math.floor(key/inx);
          for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const xx=x+dx,yy=y+dy;if(xx<0||xx>=inx||yy<0||yy>=iny)continue;const next=yy*inx+xx;if(counts[next]&&!structuralCell[next]&&isWallContinuous(next)){structuralCell[next]=1;wallQueue[wallTail++]=next;}}
        }
        const accepted=new Uint8Array(n),visited=new Uint8Array(n),queue=new Int32Array(n),component=new Int32Array(n);
        for(let seed=0;seed<n;seed++)if(counts[seed]&&!structuralCell[seed]&&!visited[seed]){
          let head=0,tail=0,size=0,count=0,minZ=Infinity,maxZ=-Infinity,minGX=Infinity,maxGX=-Infinity,minGY=Infinity,maxGY=-Infinity;queue[tail++]=seed;visited[seed]=1;
          while(head<tail){const key=queue[head++]!,x=key%inx,y=Math.floor(key/inx);component[size++]=key;count+=counts[key]!;minZ=Math.min(minZ,low[key]!);maxZ=Math.max(maxZ,high[key]!);minGX=Math.min(minGX,x);maxGX=Math.max(maxGX,x);minGY=Math.min(minGY,y);maxGY=Math.max(maxGY,y);
            for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const xx=x+dx,yy=y+dy;if(xx<0||xx>=inx||yy<0||yy>=iny)continue;const next=yy*inx+xx;if(counts[next]&&!structuralCell[next]&&!visited[next]){visited[next]=1;queue[tail++]=next;}}
          }
          const width=(maxGX-minGX+1)*indoorCell,depth=(maxGY-minGY+1)*indoorCell;
          if(count>=4&&maxZ-minZ<=Math.max(2.2,height*.85)&&width<=4.5&&depth<=4.5&&minZ>floor+.08&&maxZ<ceiling-.02)for(let j=0;j<size;j++)accepted[component[j]!]=1;
        }
        for(let i=0;i<cloud.visible.length;i++)if(cellOf[i]!>=0&&accepted[cellOf[i]!])indoorIndices.push(i);
        if(indoorIndices.length>Math.max(1000,insideCount*.45)){warnings.push('室内非结构候选比例异常，已放弃室内自动清理；请人工复核。');indoorIndices.length=0;}
      }
    }
  }
  const checkCompatibility=async(indices:number[])=>{
    if(!indices.length)return {ok:true,discoveredCount:0};
    const masked={...cloud,visible:cloud.visible.slice()};for(const index of indices)masked.visible[index]=0;
    try{
      const fitted=await fitWallLines(masked,()=>{}),rotated=fitted.segments.map(segment=>({...segment,a:project(...segment.a),b:project(...segment.b)}));
      const after=selectArchitecturalOutline(rotated,0).kept;
      const {allPreserved,discovered}=evaluateWallPreservation(walls,after);
      return {ok:allPreserved,discoveredCount:discovered.length};
    }catch{return {ok:false,discoveredCount:0};}
  };
  let discoveredWallCount=0;
  if(outdoorIndices.length){
    const res=await checkCompatibility(outdoorIndices);
    if(!res.ok){outdoorIndices.length=0;warnings.push('室外清理丢失了既有墙线证据，已放弃室外自动规则。');}
    else discoveredWallCount=res.discoveredCount;
  }
  if(indoorIndices.length){
    const res=await checkCompatibility(indoorIndices);
    if(!res.ok){indoorIndices.length=0;warnings.push('室内清理丢失了既有墙线证据，已放弃室内自动规则。');}
    else discoveredWallCount=Math.max(discoveredWallCount,res.discoveredCount);
  }
  if(outdoorIndices.length&&indoorIndices.length){
    const res=await checkCompatibility([...outdoorIndices,...indoorIndices]);
    if(!res.ok){indoorIndices.length=0;warnings.push('室内外组合清理丢失了既有墙线证据，已保留室外规则并放弃室内规则。');}
    else discoveredWallCount=res.discoveredCount;
  }
  const invCs=Math.cos(-rotation),invSn=Math.sin(-rotation),unproject=(p:P):P=>[p[0]*invCs-p[1]*invSn,p[0]*invSn+p[1]*invCs];
  const baselineWalls=walls.map(w=>({...w,a:unproject(w.a),b:unproject(w.b)}));
  const rules=[makeRule(outdoorIndices,cloud,'auto-outdoor-v1'),makeRule(indoorIndices,cloud,'auto-indoor-v1')].filter((rule):rule is MaskClipRule=>!!rule);
  const hasOutdoor=rules.some(rule=>rule.operation==='auto-outdoor-v1'),hasIndoor=rules.some(rule=>rule.operation==='auto-indoor-v1');
  return {rules,outdoorRemoved:hasOutdoor?outdoorIndices.length:0,indoorRemoved:hasIndoor?indoorIndices.length:0,visibleBefore,discoveredWallCount,wallsChanged:discoveredWallCount>0,warnings,baselineWalls,outdoorIndices:hasOutdoor?outdoorIndices:[],indoorIndices:hasIndoor?indoorIndices:[]};
}

function fitBoundsOf(cloud:PointCloudData,project:(x:number,y:number)=>P):{min:P;max:P}{
  const min:[number,number]=[Infinity,Infinity],max:[number,number]=[-Infinity,-Infinity];
  for(let i=0;i<cloud.visible.length;i++)if(cloud.visible[i]){const [x,y]=project(cloud.positions[i*3]!,cloud.positions[i*3+1]!);min[0]=Math.min(min[0],x);min[1]=Math.min(min[1],y);max[0]=Math.max(max[0],x);max[1]=Math.max(max[1],y);}
  return {min,max};
}
