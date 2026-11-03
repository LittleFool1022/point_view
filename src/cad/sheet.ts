import {dimensionEntities} from "./dimensions";
import {PAPER_SIZE_MM,refreshCadTitle,validateDrawingModel,type DrawingModel,type CadBoundsMm,type CadEntity} from './model';
export interface CadSheet {
  paperSize:string; widthMm:number; heightMm:number; denominator:number;
  windowMm:CadBoundsMm; outsideEntityIds:string[]; titleOverlapEntityIds:string[];
}
const points=(e:CadEntity):[number,number][]=>e.type==='line'?[e.start,e.end]:e.type==='polyline'?e.points:[e.position];
/** 图幅取自实际图框，禁止把超出页面的图纸按“适合页面”静默缩小。 */
export function cadSheet(model:DrawingModel):CadSheet {
  const validation=validateDrawingModel(model);if(!validation.valid)throw Error(validation.errors.map(e=>e.message).join('；'));
  const size=PAPER_SIZE_MM[model.paperSize],match=/^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(model.scale);
  if(!size||!match||Number(match[1])<=0||model.titleBlock.scale!==model.scale||model.titleBlock.paperSize!==model.paperSize)throw Error('图幅或比例不一致，请更新图纸。');
  const denominator=Number(match[1]);
  const frames=model.entities.filter(e=>e.layer==='FRAME'&&e.type==='polyline');
  const windows=frames.map(e=>{const p=points(e);return {min:[Math.min(...p.map(v=>v[0])),Math.min(...p.map(v=>v[1]))] as [number,number],max:[Math.max(...p.map(v=>v[0])),Math.max(...p.map(v=>v[1]))] as [number,number]};});
  const windowMm=windows.find(b=>Math.abs(b.max[0]-b.min[0]-size[0]*denominator)<1e-4&&Math.abs(b.max[1]-b.min[1]-size[1]*denominator)<1e-4);
  if(!windowMm)throw Error('图框与图幅比例不匹配，请更新图纸。');
  const enabled=new Set(model.layers.filter(l=>l.export).map(l=>l.name));
  const outsideEntityIds=model.entities.filter(e=>enabled.has(e.layer)&&e.layer!=='FRAME'&&e.layer!=='TITLE_BLOCK'&&points(e).some(p=>p[0]<windowMm.min[0]-1e-4||p[0]>windowMm.max[0]+1e-4||p[1]<windowMm.min[1]-1e-4||p[1]>windowMm.max[1]+1e-4)).map(e=>e.id);
  const title=model.entities.find(e=>e.layer==='TITLE_BLOCK'&&e.type==='polyline'),tp=title?points(title):[];
  const tx1=Math.min(...tp.map(p=>p[0])),tx2=Math.max(...tp.map(p=>p[0])),ty1=Math.min(...tp.map(p=>p[1])),ty2=Math.max(...tp.map(p=>p[1]));
  const titleOverlapEntityIds=tp.length?model.entities.filter(e=>enabled.has(e.layer)&&e.layer!=='FRAME'&&e.layer!=='TITLE_BLOCK'&&(()=>{const p=points(e);return Math.min(...p.map(v=>v[0]))<tx2-1e-4&&Math.max(...p.map(v=>v[0]))>tx1+1e-4&&Math.min(...p.map(v=>v[1]))<ty2-1e-4&&Math.max(...p.map(v=>v[1]))>ty1+1e-4;})()).map(e=>e.id):[];
  return {paperSize:model.paperSize,widthMm:size[0],heightMm:size[1],denominator,windowMm,outsideEntityIds,titleOverlapEntityIds};
}
const xml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
/** 输出毫米画布与矢量实体；浏览器缩放与屏幕采样不参与打印。 */
export function createCadSheet(model:DrawingModel):{sheet:CadSheet;svg:string;html:string} {
  const sheet=cadSheet(model),{windowMm:b,denominator:s,widthMm:w,heightMm:h}=sheet;
  if(sheet.outsideEntityIds.length)throw Error(`${sheet.outsideEntityIds.length} 个图元超出图框，请扩大图幅或调整出图比例。`);
  if(sheet.titleOverlapEntityIds.length)throw Error(`${sheet.titleOverlapEntityIds.length} 个图元与标题栏重叠，请扩大图幅或调整出图比例。`);
  const layers=new Map(model.layers.filter(l=>l.export).map(l=>[l.name,l]));
  const entities=model.entities.filter(e=>layers.has(e.layer)).map(e=>{
    const layer=layers.get(e.layer)!,dash=layer.lineType==='DASHED'?` stroke-dasharray="${3*s} ${1.5*s}"`:layer.lineType==='CENTER'?` stroke-dasharray="${6*s} ${1.5*s} ${s} ${1.5*s}"`:'';
    const common=`data-entity-id="${xml(e.id)}" stroke="#18212a" stroke-width="${layer.lineWidthMm*s}" fill="none"${dash}`;
    if(e.type==='line')return `<line ${common} x1="${e.start[0]}" y1="${-e.start[1]}" x2="${e.end[0]}" y2="${-e.end[1]}"/>`;
    if(e.type==='polyline')return `<${e.closed?'polygon':'polyline'} ${common} points="${e.points.map(p=>`${p[0]},${-p[1]}`).join(' ')}"/>`;
    if(e.type==='point')return `<circle data-entity-id="${xml(e.id)}" cx="${e.position[0]}" cy="${-e.position[1]}" r="${.15*s}" fill="#555"/>`;
    return `<text data-entity-id="${xml(e.id)}" x="${e.position[0]}" y="${-e.position[1]}" font-size="${e.heightMm}"${e.metadata?.dimensionId?' text-anchor="middle"':''} fill="#18212a" transform="rotate(${-(e.rotationDegrees??0)} ${e.position[0]} ${-e.position[1]})">${xml(e.text)}</text>`;
  }).join('\n');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${b.min[0]} ${-b.max[1]} ${w*s} ${h*s}" font-family="Microsoft YaHei,Noto Sans CJK SC,sans-serif"><title>${xml(model.titleBlock.drawingName)}</title><rect x="${b.min[0]}" y="${-b.max[1]}" width="${w*s}" height="${h*s}" fill="white"/>${entities}</svg>`;
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${xml(model.titleBlock.drawingName)}</title><style>@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0;padding:0;width:${w}mm;height:${h}mm}svg{display:block;width:${w}mm;height:${h}mm}*{print-color-adjust:exact}</style></head><body>${svg}</body></html>`;
  return {sheet,svg,html};
}
/** 图幅、比例、取整仅改表现；完整几何和人工尺寸定义点保持原坐标。 */
export function restyleCadDrawing(model:DrawingModel,settings:{paperSize?:DrawingModel['paperSize'];scale?:string;roundingMm?:number}):DrawingModel {
  const original=cadSheet(model),next=structuredClone(model),paperSize=settings.paperSize??model.paperSize,scale=settings.scale??model.scale,roundingMm=settings.roundingMm??model.parameters.roundingMm;
  const match=/^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(scale),paper=PAPER_SIZE_MM[paperSize];
  if(!match||!paper||Number(match[1])<=0||!Number.isFinite(roundingMm)||roundingMm<1e-6)throw Error('图幅、比例或取整值无效。');
  if(roundingMm!==model.parameters.roundingMm&&model.entities.some(e=>e.category==='dimension'&&!e.metadata?.dimensionId))throw Error('旧图缺少尺寸定义，修改取整前需重新生成图纸。');
  const s=Number(match[1]),ratio=s/original.denominator,w=paper[0]*s,h=paper[1]*s,margin=10*s;
  const content=next.entities.filter(e=>!['FRAME','TITLE_BLOCK'].includes(e.layer)).flatMap(points);
  const cx=content.length?(Math.min(...content.map(p=>p[0]))+Math.max(...content.map(p=>p[0])))/2:0,cy=content.length?(Math.min(...content.map(p=>p[1]))+Math.max(...content.map(p=>p[1])))/2:0;
  const min:[number,number]=[cx-w/2,cy-h/2-25*s],max:[number,number]=[cx+w/2,cy+h/2-25*s];
  const rectangle=(a:[number,number],b:[number,number]):[number,number][]=>[[a[0],a[1]],[b[0],a[1]],[b[0],b[1]],[a[0],b[1]]];
  const title=next.entities.find(e=>e.layer==='TITLE_BLOCK'&&e.type==='polyline');
  const titlePoints=title?points(title):[];
  const tx=titlePoints.length?Math.min(...titlePoints.map(p=>p[0])):0,ty=titlePoints.length?Math.min(...titlePoints.map(p=>p[1])):0;
  const nx=max[0]-margin-180*s,ny=min[1]+margin;
  for(const e of next.entities){
    if(e.layer==='FRAME'&&e.type==='polyline'){
      const p=points(e),outer=Math.abs(Math.min(...p.map(v=>v[0]))-original.windowMm.min[0])<1e-4;
      e.points=outer?rectangle(min,max):rectangle([min[0]+margin,min[1]+margin],[max[0]-margin,max[1]-margin]);
    }else if(e.layer==='TITLE_BLOCK'){
      const map=(p:[number,number]):[number,number]=>[nx+(p[0]-tx)*ratio,ny+(p[1]-ty)*ratio];
      if(e.type==='line'){e.start=map(e.start);e.end=map(e.end);}else if(e.type==='polyline')e.points=e.points.map(map);else {e.position=map(e.position);if(e.type==='text'){e.heightMm*=ratio;if(e.text.startsWith('图号 '))e.text=`图号 ${next.titleBlock.drawingNumber}  比例 ${scale}  图幅 ${paperSize}`;}}
    }else if(e.type==='text'&&!e.metadata?.dimensionId)e.heightMm*=ratio;
  }
  next.scale=scale;next.paperSize=paperSize;next.titleBlock.scale=scale;next.titleBlock.paperSize=paperSize;
  next.parameters.roundingMm=roundingMm;next.accuracy.roundingMm=roundingMm;
  next.titleBlock.accuracyNote=next.titleBlock.accuracyNote.replace(/取整\s*[\d.]+\s*mm/,`取整 ${roundingMm} mm`);
  next.layoutBoundsMm={min,max};
  // 尺寸定义点和尺寸线位置不随图幅或比例移动，文本按纸面高度缩放。
  if(next.dimensions?.length){
    next.entities=next.entities.filter(e=>!e.metadata?.dimensionId);
    next.dimensions=next.dimensions.map(d=>({...d,textHeightMm:d.textHeightMm*ratio,roundingMm}));
    for(const d of next.dimensions)next.entities.push(...dimensionEntities(d));
  }
  refreshCadTitle(next);
  return next;
}
