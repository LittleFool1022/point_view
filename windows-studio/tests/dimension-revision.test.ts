import {expect,it} from 'vitest';
import {appendDimension,type CadDimension} from '../../src/cad/dimensions';
import {exportCadDxf,scanDrawingReadback} from '../../src/cad/dxf';
import {restyleCadDrawing} from '../../src/cad/sheet';
import {decodeSource,generateDrawing} from '../src/pipeline/analysis';
import {demoRoom} from '../src/domain/demo';
import {decodeProject,encodeProject} from '../src/domain/project';
import {
  applyDimensionEndpointRevision,
  dimensionEndpointCandidates,
  dimensionHasLinkedGeometry,
  linkedEntityIds,
  pointFromRevisionAmount,
  preserveRevisionState,
  revisionChainSignature,
  revisionConsistencyIssues,
  revisionStateStamped,
  stampRevisionState,
  undoLastDimensionRevision,
  type DimensionRevisionState,
} from '../src/domain/dimensionRevision';
import {createDimensionVerificationRecord,reportForDimensionVerification} from '../src/domain/dimensionVerification';
import {composeRevisionReadbackReport,createRevisionDelivery,revisionChainSha256,withRevisionStamp,readRevisionStamp} from '../src/domain/revisionReadback';

const sha='a'.repeat(64);
const skewLength=Math.hypot(8000,6139.53488372093);
const skewDirection:[number,number]=[8000/skewLength,6139.53488372093/skewLength];

const dim=(id:string,start:[number,number],end:[number,number],kind:CadDimension['kind']='aligned',roundingMm=.1):CadDimension=>({id,kind,start,end,linePoint:[start[0],start[1]-500],textHeightMm:250,roundingMm,source:'manual'});

/**
 * 已知尺寸夹具：米制演示房间提供图框，尺寸换成非正交、非整数定义，
 * 并补一条端点与尺寸定义点重合的墙线（关联对象）。
 */
async function fixture(){
  const bytes=demoRoom(),cloud=await decodeSource('fixture.pcd',bytes,'m');
  const model=generateDrawing(cloud,'fixture.pcd','xy',{includePoints:false,orthogonalizeWalls:true,roundingMm:.1});
  model.dimensions=[];model.entities=model.entities.filter(e=>!e.metadata?.dimensionId);
  // 合成区域整体移到已知坐标，保证只有下面的夹具墙线与尺寸定义点重合。
  const OFFSET=31_000;
  for(const entity of model.entities){
    if(entity.type==='line')entity.start=[entity.start[0]+OFFSET,entity.start[1]+OFFSET],entity.end=[entity.end[0]+OFFSET,entity.end[1]+OFFSET];
    if(entity.type==='polyline')entity.points=entity.points.map(([x,y])=>[x+OFFSET,y+OFFSET]);
    if(entity.type==='text'||entity.type==='point')entity.position=[entity.position[0]+OFFSET,entity.position[1]+OFFSET];
  }
  model.modelBoundsMm={min:[model.modelBoundsMm.min[0]+OFFSET,model.modelBoundsMm.min[1]+OFFSET],max:[model.modelBoundsMm.max[0]+OFFSET,model.modelBoundsMm.max[1]+OFFSET]};
  appendDimension(model,dim('d-ortho',[-2000,-1500],[6000,-1500]));
  appendDimension(model,dim('d-skew',[0,0],[8000,6139.53488372093]));
  appendDimension(model,dim('d-lone',[-2000,2000],[2000,2000]));
  const wall=(id:string,start:[number,number],end:[number,number],layer:'OBSERVED_WALL'|'INFERRED_WALL'='OBSERVED_WALL')=>model.entities.push({id,type:'line',start,end,layer,category:'wall',source:layer==='OBSERVED_WALL'?'observed':'inferred',confidence:'measured'});
  wall('wall-ortho',[-2000,-1500],[6000,-1500]);
  wall('wall-skew-1',[0,0],[-4000,-3069.767441860465]);
  wall('wall-skew-2',[0,0],[8000,6139.53488372093]);
  return {model,bytes};
}

it('选中尺寸定位关联对象：无关联尺寸明确不返回端点，有关联时给出墙线与端点',async()=>{
  const {model}=await fixture();
  expect(dimensionHasLinkedGeometry(model,'d-ortho')).toBe(true);
  const rows=dimensionEndpointCandidates(model,'d-ortho');
  expect(rows.map(row=>[row.entityId,row.vertexIndex,row.side])).toEqual([['wall-ortho',0,'start'],['wall-ortho',1,'end']]);
  expect(linkedEntityIds(model,'d-ortho')).toEqual(['wall-ortho']);
  // 斜墙两端都落在尺寸起点上，两侧墙线都要能高亮与定位（不能只算一条）。
  expect(linkedEntityIds(model,'d-skew').sort()).toEqual(['wall-skew-1','wall-skew-2']);
  expect(dimensionEndpointCandidates(model,'d-skew').filter(row=>row.vertexIndex===0).length).toBe(2);
  // 没有任何图元端点落在该尺寸定义点上：明确返回空，由界面提示。
  expect(dimensionHasLinkedGeometry(model,'d-lone')).toBe(false);
  expect(dimensionEndpointCandidates(model,'d-lone')).toEqual([]);
  expect(dimensionEndpointCandidates(model,'missing')).toEqual([]);
});

it('最小几何修订：非正交与非整数尺寸随几何重算，修订量与尺寸变化量一致，固定端与文字同步',async()=>{
  const {model}=await fixture();
  const before=scanDrawingReadback(model);
  // 非正交段：沿原方向延长 25.4 mm（1 inch），不做任何取整或拉直。
  const skew=model.dimensions!.find(d=>d.id==='d-skew')!;
  const target=pointFromRevisionAmount(skew,skew.end,25.4);
  expect(target[0]).toBeCloseTo(8000+skewDirection[0]*25.4,6);
  const result=applyDimensionEndpointRevision(model,'d-skew',{entityId:'wall-skew-2',vertexIndex:1,point:target,reason:'按现场复测延长斜墙'});
  expect(result.delta.beforeMeasuredMm).toBeCloseTo(skewLength,6);
  expect(result.delta.afterMeasuredMm).toBeCloseTo(skewLength+25.4,6);
  expect(result.delta.revisionMm).toBeCloseTo(25.4,6);
  expect(result.delta.measuredChangeMm).toBeCloseTo(25.4,6);
  // 尺寸变化量与修订量一致；非正交段没有被静默拉直成水平尺寸。
  expect(result.delta.consistencyResidualMm).toBe(0);
  // 只移动落在该端点上的那一侧；另一侧定义点（尺寸起点）保持原位。
  expect(result.delta.fixedDefinitionShiftMm).toBe(0);
  expect(result.measuredMm).toBeCloseTo(skewLength+25.4,6);
  expect(result.displayedMm).toBe(Number((Math.round((skewLength+25.4)/.1)*.1).toFixed(6)));
  const revised=result.model.dimensions!.find(d=>d.id==='d-skew')!;
  expect(revised.start).toEqual([0,0]);
  expect(revised.end).toEqual(target);
  // 关联墙线端点同步改；另一条墙线与尺寸起点不动。
  const wall=result.model.entities.find(e=>e.id==='wall-skew-2')!;
  expect(wall.type==='line'&&wall.end).toEqual(target);
  expect(result.model.entities.find(e=>e.id==='wall-skew-1')).toEqual(model.entities.find(e=>e.id==='wall-skew-1'));
  // 尺寸文字由几何重算，DXF 回读与重算值一致。
  const scan=scanDrawingReadback(result.model);
  expect(scan.maxDimensionDeviationMm).toBeLessThan(1e-6);
  expect(scan.dimensions!.find(row=>row.dimensionId==='d-skew')!.measuredMm).toBeCloseTo(skewLength+25.4,6);
  expect(before.dimensions!.find(row=>row.dimensionId==='d-skew')!.measuredMm).toBeCloseTo(skewLength,6);
  expect(revisionConsistencyIssues({changes:[result.delta],createdAt:'x'})).toEqual([]);
  // 非整数修订量同样不取整：缩短 13.37 mm。
  const shrunk=applyDimensionEndpointRevision(model,'d-skew',{entityId:'wall-skew-2',vertexIndex:1,point:pointFromRevisionAmount(skew,skew.end,-13.37)});
  expect(shrunk.delta.measuredChangeMm).toBeCloseTo(-13.37,6);
  expect(shrunk.delta.consistencyResidualMm).toBe(0);
});

it('正交与米/毫米：输入数值修订端点，尺寸即时重算并给出未取整值与显示值',async()=>{
  const {model}=await fixture();
  const ortho=model.dimensions!.find(d=>d.id==='d-ortho')!;
  const result=applyDimensionEndpointRevision(model,'d-ortho',{entityId:'wall-ortho',vertexIndex:1,point:pointFromRevisionAmount(ortho,ortho.end,-125.5)});
  expect(result.measuredMm).toBeCloseTo(8000-125.5,6);
  expect(result.displayedMm).toBeCloseTo(7874.5,6);
  expect(result.roundingMm).toBe(.1);
  // 1:1 米制换算写在成果里：8000 mm 即 8.000 m，修订后 7.8745 m。
  expect(Number((result.measuredMm/1000).toFixed(4))).toBe(7.8745);
  expect(()=>applyDimensionEndpointRevision(model,'d-ortho',{entityId:'wall-ortho',vertexIndex:1,point:[ortho.start[0],ortho.start[1]]})).toThrow('尺寸为零');
  expect(()=>applyDimensionEndpointRevision(model,'d-ortho',{entityId:'wall-ortho',vertexIndex:0,point:[ortho.end[0],ortho.end[1]]})).toThrow();
  expect(()=>applyDimensionEndpointRevision(model,'d-ortho',{entityId:'wall-ortho',vertexIndex:1,point:ortho.end})).toThrow('未产生几何变化');
  expect(()=>applyDimensionEndpointRevision(model,'d-lone',{entityId:'wall-ortho',vertexIndex:1,point:[1,2]})).toThrow('不是选中尺寸的定义点');
  expect(()=>applyDimensionEndpointRevision(model,'d-ortho',{entityId:'missing',vertexIndex:0,point:[1,2]})).toThrow('关联图元已不存在');
});

it('撤销恢复几何与尺寸值；重做式重新修订不改变结论；超出容差的位移不被静默接受',async()=>{
  const {model}=await fixture();
  const before=JSON.stringify(model.dimensions);
  const result=applyDimensionEndpointRevision(model,'d-skew',{entityId:'wall-skew-2',vertexIndex:1,point:pointFromRevisionAmount(model.dimensions!.find(d=>d.id==='d-skew')!,model.dimensions!.find(d=>d.id==='d-skew')!.end,42.5)});
  const state:DimensionRevisionState={changes:[result.delta],createdAt:'2026-11-04T00:00:00.000Z'};
  const undone=undoLastDimensionRevision(result.model,state,'d-skew');
  expect(undone.measuredMm).toBeCloseTo(skewLength,6);
  expect(JSON.stringify(undone.model.dimensions)).toBe(before);
  expect(undone.state.changes).toEqual([]);
  expect(undone.model.entities.find(e=>e.id==='wall-skew-2')).toEqual(model.entities.find(e=>e.id==='wall-skew-2'));
  expect(()=>undoLastDimensionRevision(result.model,undone.state,'d-skew')).toThrow('没有可撤销');
  expect(()=>undoLastDimensionRevision(result.model,state,'d-ortho')).toThrow('不属于当前选中尺寸');
  // 斜向拖动折算成沿尺寸方向的修订量；垂直分量不参与尺寸，也不拉直斜段。
  // 端点被改到图元另一侧：尺寸方向随之翻转，修订量与尺寸变化量不再一致，必须被一致性核对拦住。
  const drift=applyDimensionEndpointRevision(model,'d-skew',{entityId:'wall-skew-2',vertexIndex:1,point:[-4000,-3069.767441860465]});
  expect(drift.delta.consistencyResidualMm).toBeGreaterThan(1);
  expect(revisionConsistencyIssues({changes:[drift.delta],createdAt:'x'})[0]).toContain('相差');
});

it('几何修订让核验按指纹过期；撤销只恢复几何与尺寸值，旧核验结论不会复活',async()=>{
  const {model}=await fixture();
  const reference={schema:'survey-dimension-reference/1' as const,drawingId:model.drawingId,view:model.view,sourceSha256:sha,provenance:{kind:'independent-survey' as const,method:'钢尺',operator:'测试',measuredAt:'2026-11-01',documentRef:'fixture-001',instrument:'±1mm'},
    entries:[{id:'e1',dimensionId:'d-ortho',referenceMm:8000,toleranceMm:1,uncertaintyMm:0,note:''}]};
  const record=createDimensionVerificationRecord(model,reference);
  expect(reportForDimensionVerification(model,record,sha)!.status).toBe('sample-within-tolerance');
  // 改几何：端点沿垂直尺寸方向移动 49.25 mm（尺寸几乎不变但图纸指纹变化），旧结论按指纹规则过期。
  const changed=applyDimensionEndpointRevision(model,'d-ortho',{entityId:'wall-ortho',vertexIndex:1,point:[6000,-1450.75]});
  expect(changed.measuredMm).toBeCloseTo(8000.1516,3);
  // 垂直位移在尺寸方向上几乎没有分量（0.15 mm 来自尺寸端点本身的微小倾斜），远小于 49.25 mm 的位移。
  expect(Math.abs(changed.delta.revisionMm)).toBeLessThan(0.5);
  // 残差 = |几何重算的尺寸变化量 − 修订量|：垂直位移的投影只有 0.15 mm，残差如实记录这次差。
  // 记录里的尺寸变化量来自几何重算，残差与它一致；垂直位移时两者都是小量。
  expect(changed.delta.measuredChangeMm).toBeCloseTo((changed.measuredMm-8000),3);
  expect(changed.delta.consistencyResidualMm).toBeCloseTo(Math.abs(Math.abs(changed.delta.measuredChangeMm)-Math.abs(changed.delta.revisionMm)),3);
  expect(reportForDimensionVerification(changed.model,record,sha)).toBeUndefined();
  // 撤销：几何与尺寸值回到修订前，但修订链保留“有过改动”，界面只提示一次过期。
  const undone=undoLastDimensionRevision(changed.model,{changes:[changed.delta],createdAt:'2026-11-04T00:00:00.000Z'},'d-ortho');
  expect(undone.measuredMm).toBeCloseTo(8000,6);
  expect(undone.state.changes).toEqual([]);
});

it('修订随工程保存重开：几何与尺寸一致，修订链一并恢复',async()=>{
  const {model,bytes}=await fixture();
  const changed=applyDimensionEndpointRevision(model,'d-skew',{entityId:'wall-skew-2',vertexIndex:1,point:pointFromRevisionAmount(model.dimensions!.find(d=>d.id==='d-skew')!,model.dimensions!.find(d=>d.id==='d-skew')!.end,30)});
  const stamped=stampRevisionState(changed.model,{changes:[changed.delta],createdAt:'2026-11-04T00:00:00.000Z'});
  expect(revisionStateStamped(stamped,{changes:[changed.delta],createdAt:'2026-11-04T00:00:00.000Z'})).toBe(true);
  const source={name:'fixture.pcd',bytes,units:'m' as const,synthetic:true,bytesSha256:sha};
  const reopened=await decodeProject((await encodeProject({source,annotations:[],settings:{},drawing:stamped,projection:'xy'})).slice().buffer as ArrayBuffer);
  const restored=reopened.drawing!;
  expect(restored.dimensions).toEqual(stamped.dimensions);
  expect(restored.entities.filter(e=>e.category==='wall')).toEqual(stamped.entities.filter(e=>e.category==='wall'));
  const scan=scanDrawingReadback(restored);
  expect(scan.dimensions!.find(row=>row.dimensionId==='d-skew')!.measuredMm).toBeCloseTo(changed.measuredMm,6);
  expect((restored.parameters as {dimensionRevisions?: unknown[]}).dimensionRevisions).toHaveLength(1);
});

it('重新生成图纸沿用修订链：图谱图元为新几何，但旧修订链与新快照不同，旧回读与旧核验都过期',async()=>{
  const {model}=await fixture();
  const changed=applyDimensionEndpointRevision(model,'d-skew',{entityId:'wall-skew-2',vertexIndex:1,point:pointFromRevisionAmount(model.dimensions!.find(d=>d.id==='d-skew')!,model.dimensions!.find(d=>d.id==='d-skew')!.end,30)});
  const state:DimensionRevisionState={changes:[changed.delta],createdAt:'2026-11-04T00:00:00.000Z'};
  const rebuilt=preserveRevisionState(model,state);
  expect(rebuilt.warnings.some(warning=>warning.code==='DIMENSION_REVISIONS_CARRIED')).toBe(true);
  expect(rebuilt.dimensions).toEqual(model.dimensions);
  expect(revisionChainSignature(state)).not.toBe(revisionChainSignature({changes:[],createdAt:'2026-11-05T00:00:00.000Z'}));
  const plain=stampRevisionState(model,undefined);
  expect((plain.parameters as {dimensionRevisions?: unknown[]}).dimensionRevisions).toBeUndefined();
});

it('重导出闭环：DXF 回读核对修订后坐标与原生标注值，偏差单列；成果包绑定同一修订',async()=>{
  const {model,bytes}=await fixture();
  const changed=applyDimensionEndpointRevision(model,'d-skew',{entityId:'wall-skew-2',vertexIndex:1,point:pointFromRevisionAmount(model.dimensions!.find(d=>d.id==='d-skew')!,model.dimensions!.find(d=>d.id==='d-skew')!.end,25.4)});
  const state:DimensionRevisionState={changes:[changed.delta],createdAt:'2026-11-04T00:00:00.000Z'};
  const chainSha256=await revisionChainSha256(state);
  const source={name:'fixture.pcd',bytes,units:'m' as const,synthetic:true,bytesSha256:sha};
  const delivery=await createRevisionDelivery({model:changed.model,source,revision:1,chainSha256,sourceSha256:sha,state,controls:{geometryRebuilt:false,revisionStateCarried:true}});
  const {unzipSync,strFromU8}=await import('fflate');
  const entries=unzipSync(delivery.archive);
  const report=JSON.parse(strFromU8(entries['survey-drawing/revision-readback.json']!));
  expect(report.schema).toBe('survey-revision-readback/1');
  expect(report.revision).toBe(1);
  expect(report.chainSha256).toBe(chainSha256);
  expect(report.revisionCount).toBe(1);
  expect(report.problems).toEqual([]);
  expect(report.maxDeviationMm).toBeLessThan(1e-6);
  expect(report.reader.independent).toBeUndefined();
  const skew=report.dimensions.find((row:{dimensionId:string})=>row.dimensionId==='d-skew');
  expect(skew.revisionMm).toBeCloseTo(25.4,6);
  expect(skew.measuredChangeMm).toBeCloseTo(25.4,6);
  expect(skew.expectedMeasuredMm).toBeCloseTo(skewLength+25.4,6);
  expect(skew.readbackMeasuredMm).toBeCloseTo(skewLength+25.4,6);
  expect(skew.deviationMm).toBe(0);
  const manifest=JSON.parse(strFromU8(entries[Object.keys(entries).find(name=>name.endsWith('.manifest.json'))!]!));
  expect(manifest.drawingRevision).toMatchObject({revision:1,chainSha256,revisionCount:1,maxReadbackDeviationMm:0});
  expect(manifest.files.some((file:{name:string})=>file.name==='revision-readback.json')).toBe(true);
  const review=JSON.parse(strFromU8(entries['survey-drawing/review.json']!));
  expect(review.drawingRevision.revision).toBe(1);
  expect(review.revisionReadback.problems).toEqual([]);
  expect(review.blockingIssues).toEqual([]);
  // DXF 内嵌修订戳，回读能确认文件就是这次修订导出的。
  const dxf=entries[Object.keys(entries).find(name=>name.endsWith('.dxf'))!]!;
  console.log('DBGSTAMP', new TextDecoder().decode(dxf.slice(0,300)));
  expect(readRevisionStamp(dxf)).toMatchObject({revision:1,chainSha256});
  expect(withRevisionStamp(dxf,{drawingId:model.drawingId,revision:2,chainSha256}).byteLength).toBeGreaterThan(dxf.byteLength);
  // 独立读取器结果分列记录，偏差取两者较大值。
  const withIndependent=composeRevisionReadbackReport({model:changed.model,dxf,revision:1,chainSha256,sourceSha256:sha,state,independent:{reader:'ezdxf 1.4.5',audit:{errors:0,fixes:0},maxExportDeviationMm:0,dimensions:changed.model.dimensions!.map(d=>({dimensionId:d.id,expectedMm:0,readbackMm:Math.hypot(d.end[0]-d.start[0],d.end[1]-d.start[1]),deviationMm:0}))},controls:{geometryRebuilt:false,revisionStateCarried:true}});
  expect(withIndependent.reader.independent).toMatchObject({reader:'ezdxf 1.4.5',checked:true,auditErrors:0});
  expect(withIndependent.problems).toEqual([]);
  const flagged=composeRevisionReadbackReport({model:changed.model,dxf,revision:1,chainSha256,sourceSha256:sha,state:{changes:[{...changed.delta,consistencyResidualMm:2.5}],createdAt:'x'},controls:{geometryRebuilt:false,revisionStateCarried:true}});
  expect(flagged.problems.join(' ')).toContain('相差 2.5 mm');
  expect(()=>createRevisionDelivery({model:{...changed.model,units:'in' as never},source,revision:1,chainSha256,sourceSha256:sha,state,controls:{geometryRebuilt:false,revisionStateCarried:true}})).rejects.toThrow();
});

it('未修订的正常流程不增加确认：无修订时导出报告标明 0 项修订且回读通过',async()=>{
  const {model,bytes}=await fixture();
  const source={name:'fixture.pcd',bytes,units:'m' as const,synthetic:true,bytesSha256:sha};
  const chainSha256=await revisionChainSha256(undefined);
  const delivery=await createRevisionDelivery({model,source,revision:0,chainSha256,sourceSha256:sha,controls:{geometryRebuilt:false,revisionStateCarried:true}});
  expect(delivery.report.revisionCount).toBe(0);
  expect(delivery.report.dimensions.every(row=>row.revisionMm===undefined&&row.note==='未修订尺寸')).toBe(true);
  expect(delivery.report.problems).toEqual([]);
  // 图幅与比例只改纸面，不触发修订链变化。
  const restyled=restyleCadDrawing(model,{scale:'1:50',paperSize:'A2'});
  expect(exportCadDxf(restyled).byteLength).toBeGreaterThan(0);
  expect(revisionChainSha256(undefined)).resolves.toBe(chainSha256);
});
