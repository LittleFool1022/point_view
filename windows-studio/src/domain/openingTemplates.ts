import type { Opening } from './building';
export type OpeningTemplateId = 'single-door' | 'double-door' | 'fixed-window' | 'double-window';
export interface OpeningDesign { template: OpeningTemplateId; frameWidthM: number }
export const OPENING_TEMPLATES = [
  { id:'single-door', name:'单扇平板门', kind:'door', widthM:.9, heightM:2.1, sillM:0 },
  { id:'double-door', name:'双扇平板门', kind:'door', widthM:1.6, heightM:2.1, sillM:0 },
  { id:'fixed-window', name:'固定玻璃窗', kind:'window', widthM:1.2, heightM:1.2, sillM:.9 },
  { id:'double-window', name:'双分格玻璃窗', kind:'window', widthM:1.8, heightM:1.2, sillM:.9 },
] as const;
export const openingTemplate = (o: Opening) => OPENING_TEMPLATES.find(t=>t.id===o.design?.template);
export function validOpeningDesign(o: Opening) {
  if(o.design===undefined)return true; // 旧工程继续使用原来的通用填充体。
  const t=openingTemplate(o),f=o.design?.frameWidthM;
  return !!t && t.kind===o.kind && Number.isFinite(f) && f>0 && f<=.15 && f<Math.min(o.widthM,o.heightM)/4;
}
export interface OpeningPiece { x:number; z:number; width:number; height:number; depth:number; material:'frame'|'panel'|'glass' }
/** 洞口局部坐标，X从左边起、Z从洞底起；BIM、效果图及IFC复用闭合状态实体。 */
export function openingPieces(o: Opening, thicknessM:number): OpeningPiece[] {
  const t=openingTemplate(o),depth=Math.min(thicknessM,.12);
  if(!t)return [{x:o.widthM/2,z:o.heightM/2,width:o.widthM,height:o.heightM,depth:Math.min(thicknessM,.06),material:o.kind==='door'?'panel':'glass'}];
  const f=o.design!.frameWidthM,w=o.widthM,h=o.heightM,window=o.kind==='window',bottom=window?f:0;
  const pieces:OpeningPiece[]=[
    {x:f/2,z:h/2,width:f,height:h,depth,material:'frame'},
    {x:w-f/2,z:h/2,width:f,height:h,depth,material:'frame'},
    {x:w/2,z:h-f/2,width:w-2*f,height:f,depth,material:'frame'},
  ];
  if(window)pieces.push({x:w/2,z:f/2,width:w-2*f,height:f,depth,material:'frame'});
  const count=t.id==='double-door'||t.id==='double-window'?2:1;
  if(count===2&&window)pieces.push({x:w/2,z:(bottom+h-f)/2,width:f,height:h-f-bottom,depth,material:'frame'});
  const divider=count===2?(window?f:.004):0,clear=(w-2*f-divider)/count;
  for(let i=0;i<count;i++)pieces.push({x:f+clear/2+i*(clear+divider),z:(bottom+h-f)/2,width:clear,height:h-f-bottom,depth:Math.min(thicknessM,window?.012:.04),material:window?'glass':'panel'});
  return pieces;
}

/** 以洞口中高剖切，输出闭合门窗的平面矩形线段。 */
export function openingPlanSegments(o:Opening,thicknessM:number): Array<[[number,number],[number,number]]> {
  return openingPieces(o,thicknessM).filter(p=>p.z-p.height/2<o.heightM/2&&p.z+p.height/2>o.heightM/2).flatMap(p=>{
    const a=p.x-p.width/2,b=p.x+p.width/2,d=p.depth/2;
    return [[[a,-d],[b,-d]],[[b,-d],[b,d]],[[b,d],[a,d]],[[a,d],[a,-d]]] as Array<[[number,number],[number,number]]>;
  });
}
