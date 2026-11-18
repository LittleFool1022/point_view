import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildingFromSegments, sourceStamp } from '../src/domain/buildingOps';
import { validateBuilding, buildingQuantities, wallPieces, type BuildingModel } from '../src/domain/building';
import { exportIfc } from '../src/domain/ifc';
import { checkIfc } from '../src/domain/ifcCheck';
import { encodeProject, decodeProject } from '../src/domain/project';
import { drawingFromBuilding } from '../src/domain/buildingDrawing';
import { demoRoom } from '../src/domain/demo';
const source={name:'实测房间.pcd',bytes:demoRoom(),units:'m' as const,synthetic:true};
export function buildingFixture():BuildingModel {
  const segments=[{a:[0,0],b:[8,0]},{a:[8,0],b:[8,6]},{a:[8,6],b:[0,6]},{a:[0,6],b:[0,0]}].map(s=>({...s,a:s.a as [number,number],b:s.b as [number,number],support:20,rmsM:.01}));
  const m=buildingFromSegments(source,{elevationM:1.5,heightM:3,thicknessM:.2,levelName:'测试一层'},segments);
  m.openings=[{id:'door',name:'入口门',kind:'door',wallId:m.walls[0]!.id,offsetM:1,widthM:.9,heightM:2.1,sillM:0,evidence:{...m.walls[0]!.evidence}},{id:'window',name:'南窗',kind:'window',wallId:m.walls[0]!.id,offsetM:4,widthM:1.2,heightM:1.2,sillM:.9,evidence:{...m.walls[0]!.evidence}}];return m;
}
it('闭合房间净面积、开洞净体积、拓扑异常和来源均可核对',()=>{
  const m=buildingFixture();expect(m.rooms).toHaveLength(1);expect(buildingQuantities(m).rooms[0]!.areaM2).toBeCloseTo(7.8*5.8,6);expect(m.sourceStamp).toBe(sourceStamp(source));
  const volume=wallPieces(m.walls[0]!,m.openings).reduce((s,p)=>s+p.width*p.height*.2,0);expect(volume).toBeCloseTo((8*3-.9*2.1-1.2*1.2)*.2,6);
  expect(validateBuilding(m).every(i=>i.code==='UNREVIEWED')).toBe(true);
  m.openings[1]!.offsetM=1.1;expect(validateBuilding(m).some(i=>i.code==='OPENING_OVERLAP')).toBe(true);
  m.rooms[0]!.boundaryM=[[0,0],[5,5],[0,5],[5,0]];expect(validateBuilding(m).some(i=>i.code==='ROOM_BOUNDARY')).toBe(true);
});
it('IFC4由独立引擎读取，门窗宿主、楼层、中文、净开洞几何正确',async()=>{
  const IFC=createRequire(import.meta.url)('web-ifc'),api=new IFC.IfcAPI();await api.Init();
  const m=buildingFixture(),bytes=exportIfc(m,'review');expect(()=>exportIfc(m,'delivery')).toThrow('复核');
  const check=checkIfc(api,bytes);expect(check.schema).toBe('IFC4');
  const id=api.OpenModel(bytes,{COORDINATE_TO_ORIGIN:false});
  try{
    const refs=(type:number)=>{const v=api.GetLineIDsWithType(id,type),out:number[]=[];for(let i=0;i<v.size();i++)out.push(v.get(i));return out;};
    expect(refs(IFC.IFCWALL)).toHaveLength(4);expect(refs(IFC.IFCDOOR)).toHaveLength(1);expect(refs(IFC.IFCWINDOW)).toHaveLength(1);expect(refs(IFC.IFCSPACE)).toHaveLength(1);expect(refs(IFC.IFCRELVOIDSELEMENT)).toHaveLength(2);expect(refs(IFC.IFCRELFILLSELEMENT)).toHaveLength(2);
    expect(api.GetLine(id,refs(IFC.IFCDOOR)[0]).Name.value).toBe('入口门');expect(api.GetLine(id,refs(IFC.IFCBUILDINGSTOREY)[0]).Elevation.value).toBe(1.5);
    const first=refs(IFC.IFCWALL)[0]!,mesh=api.GetFlatMesh(id,first);let volume=0;
    for(let i=0;i<mesh.geometries.size();i++){const flat=mesh.geometries.get(i),g=api.GetGeometry(id,flat.geometryExpressID),v=api.GetVertexArray(g.GetVertexData(),g.GetVertexDataSize()),indices=api.GetIndexArray(g.GetIndexData(),g.GetIndexDataSize());for(let j=0;j<indices.length;j+=3){const a=indices[j]*6,b=indices[j+1]*6,c=indices[j+2]*6;volume+=(v[a]*(v[b+1]*v[c+2]-v[b+2]*v[c+1])+v[a+1]*(v[b+2]*v[c]-v[b]*v[c+2])+v[a+2]*(v[b]*v[c+1]-v[b+1]*v[c]))/6;}g.delete();}
    expect(Math.abs(volume)).toBeCloseTo((8*3-.9*2.1-1.2*1.2)*.2,4);
  }finally{api.CloseModel(id);api.Dispose();}
});
it('建筑工程往返保持构件及来源，CAD来自同一修订；拒绝损坏建筑模型',async()=>{
  const m=buildingFixture(),archive=await encodeProject({source,building:m,annotations:[],settings:{},projection:'xy'}),restored=await decodeProject(archive.slice().buffer as ArrayBuffer);expect(restored.building).toEqual(m);
  const drawing=drawingFromBuilding(m,m.levels[0]!.id,{},7332);expect((drawing.parameters as any).buildingRevision).toBe(m.revision);expect(drawing.statistics.doorCount).toBe(1);expect(drawing.statistics.windowCount).toBe(1);expect(drawing.statistics.roomCount).toBe(1);
});

it('四种门窗模板共用实体几何、平面表达与工程持久化，拒绝损坏模板',async()=>{
  const {OPENING_TEMPLATES,openingPieces,openingPlanSegments}=await import('../src/domain/openingTemplates');
  for(const template of OPENING_TEMPLATES){
    const m=buildingFixture(),o={...m.openings[0]!,kind:template.kind,widthM:template.widthM,heightM:template.heightM,sillM:template.sillM,design:{template:template.id,frameWidthM:.05}};
    m.openings=[o];expect(validateBuilding(m).filter(i=>i.code!=='UNREVIEWED')).toEqual([]);
    const pieces=openingPieces(o,.2);expect(pieces.length).toBeGreaterThan(3);
    for(const p of pieces){expect(p.width).toBeGreaterThan(0);expect(p.height).toBeGreaterThan(0);expect(p.x-p.width/2).toBeGreaterThanOrEqual(-1e-9);expect(p.x+p.width/2).toBeLessThanOrEqual(o.widthM+1e-9);expect(p.z+p.height/2).toBeLessThanOrEqual(o.heightM+1e-9);}
    expect(pieces.filter(p=>p.material!=='frame')).toHaveLength(template.id.startsWith('double')?2:1);
    expect(openingPlanSegments(o,.2).length).toBeGreaterThanOrEqual(12);
    expect(buildingQuantities(m).openings[0]!.template).toBe(template.name);
    const archive=await encodeProject({source,building:m,annotations:[],settings:{},projection:'xy'});expect((await decodeProject(archive.slice().buffer as ArrayBuffer)).building!.openings[0]!.design).toEqual(o.design);
    o.design.frameWidthM=.5;expect(validateBuilding(m).some(i=>i.code==='OPENING_TEMPLATE')).toBe(true);
    o.design.frameWidthM=.05;o.kind=o.kind==='door'?'window':'door';expect(validateBuilding(m).some(i=>i.code==='OPENING_TEMPLATE')).toBe(true);
  }
});
it('模板IFC包含独立框扇实体和参数属性，复核状态仍约束交付',async()=>{
  const IFC=createRequire(import.meta.url)('web-ifc'),api=new IFC.IfcAPI();await api.Init();
  const m=buildingFixture();m.openings[0]!.design={template:'double-door',frameWidthM:.05};m.openings[1]!.design={template:'double-window',frameWidthM:.05};
  const bytes=exportIfc(m);expect(()=>exportIfc(m,'delivery')).toThrow('复核');expect(checkIfc(api,bytes).products).toBeGreaterThanOrEqual(6);
  const id=api.OpenModel(bytes,{COORDINATE_TO_ORIGIN:false});
  try{for(const type of [IFC.IFCDOOR,IFC.IFCWINDOW]){const refs=api.GetLineIDsWithType(id,type);expect(api.GetFlatMesh(id,refs.get(0)).geometries.size()).toBeGreaterThanOrEqual(5);}
    const sets=api.GetLineIDsWithType(id,IFC.IFCPROPERTYSET);let designs=0;for(let i=0;i<sets.size();i++){const set=api.GetLine(id,sets.get(i),true);if(set.Name.value==='Pset_SurveyOpeningDesign'){designs++;expect(set.HasProperties.find((p:any)=>p.Name.value==='FrameWidth').NominalValue.value).toBe(.05);}}expect(designs).toBe(2);
  }finally{api.CloseModel(id);api.Dispose();}
});
