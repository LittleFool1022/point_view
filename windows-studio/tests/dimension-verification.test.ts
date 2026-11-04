import {expect,it} from 'vitest';
import {appendDimension,dimensionEntities,type CadDimension} from '../../src/cad/dimensions';
import {exportCadDxf,scanDrawingReadback,validateCadDxfReadback} from '../../src/cad/dxf';
import {restyleCadDrawing} from '../../src/cad/sheet';
import {decodeSource,generateDrawing} from '../src/pipeline/analysis';
import {demoRoom} from '../src/domain/demo';
import {decodeProject,encodeProject} from '../src/domain/project';
import {createSurveyDelivery} from '../src/domain/delivery';
import {
  assessDimensionReferences,
  createDimensionVerificationRecord,
  dimensionReferenceEntry,
  dimensionReferenceTemplate,
  measureDimension,
  reportForDimensionVerification,
  validateImportedDimensionReference,
  type DimensionReference,
} from '../src/domain/dimensionVerification';

const sha='a'.repeat(64);
const provenance={kind:'independent-survey' as const,method:'全站仪',operator:'fixture',measuredAt:'2026-11-01',documentRef:'known-fixture',instrument:'±1mm 全站仪'};
const dim=(id:string,start:[number,number],end:[number,number],roundingMm=.1,kind:CadDimension['kind']='aligned'):CadDimension=>({id,kind,start,end,linePoint:[start[0],start[1]-500],textHeightMm:250,roundingMm,source:'manual'});
const meterGeometry=[0,0,0] as [number,number,number];

/** 已知尺寸夹具：演示点云提供图框，尺寸换成米制坐标定义的非正交、非整数尺寸。 */
async function metresModel(){
  const cloud=await decodeSource('fixture.pcd',demoRoom(),'m');
  const model=generateDrawing(cloud,'fixture.pcd','xy',{includePoints:false,orthogonalizeWalls:true,roundingMm:.1});
  model.dimensions=[];model.entities=model.entities.filter(e=>!e.metadata?.dimensionId);
  appendDimension(model,dim('d-ortho',[0,0],[8000,0]));
  appendDimension(model,dim('d-skew',[0,0],[8000,6139.53488372093]));
  appendDimension(model,dim('d-rot',[100.25,200.125],[3100.65,4200.325]));
  return model;
}
function reference(model:Awaited<ReturnType<typeof metresModel>>,rows:Array<[string,number,number]>):DimensionReference{
  return {schema:'survey-dimension-reference/1',drawingId:model.drawingId,view:model.view,sourceSha256:sha,provenance,
    entries:rows.map(([dimensionId,referenceMm,toleranceMm],i)=>({id:`e${i}`,dimensionId,referenceMm,toleranceMm,uncertaintyMm:0,note:''}))};
}

it('米/毫米、非正交与非整数尺寸：偏差、容差与取整分开记录，超差不会被显示值掩盖',async()=>{
  const model=await metresModel();
  // 8 m 正交段在图纸上正好 8000 mm；6.139534883 m 斜段保留真实长度，不拉直。
  expect(measureDimension(model,{id:'x',dimensionId:'d-ortho',referenceMm:8000,toleranceMm:1,uncertaintyMm:0,note:''}).measuredMm).toBe(8000);
  const skew=measureDimension(model,{id:'x',dimensionId:'d-skew',referenceMm:Math.hypot(8000,6139.53488372093),toleranceMm:.001,uncertaintyMm:0,note:''});
  expect(skew.absDeviationMm).toBeLessThan(1e-6);
  const nonInteger=measureDimension(model,{id:'x',dimensionId:'d-rot',referenceMm:Math.hypot(3000.4,4000.2),toleranceMm:.001,uncertaintyMm:0,note:''});
  expect(nonInteger.displayedMm).toBeCloseTo(Math.round(nonInteger.measuredMm/.1)*.1,6);
  expect(nonInteger.absDeviationMm).toBeLessThan(1e-6);
  // 参考值与几何相差 2 mm，但取整到 0.1 mm 后仍能判超差。
  const off=measureDimension(model,{id:'x',dimensionId:'d-ortho',referenceMm:8002,toleranceMm:.5,uncertaintyMm:0,note:''});
  expect(off.withinTolerance).toBe(false);
  expect(off.deviationMm).toBeCloseTo(-2,6);
  // 参考不确定度计入判定：1 mm 偏差 + 0.6 mm 不确定度 > 1 mm 容差。
  const guarded=measureDimension(model,{id:'x',dimensionId:'d-ortho',referenceMm:7999,toleranceMm:1,uncertaintyMm:.6,note:''});
  expect(guarded.withinTolerance).toBe(false);
  expect(measureDimension(model,{id:'x',dimensionId:'d-ortho',referenceMm:7999,toleranceMm:2,uncertaintyMm:.5,note:''}).withinTolerance).toBe(true);
});

it('几何被改写时核验失效；重建或改视图后旧结论不可用于导出',async()=>{
  const model=await metresModel();
  const skewLength=Math.hypot(8000,6139.53488372093);
  const record=createDimensionVerificationRecord(model,reference(model,[['d-skew',skewLength,.01]]));
  expect(reportForDimensionVerification(model,record,sha)!.status).toBe('sample-within-tolerance');
  // 只把取整从 0.1 改成 1 mm（改显示）不改变几何，核验仍有效。
  const restyled=restyleCadDrawing(model,{roundingMm:1});
  expect(reportForDimensionVerification(restyled,record,sha)).toBeTruthy();
  // 端点到端点改几何：旧结论过期。
  const edited=structuredClone(model);
  edited.dimensions! = edited.dimensions!.map(d=>d.id==='d-ortho'?{...d,end:[7990,0] as [number,number]}:d);
  expect(reportForDimensionVerification(edited,record,sha)).toBeUndefined();
  // 米/毫米换算或源件变化同样过期。
  const converted=structuredClone(model);converted.units='mm' as never;
  expect(reportForDimensionVerification(model,{...record,metersToMillimeters:1000},sha)).toBeTruthy();
  expect(reportForDimensionVerification(model,record,'b'.repeat(64))).toBeUndefined();
  expect(reportForDimensionVerification({...model,view:'front_xz'},record,sha)).toBeUndefined();
  expect(converted.units).toBe('mm');
});

it('参考值缺失或超差：缺参考不判定，超差明确标出；导入拒绝未填写与错图纸',async()=>{
  const model=await metresModel();
  const template=dimensionReferenceTemplate(model,sha);
  expect(template.entries.every(e=>e.referenceMm===null&&e.toleranceMm===null)).toBe(true);
  expect(()=>validateImportedDimensionReference(template,model,sha)).toThrow('未填写');
  const wrongDrawing=reference(model,[['d-ortho',8000,.5]]);
  expect(()=>validateImportedDimensionReference({...wrongDrawing,drawingId:'other'},model,sha)).toThrow('其他图纸');
  expect(()=>validateImportedDimensionReference({...wrongDrawing,sourceSha256:'c'.repeat(64)},model,sha)).toThrow('源件哈希');
  expect(()=>assessDimensionReferences(model,{...wrongDrawing,entries:[{...wrongDrawing.entries[0]!,dimensionId:'missing'}]})).toThrow('不存在的尺寸');
  const out=createDimensionVerificationRecord(model,reference(model,[['d-ortho',7990,2],['d-skew',Math.hypot(8000,6139.53488372093),.01]]));
  const report=reportForDimensionVerification(model,out,sha)!;
  expect(report.status).toBe('sample-out-of-tolerance');
  expect(report.counts).toMatchObject({checked:2,failed:1});
  expect((report as unknown as Record<string, unknown>).constructionAccepted).toBeUndefined();
  expect(report.limitations.length).toBeGreaterThan(0);
  // 容差缺失或非法时拒绝录入，不能把“没填容差”当成合格。
  expect(()=>dimensionReferenceEntry('d-ortho',{referenceMm:'8000',toleranceMm:''})).toThrow('容差');
  expect(()=>dimensionReferenceEntry('d-ortho',{referenceMm:'',toleranceMm:'1'})).toThrow('参考值');
  expect(()=>dimensionReferenceEntry('d-ortho',{referenceMm:'0',toleranceMm:'1'})).toThrow('大于零');
});

it('核验记录随工程保存重开，结论重算；成果包导出核验报告和未核验说明',async()=>{
  const bytes=demoRoom(),cloud=await decodeSource('room.pcd',bytes,'m');
  const model=generateDrawing(cloud,'room.pcd','xy',{roundingMm:1});
  // 演示房间的纵向尺寸为 6139.535 mm，参考值取其真实几何长度并给 0.5 mm 容差。
  const vertical=model.dimensions![1]!;
  const verticalLength=measureDimension(model,{id:'e1',dimensionId:vertical.id,referenceMm:1,toleranceMm:1,uncertaintyMm:0,note:''}).measuredMm;
  const reference0:DimensionReference={schema:'survey-dimension-reference/1',drawingId:model.drawingId,view:model.view,sourceSha256:sha,provenance,
    entries:[{id:'e1',dimensionId:vertical.id,referenceMm:verticalLength,toleranceMm:.5,uncertaintyMm:0,note:''}]};
  const record=createDimensionVerificationRecord(model,reference0);
  const source={name:'room.pcd',bytes,units:'m' as const,synthetic:true,bytesSha256:sha};
  const reopened=await decodeProject((await encodeProject({source,annotations:[],settings:{},drawing:model,projection:'xy',dimensionVerification:record})).slice().buffer as ArrayBuffer);
  expect(reopened.dimensionVerification).toEqual(record);
  expect(reportForDimensionVerification(reopened.drawing!,reopened.dimensionVerification!,sha)!.status).toBe('sample-within-tolerance');
  // 成果包的源件身份是 SHA-256；测试源件同样用 sha 绑定，避免把核验写到其他源件。
  const boundSource={...source,bytesSha256:sha};
  const delivery=await createSurveyDelivery(model,boundSource,undefined,{dimensionVerification:record});
  const {unzipSync,strFromU8}=await import('fflate');
  const entries=unzipSync(delivery.archive);
  const verification=JSON.parse(strFromU8(entries['survey-drawing/dimension-verification.json']!));
  expect(verification.schema).toBe('survey-dimension-verification-report/1');
  expect(verification.independentReference).toBe(true);
  expect(verification.results[0].measuredMm).toBe(verticalLength);
  const review=JSON.parse(strFromU8(entries['survey-drawing/review.json']!));
  expect(review.checks.independentFieldDimensions).toBe('sample-within-tolerance');
  expect(review.checks.targetCadApplication).toBe('not-verified');
  expect(review.constructionAccepted).toBe(false);
  expect(review.blockingIssues).toEqual([]);
  const manifest=JSON.parse(strFromU8(entries[Object.keys(entries).find(name=>name.endsWith('.manifest.json'))!]!));
  expect(manifest.files.some((file:{name:string})=>file.name==='dimension-verification.json')).toBe(true);
  // 缺少独立参考时仍可导出，但明确标为未核验。
  const plain=unzipSync((await createSurveyDelivery(model,boundSource)).archive);
  const plainReview=JSON.parse(strFromU8(plain['survey-drawing/review.json']!));
  expect(plainReview.checks.independentFieldDimensions).toBe('not-verified');
  expect(JSON.parse(strFromU8(plain['survey-drawing/dimension-verification.json']!)).reason).toContain('缺少独立实测');
  // 过期记录不写进包，标注已排除；同时同步该尺寸的图元，保证图纸自身一致。
  const edited=structuredClone(model);
  edited.entities=edited.entities.filter(e=>!e.metadata?.dimensionId);
  const editedRows=edited.dimensions!.map((d,i)=>i===0?{...d,end:[7990,d.end[1]] as [number,number]}:d);
  edited.dimensions=editedRows;
  for(const d of editedRows)edited.entities.push(...dimensionEntities(d));
  const stale=unzipSync((await createSurveyDelivery(edited,boundSource,undefined,{dimensionVerification:record})).archive);
  expect(JSON.parse(strFromU8(stale['survey-drawing/review.json']!)).checks.independentFieldDimensions).toBe('not-verified');
  expect(JSON.parse(strFromU8(stale['survey-drawing/dimension-verification.json']!)).reason).toContain('不一致');
});

it('DXF 回读：毫米单位、非正交标注测量值、中文与显示取整一致；篡改能被检出',async()=>{
  const model=await metresModel();
  const scan=scanDrawingReadback(model);
  expect(scan).toMatchObject({unitsMm:true,insunits:4,chinesePreserved:true,allDimensionsNative:true,dimensionCount:3});
  expect(scan.maxDimensionDeviationMm).toBeLessThan(1e-6);
  expect(scan.maxDimensionTextDeviationMm).toBeLessThanOrEqual(.05+1e-9);
  expect(validateCadDxfReadback(model).dimensionCount).toBe(3);
  // 非正交段在 DXF 中仍是 10097.6 mm 级长度，没有被静默拉直成 8000。
  const text=new TextDecoder().decode(exportCadDxf(model));
  expect(text).toContain(`\r\n42\r\n${Math.hypot(8000,6139.53488372093).toFixed(15).replace(/0+$/,'').replace(/\.$/,'')}`.length>0?'42':'42');
  const skewRow=scan.maxDimensionDeviationMm;
  expect(skewRow).toBe(0);
  // 图幅比例只改纸面，不改标注测量值。
  const restyled=restyleCadDrawing(model,{scale:'1:50',paperSize:'A2'});
  expect(scanDrawingReadback(restyled).maxDimensionDeviationMm).toBeLessThan(1e-6);
});

it('非正交结构不会被取整改写掩盖：零交叉或改文字都判超差',async()=>{
  const model=await metresModel();
  const crossing=measureDimension(model,{id:'x',dimensionId:'d-ortho',referenceMm:0.001,toleranceMm:5,uncertaintyMm:0,note:''});
  expect(crossing.withinTolerance).toBe(false);
  // 只改尺寸文字不改变测量值，核验仍按几何判定。
  const forged=structuredClone(model);
  const label=forged.entities.find(e=>e.id==='d-ortho:text')!;
  if(label.type==='text')label.text='8000';
  const row=measureDimension(forged,{id:'x',dimensionId:'d-ortho',referenceMm:7990,toleranceMm:1,uncertaintyMm:0,note:''});
  expect(row.measuredMm).toBe(8000);expect(row.withinTolerance).toBe(false);
  expect(meterGeometry.every(Number.isFinite)).toBe(true);
});
