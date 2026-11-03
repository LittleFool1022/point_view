import {restyleCadDrawing} from "../../../src/cad/sheet";
import { appendDimension } from "../../../src/cad/dimensions";
import { openingPlanSegments } from "./openingTemplates";
import { generateDrawing } from "../pipeline/analysis";
import {applyCadAnnotations, type CadAnnotation, type DrawingModel, type CadDrawingSettings, type CadEntity} from "../../../src/cad/model";
import { polygonArea, validateBuilding, wallLength, type BuildingModel, type Vec2 } from "./building";
import type { PointCloudData } from "../../../src/domain/types";
/** BIM 的门窗/房间统计来自构件，添加文字标签不能覆盖为标签数量。 */
export function annotateSurveyDrawing(model: DrawingModel, annotations: CadAnnotation[]): DrawingModel {
  const next = applyCadAnnotations(model, annotations);
  if ((model.parameters as {analysisMode?: string}).analysisMode === 'building-model') {
    const {doorCount, windowCount, roomCount} = model.statistics;
    Object.assign(next.statistics, {doorCount, windowCount, roomCount});
  }
  return next;
}
export function drawingFromBuilding(building:BuildingModel,levelId:string,settings:Partial<CadDrawingSettings>,pointCount:number){
  const error=validateBuilding(building).find(i=>i.code!=='UNREVIEWED');if(error)throw Error(error.message);
  const walls=building.walls.filter(w=>w.levelId===levelId);if(!walls.length)throw Error('当前楼层没有墙体。');
  const positions:number[]=[];for(const w of walls)for(let i=0;i<=100;i++)positions.push(w.axisM[0][0]+(w.axisM[1][0]-w.axisM[0][0])*i/100,w.axisM[0][1]+(w.axisM[1][1]-w.axisM[0][1])*i/100,1);
  const cloud:PointCloudData={id:building.id,frameId:'building',stampNs:0n,positions:Float32Array.from(positions),colors:new Uint8Array(positions.length),visible:new Uint8Array(positions.length/3).fill(1)};
  const model=generateDrawing(cloud,`${building.levels.find(l=>l.id===levelId)?.name??'楼层'} · BIM修订${building.revision}`,'xy',{...settings,orthogonalizeWalls:false,alignToPrincipalAxis:false,minRegionCells:1,minCellPoints:1,includePoints:false});
  model.dimensions=[];model.entities=model.entities.filter(e=>!['wall','dimension','point-evidence'].includes(e.category));let n=0;
  const line=(a:Vec2,b:Vec2,layer:CadEntity['layer'],category:CadEntity['category'],id?:string)=>model.entities.push({id:`bim-${n++}`,type:'line',start:a.map(v=>v*1000)as Vec2,end:b.map(v=>v*1000)as Vec2,layer,category,source:'derived',confidence:'mixed',metadata:{modelRevision:building.revision,elementId:id??building.id}});
  for(const w of walls){const length=wallLength(w),ux=(w.axisM[1][0]-w.axisM[0][0])/length,uy=(w.axisM[1][1]-w.axisM[0][1])/length,at=(x:number,d:number):Vec2=>[w.axisM[0][0]+ux*x-uy*d,w.axisM[0][1]+uy*x+ux*d];const holes=building.openings.filter(o=>o.wallId===w.id).sort((a,b)=>a.offsetM-b.offsetM);
    // 平面中断开洞口处墙线，门窗绘于独立语义图层。
    let cursor=0;for(const o of [...holes,{offsetM:length,widthM:0}]){if(o.offsetM>cursor)for(const d of [-w.thicknessM/2,w.thicknessM/2])line(at(cursor,d),at(o.offsetM,d),'OBSERVED_WALL','wall',w.id);cursor=Math.max(cursor,o.offsetM+o.widthM);}
    for(const o of holes)for(const [a,b] of openingPlanSegments(o,w.thicknessM))line(at(o.offsetM+a[0],a[1]),at(o.offsetM+b[0],b[1]),o.kind==='door'?'DOOR':'WINDOW',o.kind,o.id);
    for(const x of [0,length])line(at(x,-w.thicknessM/2),at(x,w.thicknessM/2),'OBSERVED_WALL','wall',w.id);
  }
  for(const r of building.rooms.filter(r=>r.levelId===levelId)){const c=r.boundaryM.reduce((s,p)=>[s[0]+p[0]/r.boundaryM.length,s[1]+p[1]/r.boundaryM.length]as Vec2,[0,0]as Vec2);model.entities.push({id:`bim-room-${r.id}`,type:'text',text:`${r.name} ${polygonArea(r.boundaryM).toFixed(2)} m²`,position:c.map(v=>v*1000)as Vec2,heightMm:180,layer:'TEXT',category:'text',source:'derived',confidence:'mixed'});}
  const all=walls.flatMap(w=>w.axisM),minX=Math.min(...all.map(p=>p[0])),maxX=Math.max(...all.map(p=>p[0])),minY=Math.min(...all.map(p=>p[1])),maxY=Math.max(...all.map(p=>p[1])),off=Math.max(maxX-minX,maxY-minY)*.1;
  for(const [start,end,linePoint] of [ [[minX,minY],[maxX,minY],[minX,minY-off]], [[minX,minY],[minX,maxY],[minX-off,minY]] ] as [Vec2,Vec2,Vec2][]){
    if(Math.hypot(end[0]-start[0],end[1]-start[1])>1e-8)appendDimension(model,{id:`bim-dim-${n++}`,kind:'aligned',start:start.map(v=>v*1000) as Vec2,end:end.map(v=>v*1000) as Vec2,linePoint:linePoint.map(v=>v*1000) as Vec2,textHeightMm:180,roundingMm:settings.roundingMm??1,source:'derived'});
  }
  const geometry=model.entities.flatMap(e=>e.category==='frame'||e.layer==='TITLE_BLOCK'?[]:e.type==='line'?[e.start,e.end]:e.type==='polyline'?e.points:[e.position]);model.modelBoundsMm={min:[Math.min(...geometry.map(p=>p[0])),Math.min(...geometry.map(p=>p[1]))],max:[Math.max(...geometry.map(p=>p[0])),Math.max(...geometry.map(p=>p[1]))]};
  model.statistics={...model.statistics,sourcePointCount:pointCount,observedWallEntities:walls.length,doorCount:building.openings.filter(o=>o.kind==='door'&&walls.some(w=>w.id===o.wallId)).length,windowCount:building.openings.filter(o=>o.kind==='window'&&walls.some(w=>w.id===o.wallId)).length,roomCount:building.rooms.filter(r=>r.levelId===levelId).length};Object.assign(model.parameters,{analysisMode:'building-model',buildingId:building.id,buildingRevision:building.revision,buildingLevelId:levelId});
  model.warnings=[{code:'BUILDING_DERIVED',severity:'warning',message:'本图由当前建筑模型派生，尺寸为墙轴范围；厚高、门窗和房间按模型参数，须结合测量依据复核。'}];model.titleBlock.evidenceNote=`建筑模型 ${building.id} 修订 ${building.revision}`;return restyleCadDrawing(model,settings);
}
