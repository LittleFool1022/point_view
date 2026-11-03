import {cadSheet} from "./sheet";
import { dimensionGeometry, dimensionEntities, type CadDimension } from "./dimensions";
import { validateDrawingModel, type CadEntity, type DrawingModel } from "./model";
const pair = (code: number, value: string | number) => `${code}\n${value}`;
const tags = (...parts: Array<string | number>) => parts.join("\n");
function encodeDxfText(value: string): string {
  return [...value.replace(/[\r\n]+/g, " ").slice(0, 240)].map(character => {
    const code=character.codePointAt(0)!;
    if(character==="\\")return "\\\\";
    if(code>=0x20&&code<=0x7e)return character;
    return `\\U+${code.toString(16).toUpperCase().padStart(4,"0")}`;
  }).join("");
}
interface DimensionBlock { dimension:CadDimension; name:string; record:string; style:string }
interface Handles { dimensions:DimensionBlock[]; textStyle:string; next():string; modelRecord:string; paperRecord:string; root:string; groups:string; layouts:string; modelLayout:string; paperLayout:string }
function entityToDxf(entity:CadEntity,h:Handles):string {
  const type={line:"LINE",polyline:"LWPOLYLINE",text:"TEXT",point:"POINT"}[entity.type];
  const common=tags(0,type,5,h.next(),330,h.modelRecord,100,"AcDbEntity",8,entity.layer);
  // XDATA必须位于实体自身数据之后，否则严格读取器会把坐标当成扩展数据。
  const xdata=tags(1001,"POINTVIEW",1000,entity.id);
  let content:string;
  if(entity.type==="line")content=tags(100,"AcDbLine",10,entity.start[0],20,entity.start[1],30,0,11,entity.end[0],21,entity.end[1],31,0);
  else if(entity.type==="polyline")content=[tags(100,"AcDbPolyline",90,entity.points.length,70,entity.closed?1:0),...entity.points.map(([x,y])=>tags(10,x,20,y))].join("\n");
  else if(entity.type==="text")content=tags(100,"AcDbText",10,entity.position[0],20,entity.position[1],30,0,40,entity.heightMm,1,encodeDxfText(entity.text),7,"STANDARD",50,entity.rotationDegrees??0,...(entity.metadata?.dimensionId?[72,1,11,entity.position[0],21,entity.position[1],31,0]:[]),100,"AcDbText",73,0);
  else content=tags(100,"AcDbPoint",10,entity.position[0],20,entity.position[1],30,0);
  return [common,content,xdata].join("\n");
}
function tablesSection(model:DrawingModel,h:Handles):string {
  const tables:string[]=[];
  function table(name:string,records:(owner:string)=>string[]){
    const handle=h.next(),items=records(handle);
    tables.push(tags(0,"TABLE",2,name,5,handle,330,"0",100,"AcDbSymbolTable",70,items.length),...items,tags(0,"ENDTAB"));
  }
  const record=(name:string,owner:string,subclass:string,...body:Array<string|number>)=>tags(0,name,5,h.next(),330,owner,100,"AcDbSymbolTableRecord",100,subclass,...body);
  table("LTYPE",owner=>[
    record("LTYPE",owner,"AcDbLinetypeTableRecord",2,"CONTINUOUS",70,0,3,"Solid line",72,65,73,0,40,0),
    record("LTYPE",owner,"AcDbLinetypeTableRecord",2,"DASHED",70,0,3,"Dashed __ __",72,65,73,2,40,18,49,12,74,0,49,-6,74,0),
    record("LTYPE",owner,"AcDbLinetypeTableRecord",2,"CENTER",70,0,3,"Center ____ _ ____",72,65,73,4,40,40,49,25,74,0,49,-5,74,0,49,5,74,0,49,-5,74,0),
  ]);
  table("LAYER",owner=>[
    record("LAYER",owner,"AcDbLayerTableRecord",2,"0",70,0,62,7,6,"CONTINUOUS",370,25),
    record("LAYER",owner,"AcDbLayerTableRecord",2,"PV_VIEWPORTS",70,0,62,8,6,"CONTINUOUS",290,0),
    ...model.layers.filter(l=>l.export).map(l=>record("LAYER",owner,"AcDbLayerTableRecord",2,l.name,70,0,62,l.aciColor,6,l.lineType,370,Math.round(l.lineWidthMm*100))),
  ]);
  table("STYLE",owner=>[tags(0,"STYLE",5,h.textStyle,330,owner,100,"AcDbSymbolTableRecord",100,"AcDbTextStyleTableRecord",2,"STANDARD",70,0,40,0,41,1,50,0,71,0,42,2.5,3,"Arial",4,"")]);
  table("DIMSTYLE",owner=>h.dimensions.map(({dimension:d,style})=>tags(0,"DIMSTYLE",105,h.next(),330,owner,100,"AcDbSymbolTableRecord",100,"AcDbDimStyleTableRecord",2,style,70,0,40,1,41,d.textHeightMm,45,d.roundingMm,140,d.textHeightMm,144,1,147,d.textHeightMm*.7,77,1,78,8,271,6,277,2,284,8,340,h.textStyle)));
  table("APPID",owner=>["ACAD","POINTVIEW"].map(name=>record("APPID",owner,"AcDbRegAppTableRecord",2,name,70,0)));
  table("BLOCK_RECORD",owner=>[
    ...h.dimensions.map(d=>tags(0,"BLOCK_RECORD",5,d.record,330,owner,100,"AcDbSymbolTableRecord",100,"AcDbBlockTableRecord",2,d.name,70,1)),
    tags(0,"BLOCK_RECORD",5,h.modelRecord,330,owner,100,"AcDbSymbolTableRecord",100,"AcDbBlockTableRecord",2,"*Model_Space",340,h.modelLayout),
    tags(0,"BLOCK_RECORD",5,h.paperRecord,330,owner,100,"AcDbSymbolTableRecord",100,"AcDbBlockTableRecord",2,"*Paper_Space",340,h.paperLayout),
  ]);
  return [tags(0,"SECTION",2,"TABLES"),...tables,tags(0,"ENDSEC")].join("\n");
}
function blocksSection(h:Handles):string {
  const blocks=([ ["*Model_Space",h.modelRecord],["*Paper_Space",h.paperRecord] ] as const).flatMap(([name,owner])=>[
    tags(0,"BLOCK",5,h.next(),330,owner,100,"AcDbEntity",8,"0",100,"AcDbBlockBegin",2,name,70,0,10,0,20,0,30,0,3,name,1,""),
    tags(0,"ENDBLK",5,h.next(),330,owner,100,"AcDbEntity",8,"0",100,"AcDbBlockEnd"),
  ]);
  for(const d of h.dimensions){
    blocks.push(tags(0,"BLOCK",5,h.next(),330,d.record,100,"AcDbEntity",8,"DIM",100,"AcDbBlockBegin",2,d.name,70,1,10,0,20,0,30,0,3,d.name,1,""));
    blocks.push(...dimensionEntities(d.dimension).map(e=>entityToDxf(e,{...h,modelRecord:d.record})));
    blocks.push(tags(0,"ENDBLK",5,h.next(),330,d.record,100,"AcDbEntity",8,"DIM",100,"AcDbBlockEnd"));
  }
  return [tags(0,"SECTION",2,"BLOCKS"),...blocks,tags(0,"ENDSEC")].join("\n");
}
function dimensionToDxf(block:DimensionBlock,h:Handles):string {
  const d=block.dimension,g=dimensionGeometry(d);
  const common=tags(0,"DIMENSION",5,h.next(),330,h.modelRecord,100,"AcDbEntity",8,"DIM",100,"AcDbDimension",2,block.name,10,g.b[0],20,g.b[1],30,0,11,g.textPoint[0],21,g.textPoint[1],31,0,70,(d.kind==='aligned'?1:0)+32,71,5,42,g.length,1,"<>",3,block.style);
  const definition=tags(100,"AcDbAlignedDimension",13,d.start[0],23,d.start[1],33,0,14,d.end[0],24,d.end[1],34,0);
  return [common,definition,...(d.kind==='aligned'?[]:[tags(50,d.kind==='horizontal'?0:90,100,"AcDbRotatedDimension")]),tags(1001,"POINTVIEW",1000,d.id)].join("\n");
}
function paperViewport(model:DrawingModel,h:Handles):string {
  const s=cadSheet(model),b=s.windowMm;
  return tags(0,"VIEWPORT",5,h.next(),330,h.paperRecord,100,"AcDbEntity",8,"PV_VIEWPORTS",67,1,410,"Layout1",100,"AcDbViewport",10,s.widthMm/2,20,s.heightMm/2,30,0,40,s.widthMm,41,s.heightMm,68,1,69,2,12,(b.min[0]+b.max[0])/2,22,(b.min[1]+b.max[1])/2,16,0,26,0,36,1,17,0,27,0,37,0,45,s.heightMm*s.denominator,51,0,90,49152,281,0);
}
function objectsSection(h:Handles,model:DrawingModel):string {
  const sheet=cadSheet(model),w=sheet.widthMm,height=sheet.heightMm,b=sheet.windowMm;
  const dictionary=(handle:string,owner:string,...entries:Array<string|number>)=>tags(0,"DICTIONARY",5,handle,330,owner,100,"AcDbDictionary",281,1,...entries);
  const layout=(name:string,handle:string,block:string,order:number)=>tags(
    0,"LAYOUT",5,handle,330,h.layouts,100,"AcDbPlotSettings",1,"",2,"",4,"",40,0,41,0,42,0,43,0,44,w,45,height,46,0,47,0,48,order===0?b.min[0]:0,49,order===0?b.min[1]:0,140,order===0?b.max[0]:w,141,order===0?b.max[1]:height,142,1,143,order===0?sheet.denominator:1,70,128+(order===0?1024:0),72,1,73,0,74,4,7,"",75,16,147,1,
    100,"AcDbLayout",1,name,70,1,71,order,10,0,20,0,11,w,21,height,12,0,22,0,32,0,14,0,24,0,34,0,15,0,25,0,35,0,146,0,13,0,23,0,33,0,16,1,26,0,36,0,17,0,27,1,37,0,76,order===0?0:1,330,block,
  );
  return [tags(0,"SECTION",2,"OBJECTS"),dictionary(h.root,"0",3,"ACAD_GROUP",350,h.groups,3,"ACAD_LAYOUT",350,h.layouts),dictionary(h.groups,h.root),dictionary(h.layouts,h.root,3,"Model",350,h.modelLayout,3,"Layout1",350,h.paperLayout),layout("Model",h.modelLayout,h.modelRecord,0),layout("Layout1",h.paperLayout,h.paperRecord,1),tags(0,"ENDSEC")].join("\n");
}
/** 从统一DrawingModel序列化标准UTF-8 DXF，源几何与单位保持不变。 */
export function exportCadDxf(model:DrawingModel):Uint8Array {
  const validation=validateDrawingModel(model);
  if(!validation.valid)throw Error(`DXF 导出前校验失败：${validation.errors.map(e=>e.message).join("；")}`);
  let sequence=0x10;const next=()=>(sequence++).toString(16).toUpperCase();
  const h:Handles={next,modelRecord:next(),paperRecord:next(),root:next(),groups:next(),layouts:next(),modelLayout:next(),paperLayout:next(),textStyle:next(),dimensions:[]};
  const layers=new Set(model.layers.filter(l=>l.export).map(l=>l.name));
  h.dimensions=(layers.has("DIM")?model.dimensions??[]:[]).map((dimension,i)=>({dimension,name:`*D${i+1}`,record:next(),style:`PV_DIM_${i+1}`}));
  const tables=tablesSection(model,h),blocks=blocksSection(h),entities=[...model.entities.filter(e=>layers.has(e.layer)&&!e.metadata?.dimensionId).map(e=>entityToDxf(e,h)),...h.dimensions.map(d=>dimensionToDxf(d,h)),paperViewport(model,h)],objects=objectsSection(h,model);
  const span=Math.max(model.layoutBoundsMm.max[0]-model.layoutBoundsMm.min[0],model.layoutBoundsMm.max[1]-model.layoutBoundsMm.min[1],1);
  const content=[pair(999,`Point View DrawingModel ${model.schemaVersion} / ${model.drawingId}`),tags(0,"SECTION",2,"HEADER"),
    pair(9,"$ACADVER"),pair(1,"AC1021"),pair(9,"$DWGCODEPAGE"),pair(3,"ANSI_1252"),pair(9,"$HANDSEED"),pair(5,next()),
    pair(9,"$INSUNITS"),pair(70,4),pair(9,"$MEASUREMENT"),pair(70,1),pair(9,"$LUNITS"),pair(70,2),pair(9,"$LUPREC"),pair(70,6),pair(9,"$PDMODE"),pair(70,3),pair(9,"$PDSIZE"),pair(40,Math.max(span*.0005,10)),tags(0,"ENDSEC"),
    tables,blocks,tags(0,"SECTION",2,"ENTITIES"),...entities,tags(0,"ENDSEC"),objects,tags(0,"EOF"),"",
  ].join("\n");
  return new TextEncoder().encode(content.replace(/\n/g,"\r\n"));
}
