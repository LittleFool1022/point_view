import {dimensionGeometry,type CadDimension} from '../../../src/cad/dimensions';
import type {DrawingModel} from '../../../src/cad/model';

/** 图纸关键尺寸的独立参考值；只用于核验，不写入几何或尺寸文字。 */
export interface DimensionReferenceEntry {
  id:string;
  dimensionId:string;
  /** 独立实测值（图纸毫米制，未取整）。 */
  referenceMm:number;
  /** 用户容差（毫米），包含图纸测量不确定度。 */
  toleranceMm:number;
  /** 独立测量的不确定度（毫米），0 表示未声明。 */
  uncertaintyMm:number;
  note:string;
}
/** 来源记录区分独立实测与合成/推算；合成参考不能冒充实测精度。 */
export interface DimensionReferenceProvenance {
  kind:'independent-survey'|'synthetic';
  method:string;
  operator:string;
  measuredAt:string;
  documentRef:string;
  instrument:string;
}
export interface DimensionReference {
  schema:'survey-dimension-reference/1';
  drawingId:string;
  view:DrawingModel['view'];
  sourceSha256:string;
  provenance:DimensionReferenceProvenance;
  entries:DimensionReferenceEntry[];
}
/** 保存参考输入与图纸状态指纹；结论在读取时重算，避免沿用过期“通过”。 */
export interface DimensionVerificationRecord {
  schema:'survey-dimension-verification/1';
  reference:DimensionReference;
  /** 记录时图纸的几何指纹，包含尺寸定义点和米/毫米换算。 */
  drawingSignature:string;
  /** 记录时画布实际使用的米/毫米换算；与图纸声明不一致即失效。 */
  metersToMillimeters:number;
  verifiedAt:string;
}

export const MAX_DIMENSION_REFERENCES=500;

export interface DimensionVerificationResult {
  entry:DimensionReferenceEntry;
  /** 图纸上的几何测量值（毫米，未取整）。 */
  measuredMm:number;
  /** 图纸显示值（按取整规则）。 */
  displayedMm:number;
  deviationMm:number;
  absDeviationMm:number;
  /** 取整显示造成的最大可能误差。 */
  displayQuantumMm:number;
  /** 以零为中心的对称区间 [measured-Δ, measured+Δ]。 */
  crossingIntervalMm:[number,number];
  toleranceBandMm:[number,number];
  withinTolerance:boolean;
}

export interface DimensionVerificationReport {
  schema:'survey-dimension-verification-report/1';
  drawingId:string;
  view:DrawingModel['view'];
  sourceSha256:string;
  verifiedAt:string;
  provenance:DimensionReferenceProvenance;
  independentReference:boolean;
  status:'sample-within-tolerance'|'sample-out-of-tolerance';
  acceptanceRule:string;
  units:{drawing:'mm';metersToMillimeters:number};
  counts:{checked:number;failed:number;totalDimensions:number};
  results:DimensionVerificationResult[];
  limitations:string[];
}

const round=(value:number,quantum:number)=>Math.round(value/quantum)*quantum;
const clean=(value:number)=>Number(value.toFixed(6));
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value);

function dimensionById(model:DrawingModel,id:string):CadDimension|undefined{
  return (model.dimensions??[]).find(d=>d.id===id);
}

/** 图纸指纹只覆盖几何与米/毫米换算；图幅、比例、取整只改表现，不使核验失效。 */
export function dimensionDrawingSignature(model:DrawingModel,projectionMetersToMillimeters=1_000):string{
  const rows=(model.dimensions??[]).map(d=>[d.id,d.kind,d.start,d.end,d.linePoint]);
  return JSON.stringify({drawingId:model.drawingId,view:model.view,units:model.units,metersToMillimeters:projectionMetersToMillimeters,dimensions:rows});
}

export function assertDimensionVerificationRecord(record:DimensionVerificationRecord):void{
  if(record?.schema!=='survey-dimension-verification/1')throw Error('图纸尺寸核验记录无效。');
  if(typeof record.drawingSignature!=='string'||!record.drawingSignature)throw Error('图纸尺寸核验缺少图纸指纹。');
  if(!finite(record.metersToMillimeters)||record.metersToMillimeters<=0)throw Error('米/毫米换算无效。');
  if(typeof record.verifiedAt!=='string'||!finite(Date.parse(record.verifiedAt)))throw Error('核验时间无效。');
  assertDimensionReference(record.reference);
}

export function assertDimensionReference(reference:DimensionReference):void{
  if(reference?.schema!=='survey-dimension-reference/1')throw Error('图纸尺寸参考不是支持的版本。');
  if(typeof reference.drawingId!=='string'||!reference.drawingId)throw Error('尺寸参考缺少图纸编号。');
  if(!['top_xy','front_xz','side_yz'].includes(reference.view))throw Error('尺寸参考图纸视图无效。');
  if(!/^[a-f0-9]{64}$/.test(reference.sourceSha256??''))throw Error('尺寸参考缺少源件哈希。');
  const p=reference.provenance;
  if(!p||!['independent-survey','synthetic'].includes(p.kind)||![p.method,p.operator,p.measuredAt,p.documentRef].every(s=>typeof s==='string'&&s.trim().length>0)||!finite(Date.parse(p.measuredAt)))throw Error('尺寸参考缺少有效来源、日期或说明。');
  if(typeof p.instrument!=='string')throw Error('尺寸参考缺少量具记录。');
  if(!Array.isArray(reference.entries)||!reference.entries.length||reference.entries.length>MAX_DIMENSION_REFERENCES)throw Error('尺寸参考条目为空或超过上限。');
  const seen=new Set<string>();
  for(const entry of reference.entries){
    if(!entry||typeof entry.id!=='string'||!entry.id||typeof entry.dimensionId!=='string'||!entry.dimensionId)throw Error('尺寸参考条目缺少编号。');
    if(!finite(entry.referenceMm)||entry.referenceMm<=0||!finite(entry.toleranceMm)||entry.toleranceMm<=0||!finite(entry.uncertaintyMm)||entry.uncertaintyMm<0)throw Error('参考值、容差或不确定度无效；容差必须大于零。');
    if(typeof entry.note!=='string')throw Error('尺寸参考备注无效。');
    if(seen.has(entry.dimensionId))throw Error('同一尺寸存在重复参考值。');seen.add(entry.dimensionId);
  }
}

/**
 * 逐项核验。判定条件：|图纸测量值-参考值| + 参考不确定度 <= 用户容差，
 * 参考值不能为零；测量与判定都使用未取整的图纸几何，取整只影响显示，
 * 避免非正交几何被取整改写掩盖。
 */
export function assessDimensionReferences(model:DrawingModel,reference:DimensionReference):DimensionVerificationResult[]{
  assertDimensionReference(reference);
  if(reference.drawingId!==model.drawingId||reference.view!==model.view)throw Error('尺寸参考与当前图纸或视图不一致，请重新生成图纸后再核验。');
  return reference.entries.map(entry=>measureDimension(model,entry));
}

/** 单项测量与判定；图纸测量值不受参考来源影响，参考值只参与合格判定。 */
export function measureDimension(model:DrawingModel,entry:DimensionReferenceEntry):DimensionVerificationResult{
  const d=dimensionById(model,entry.dimensionId);
  if(!d)throw Error(`尺寸参考引用了不存在的尺寸 ${entry.dimensionId}，图纸可能已重新生成。`);
  const g=dimensionGeometry(d),measuredMm=g.length,quantum=d.roundingMm,displayedMm=round(measuredMm,quantum);
  const deviationMm=measuredMm-entry.referenceMm;
  // 取整只影响显示；判定使用未取整的图纸几何，显示区间仅供阅读。
  const crossingIntervalMm:[number,number]=[entry.referenceMm-quantum/2,entry.referenceMm+quantum/2];
  const toleranceBandMm:[number,number]=[entry.referenceMm-entry.toleranceMm,entry.referenceMm+entry.toleranceMm];
  const crossing=entry.referenceMm===0;
  return {
    entry:{...entry},
    measuredMm:clean(measuredMm),
    displayedMm:clean(displayedMm),
    deviationMm:clean(deviationMm),
    absDeviationMm:clean(Math.abs(deviationMm)),
    displayQuantumMm:quantum,
    crossingIntervalMm:[clean(crossingIntervalMm[0]),clean(crossingIntervalMm[1])],
    toleranceBandMm:[clean(toleranceBandMm[0]),clean(toleranceBandMm[1])],
    withinTolerance:!crossing&&Math.abs(deviationMm)+entry.uncertaintyMm<=entry.toleranceMm+1e-9,
  };
}

export function createDimensionVerificationRecord(model:DrawingModel,reference:DimensionReference,metersToMillimeters=1_000):DimensionVerificationRecord{
  assessDimensionReferences(model,reference);
  return {schema:'survey-dimension-verification/1',reference:structuredClone(reference),drawingSignature:dimensionDrawingSignature(model,metersToMillimeters),metersToMillimeters,verifiedAt:new Date().toISOString()};
}

/** 记录是否已与当前图纸失配：图纸重建、尺寸编辑、视图切换、换算或源件变化。 */
export function dimensionVerificationExpired(model:DrawingModel|undefined,record:DimensionVerificationRecord,sourceSha256:string|undefined):boolean{
  if(!model||!sourceSha256)return false;
  try{assertDimensionVerificationRecord(record);}catch{return true;}
  if(record.reference.sourceSha256!==sourceSha256||record.reference.drawingId!==model.drawingId||record.reference.view!==model.view)return true;
  return record.drawingSignature!==dimensionDrawingSignature(model,record.metersToMillimeters);
}
/** 返回 undefined 表示记录已过期（图纸重建、视图切换、换算或源件变化）。 */
export function reportForDimensionVerification(model:DrawingModel,record:DimensionVerificationRecord,sourceSha256:string):DimensionVerificationReport|undefined{
  assertDimensionVerificationRecord(record);
  const ref=record.reference;
  // 源件身份变化是保真要求：换源件后旧核验不得沿用（保守处理记录缺失/异常）。
  if(!sourceSha256||ref.sourceSha256!==sourceSha256||ref.drawingId!==model.drawingId||ref.view!==model.view)return undefined;
  if(record.drawingSignature!==dimensionDrawingSignature(model,record.metersToMillimeters))return undefined;
  let results:DimensionVerificationResult[];
  // 参考项对应的尺寸已被删除或重建时，记录同样失效，不能沿用旧结论。
  try{
    if(ref.entries.some(entry=>!dimensionById(model,entry.dimensionId)))return undefined;
    results=assessDimensionReferences(model,ref);
  }catch{return undefined;}
  const failed=results.filter(r=>!r.withinTolerance).length;
  return {
    schema:'survey-dimension-verification-report/1',
    drawingId:model.drawingId,view:model.view,sourceSha256:sourceSha256,verifiedAt:record.verifiedAt,
    provenance:ref.provenance,independentReference:ref.provenance.kind==='independent-survey',
    status:failed?'sample-out-of-tolerance':'sample-within-tolerance',
    acceptanceRule:'abs(drawing measured - independent reference) + reference uncertainty <= user tolerance',
    units:{drawing:'mm',metersToMillimeters:record.metersToMillimeters},
    counts:{checked:results.length,failed,totalDimensions:model.dimensions?.length??0},
    results,
    limitations:[
      '只核验清单列出的关键尺寸，不代表全图或整栋建筑的精度认证。',
      '拟合残差、网格分辨率、显示取整和合成数据都不是独立实测精度。',
      '不包含配准误差、墙面位置/垂直度、目标 CAD 软件兼容性验收。',
    ],
  };
}

/** 参考模板只列出可标注尺寸，不把图纸当前测量值预填成“实测真值”。 */
export function dimensionReferenceTemplate(model:DrawingModel,sourceSha256:string){
  return {
    schema:'survey-dimension-reference/1' as const,
    drawingId:model.drawingId,view:model.view,sourceSha256,
    provenance:{kind:'independent-survey' as const,method:'全站仪/钢尺实测关键净尺寸',operator:'',measuredAt:'',documentRef:'',instrument:''},
    entries:(model.dimensions??[]).map(d=>({id:`${d.id}-ref`,dimensionId:d.id,referenceMm:null,toleranceMm:null,uncertaintyMm:0,note:''})),
  };
}

/** 参考文件导入时的结构校验（可能包含待填写的 null）。 */
export function validateImportedDimensionReference(value:unknown,model:DrawingModel,sourceSha256:string):DimensionReference{
  const v=value as DimensionReference;
  if(v?.schema!=='survey-dimension-reference/1')throw Error('不是图纸尺寸参考文件。');
  if(v.drawingId!==model.drawingId||v.view!==model.view)throw Error('尺寸参考属于其他图纸或视图。');
  if(v.sourceSha256!==sourceSha256)throw Error('尺寸参考的源件哈希与当前工程不一致。');
  const entries=v.entries;
  if(!Array.isArray(entries)||!entries.length)throw Error('尺寸参考没有核验项。');
  for(const e of entries){
    if(!e||typeof e.dimensionId!=='string'||!dimensionById(model,e.dimensionId))throw Error('尺寸参考引用了当前图纸中不存在的尺寸。');
    if(!finite(e.referenceMm)||!finite(e.toleranceMm))throw Error('参考值或容差未填写，缺少独立实测时不能标记为已核验。');
  }
  assertDimensionReference(v);
  return structuredClone(v);
}

/** 校验界面上手工录入的条目（选中尺寸逐项填写）。 */
export function dimensionReferenceEntry(dimensionId:string,raw:{referenceMm:string|number;toleranceMm:string|number;uncertaintyMm?:string|number;note?:string}):DimensionReferenceEntry{
  const num=(value:unknown,name:string)=>{
    const n=typeof value==='number'?value:Number(String(value??'').trim());
    if(String(value??'').trim()===''||!Number.isFinite(n))throw Error(`${name}必须是有效数字。`);
    return n;
  };
  const referenceMm=num(raw.referenceMm,'参考值'),toleranceMm=num(raw.toleranceMm,'容差'),uncertaintyMm=raw.uncertaintyMm===undefined?0:num(raw.uncertaintyMm,'不确定度');
  if(referenceMm<=0)throw Error('参考值必须大于零。');
  if(toleranceMm<=0)throw Error('容差必须大于零；缺少容差时不能判定合格。');
  if(uncertaintyMm<0)throw Error('不确定度不能为负。');
  return {id:crypto.randomUUID(),dimensionId,referenceMm,toleranceMm,uncertaintyMm,note:String(raw.note??'').slice(0,200)};
}
