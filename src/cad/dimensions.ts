import type { CadEntity, DrawingModel } from './model';
export type CadPoint2 = [number, number];
export interface CadDimension {
  id: string;
  kind: 'aligned' | 'horizontal' | 'vertical';
  start: CadPoint2;
  end: CadPoint2;
  linePoint: CadPoint2;
  textHeightMm: number;
  roundingMm: number;
  source: 'derived' | 'manual';
}
export function dimensionMeasurement(d: CadDimension): number {
  return d.kind === 'horizontal' ? Math.abs(d.end[0]-d.start[0]) : d.kind === 'vertical' ? Math.abs(d.end[1]-d.start[1]) : Math.hypot(d.end[0]-d.start[0],d.end[1]-d.start[1]);
}
export function assertDimension(d: CadDimension): void {
  if (!d || typeof d.id !== 'string' || !d.id || !['aligned','horizontal','vertical'].includes(d.kind) || !['manual','derived'].includes(d.source) || ![d.start,d.end,d.linePoint].every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)) || !Number.isFinite(d.textHeightMm) || d.textHeightMm<=0 || !Number.isFinite(d.roundingMm) || d.roundingMm<1e-6 || dimensionMeasurement(d)<1e-6) throw Error('尺寸定义无效或尺寸为零。');
}
export function dimensionGeometry(d: CadDimension) {
  assertDimension(d);
  const length=dimensionMeasurement(d);
  const angle=d.kind==='horizontal'?0:d.kind==='vertical'?Math.PI/2:Math.atan2(d.end[1]-d.start[1],d.end[0]-d.start[0]);
  const u:CadPoint2=[Math.cos(angle),Math.sin(angle)],n:CadPoint2=[-u[1],u[0]];
  const project=(p:CadPoint2):CadPoint2=>{const t=(d.linePoint[0]-p[0])*n[0]+(d.linePoint[1]-p[1])*n[1];return [p[0]+n[0]*t,p[1]+n[1]*t];};
  const a=project(d.start),b=project(d.end);
  const textPoint:CadPoint2=[(a[0]+b[0])/2+n[0]*d.textHeightMm*.7,(a[1]+b[1])/2+n[1]*d.textHeightMm*.7];
  const text=String(Number((Math.round(length/d.roundingMm)*d.roundingMm).toFixed(6)));
  return {a,b,u,n,textPoint,text,angle,length};
}
/** 同一份定义生成预览和 DXF 显示块；文字不允许独立覆盖真实尺寸。 */
export function dimensionEntities(d:CadDimension):CadEntity[] {
  const g=dimensionGeometry(d),entities:CadEntity[]=[];
  const common={layer:'DIM' as const,category:'dimension' as const,source:d.source,confidence:'mixed' as const,metadata:{dimensionId:d.id}};
  const line=(start:CadPoint2,end:CadPoint2)=>entities.push({...common,id:`${d.id}:${entities.length}`,type:'line',start,end});
  line(d.start,g.a);line(d.end,g.b);line(g.a,g.b);
  // 建筑斜短划线；大小按图纸标注高度，避免尺寸线之间出现假连接。
  const tick=d.textHeightMm*.35;
  for(const p of [g.a,g.b])line([p[0]-(g.u[0]+g.n[0])*tick,p[1]-(g.u[1]+g.n[1])*tick],[p[0]+(g.u[0]+g.n[0])*tick,p[1]+(g.u[1]+g.n[1])*tick]);
  let rotation=g.angle*180/Math.PI;if(rotation>90)rotation-=180;if(rotation<-90)rotation+=180;
  entities.push({...common,id:`${d.id}:text`,type:'text',text:g.text,position:g.textPoint,heightMm:d.textHeightMm,rotationDegrees:rotation});
  return entities;
}
export function appendDimension(model:DrawingModel,d:CadDimension):void {
  assertDimension(d);model.dimensions??=[];
  if(model.dimensions.some(item=>item.id===d.id))throw Error('尺寸编号重复。');
  model.dimensions.push(d);model.entities.push(...dimensionEntities(d));
}
export function validateDimensions(model:DrawingModel):string[] {
  const errors:string[]=[],ids=new Set<string>();
  if(model.dimensions!==undefined&&!Array.isArray(model.dimensions))return ['尺寸集合无效。'];
  for(const d of model.dimensions??[])try{
    assertDimension(d);if(ids.has(d.id))throw Error('尺寸编号重复。');ids.add(d.id);
    for(const expected of dimensionEntities(d)){
      const actual=model.entities.find(e=>e.id===expected.id);
      const signature=(e:CadEntity)=>JSON.stringify([e.id,e.type,e.layer,e.category,e.source,e.confidence,e.metadata?.dimensionId,e.type==='line'?[e.start,e.end]:e.type==='text'?[e.text,e.position,e.heightMm,e.rotationDegrees]:null]);
      if(!actual||signature(actual)!==signature(expected))throw Error('尺寸图元与定义不一致。');
    }
  }catch(e){errors.push(e instanceof Error?e.message:String(e));}
  for(const e of model.entities)if(e.metadata?.dimensionId&&!ids.has(String(e.metadata.dimensionId)))errors.push('尺寸图元缺少定义。');
  return errors;
}
/** 只吸附当前可见建筑线端点；屏幕容差由调用者换算，避免毫米网格伪装为实测点。 */
export function snapCadEndpoint(model:DrawingModel,point:CadPoint2,toleranceMm:number,visible?:(layer:string)=>boolean):{point:CadPoint2;entityId:string}|undefined {
  let best:{point:CadPoint2;entityId:string;distance:number}|undefined;
  for(const e of model.entities){
    if(e.category==='dimension'||e.category==='frame'||e.layer==='TITLE_BLOCK'||(visible&&!visible(e.layer)))continue;
    const points=e.type==='line'?[e.start,e.end]:e.type==='polyline'?e.points:[];
    for(const p of points){const distance=Math.hypot(p[0]-point[0],p[1]-point[1]);if(distance<=toleranceMm&&(!best||distance<best.distance))best={point:[...p],entityId:e.id,distance};}
  }
  return best&&{point:best.point,entityId:best.entityId};
}
export function removeDimension(model:DrawingModel,id:string):DrawingModel {
  return {...model,dimensions:model.dimensions?.filter(d=>d.id!==id),entities:model.entities.filter(e=>e.metadata?.dimensionId!==id)};
}
