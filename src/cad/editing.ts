import { cadEntityBounds, CAD_AUTO_CONNECTION, CAD_MANUAL_CONNECTION, type CadArcEntity, type CadCircleEntity, type CadEntity, type CadLineEntity, type CadLineType, type CadPolylineEntity, type DrawingModel } from "./model";
import { openCadEndpoints, previewCadConnection, type CadConnectionStyle } from "./connections";

export type CadDrawTool = "line" | "polyline" | "rectangle" | "circle" | "arc";
export const CAD_DIRECT_DRAW = "cad-direct-draw";
export const CAD_DIRECT_EDIT = "cad-direct-edit";
const distance = (a:[number,number],b:[number,number]) => Math.hypot(a[0]-b[0],a[1]-b[1]);

export function canEditCadEntity(entity:CadEntity):boolean {
  return entity.layer!=="FRAME"&&entity.layer!=="TITLE_BLOCK"&&entity.category!=="dimension"&&!entity.metadata?.dimensionId;
}

export function createCadShape(tool:CadDrawTool,points:[number,number][],lineType:CadLineType):CadEntity {
  const common={id:crypto.randomUUID(),source:"manual" as const,confidence:"confirmed" as const,lineType,metadata:{operation:CAD_DIRECT_DRAW}};
  if(points.some(p=>!p.every(Number.isFinite)))throw Error("图元坐标无效，请重新绘制。");
  if(tool==="line"||tool==="polyline"){
    if(tool==="line"&&points.length!==2||tool==="polyline"&&points.length<2)throw Error(tool==="line"?"直线需要两个端点。":"多段线至少需要两个顶点。");
    if(points.some((p,i)=>i&&distance(p,points[i-1]!)<1e-6))throw Error("相邻顶点重合，未生成图元。");
    if(tool==="line")return {...common,type:"line",start:[...points[0]!],end:[...points[1]!],layer:"INFERRED_WALL",category:"wall"} as CadLineEntity;
    return {...common,type:"polyline",points:points.map(p=>[...p]),closed:false,layer:"INFERRED_WALL",category:"wall"} as CadPolylineEntity;
  }
  if(tool==="rectangle"){
    if(points.length!==2)throw Error("矩形需要两个对角点。");
    const [a,b]=points,w=Math.abs(a![0]-b![0]),h=Math.abs(a![1]-b![1]);if(w<1e-6||h<1e-6)throw Error("矩形宽度和高度必须大于零。");
    const min:[number,number]=[Math.min(a![0],b![0]),Math.min(a![1],b![1])],max:[number,number]=[Math.max(a![0],b![0]),Math.max(a![1],b![1])];
    return {...common,type:"polyline",points:[min,[max[0],min[1]],max,[min[0],max[1]]],closed:true,layer:"USER_DRAWING",category:"geometry"} as CadPolylineEntity;
  }
  if(tool==="circle"){
    if(points.length!==2)throw Error("圆需要圆心和半径点。");
    const radiusMm=distance(points[0]!,points[1]!);if(radiusMm<1e-6)throw Error("圆半径必须大于零。");
    return {...common,type:"circle",center:[...points[0]!],radiusMm,layer:"USER_DRAWING",category:"geometry"} as CadCircleEntity;
  }
  if(points.length!==3)throw Error("圆弧需要圆心、起点和终点。");
  const radiusMm=distance(points[0]!,points[1]!);if(radiusMm<1e-6||distance(points[0]!,points[2]!)<1e-6)throw Error("圆弧半径和弧长必须大于零。");
  const startAngle=Math.atan2(points[1]![1]-points[0]![1],points[1]![0]-points[0]![0]);
  let endAngle=Math.atan2(points[2]![1]-points[0]![1],points[2]![0]-points[0]![0]);while(endAngle<=startAngle)endAngle+=Math.PI*2;
  if(endAngle-startAngle>=Math.PI*2-1e-6)throw Error("请使用圆工具绘制完整圆。");
  return {...common,type:"arc",center:[...points[0]!],radiusMm,startAngle,endAngle,layer:"USER_DRAWING",category:"geometry"} as CadArcEntity;
}

function moved(entity:CadEntity,dx:number,dy:number):CadEntity {
  const move=(p:[number,number]):[number,number]=>[p[0]+dx,p[1]+dy];
  const changed=entity.source==="observed"?{source:"inferred" as const,confidence:"mixed" as const,layer:"INFERRED_WALL" as const}:{};
  const metadata={...entity.metadata,operation:entity.source==="observed"?CAD_DIRECT_EDIT:entity.metadata?.operation??CAD_DIRECT_EDIT,...(entity.source==="observed"?{originalEntityId:entity.id}:{})};
  if(entity.type==="line")return {...entity,...changed,metadata,start:move(entity.start),end:move(entity.end)};
  if(entity.type==="polyline")return {...entity,...changed,metadata,points:entity.points.map(move)};
  if(entity.type==="text"||entity.type==="point")return {...entity,...changed,metadata,position:move(entity.position)};
  return {...entity,...changed,metadata,center:move(entity.center)};
}

function isAttachedConnection(entity:CadEntity,id:string):boolean {
  return (entity.metadata?.operation===CAD_MANUAL_CONNECTION||entity.metadata?.operation===CAD_AUTO_CONNECTION)&&(entity.metadata?.startEntityId===id||entity.metadata?.endEntityId===id);
}

export function moveCadGeometry(model:DrawingModel,id:string,dx:number,dy:number):DrawingModel {
  const original=model.entities.find(entity=>entity.id===id);if(!original||!canEditCadEntity(original))throw Error("该图元不可编辑。");
  const entities=model.entities.map(entity=>{
    if(entity.id===id)return moved(original,dx,dy);
    if(!isAttachedConnection(entity,id))return entity;
    const moveStart=entity.metadata?.startEntityId===id,moveEnd=entity.metadata?.endEntityId===id;
    if(entity.type==="line"){
      return {...entity,start:moveStart?[entity.start[0]+dx,entity.start[1]+dy] as [number,number]:entity.start,end:moveEnd?[entity.end[0]+dx,entity.end[1]+dy] as [number,number]:entity.end};
    }
    if(entity.type==="polyline"&&entity.points.length>=2){
      const points=entity.points.map(p=>[...p] as [number,number]);
      if(points.length===3){
        const p0=points[0]!,corner=points[1]!,p2=points[2]!;
        if(moveStart){if(Math.abs(corner[0]-p0[0])<1e-3)corner[0]+=dx;else corner[1]+=dy;p0[0]+=dx;p0[1]+=dy;}
        if(moveEnd){if(Math.abs(corner[0]-p2[0])<1e-3)corner[0]+=dx;else corner[1]+=dy;p2[0]+=dx;p2[1]+=dy;}
      }else{
        if(moveStart){points[0]=[points[0]![0]+dx,points[0]![1]+dy];}
        if(moveEnd){const last=points.at(-1)!;points[points.length-1]=[last[0]+dx,last[1]+dy];}
      }
      return {...entity,points};
    }
    if(entity.type==="arc"){
      const startPt:[number,number]=[entity.center[0]+Math.cos(entity.startAngle)*entity.radiusMm,entity.center[1]+Math.sin(entity.startAngle)*entity.radiusMm];
      const endPt:[number,number]=[entity.center[0]+Math.cos(entity.endAngle)*entity.radiusMm,entity.center[1]+Math.sin(entity.endAngle)*entity.radiusMm];
      const origPts=original.type==="line"?[original.start,original.end]:original.type==="polyline"&&original.points.length?[original.points[0]!,original.points.at(-1)!]:[];
      const onMoved=(pt:[number,number])=>origPts.some(op=>distance(op,pt)<1);
      const nextStart:[number,number]=onMoved(startPt)?[startPt[0]+dx,startPt[1]+dy]:startPt;
      const nextEnd:[number,number]=onMoved(endPt)?[endPt[0]+dx,endPt[1]+dy]:endPt;
      const style=(entity.metadata?.connectionStyle as CadConnectionStyle|undefined)??"arc";
      const rebuilt=previewCadConnection(model,{point:nextStart,entityId:String(entity.metadata?.startEntityId)},{point:nextEnd,entityId:String(entity.metadata?.endEntityId)},style);
      return rebuilt?{...rebuilt,id:entity.id}:entity;
    }
    return entity;
  });
  return withCadEdits(model,entities);
}

export function deleteCadGeometry(model:DrawingModel,ids:string[]):DrawingModel {
  const removed=new Set(ids);if([...removed].some(id=>!model.entities.some(entity=>entity.id===id&&canEditCadEntity(entity))))throw Error("选择中包含不可删除的图元。");
  return withCadEdits(model,model.entities.filter(entity=>!removed.has(entity.id)&&![...removed].some(id=>isAttachedConnection(entity,id))));
}

export function withCadEdits(model:DrawingModel,entities:CadEntity[]):DrawingModel {
  const base={...model,entities},manualEdits=entities.filter(entity=>entity.metadata?.operation===CAD_DIRECT_DRAW||entity.metadata?.operation===CAD_DIRECT_EDIT).length;
  const warnings=model.warnings.filter(w=>w.code!=="MANUAL_CAD_EDIT");
  if(manualEdits)warnings.push({code:"MANUAL_CAD_EDIT",severity:"warning",message:`图纸含 ${manualEdits} 个人工绘制或移动图元；导出前请核对这些几何。`,relatedLayer:"USER_DRAWING"});
  const content=entities.filter(e=>e.layer!=="FRAME"&&e.layer!=="TITLE_BLOCK"),bounds=cadEntityBounds(content);
  return {...base,warnings,modelBoundsMm:bounds,layoutBoundsMm:{min:model.layoutBoundsMm.min.map((v,i)=>Math.min(v,bounds.min[i]!)) as [number,number],max:model.layoutBoundsMm.max.map((v,i)=>Math.max(v,bounds.max[i]!)) as [number,number]},parameters:Object.assign({},model.parameters,{openEndpoints:openCadEndpoints(base).length}),statistics:{...model.statistics,observedWallEntities:entities.filter(e=>e.layer==="OBSERVED_WALL"&&e.category==="wall").length,inferredWallEntities:entities.filter(e=>e.layer==="INFERRED_WALL"&&e.category==="wall").length}};
}
