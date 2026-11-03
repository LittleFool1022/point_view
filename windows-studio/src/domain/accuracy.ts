import {polygonArea,validateBuilding,wallLength,type BuildingModel} from './building';
export type AccuracyMetric='lengthM'|'heightM'|'thicknessM'|'widthM'|'offsetM'|'sillM'|'areaM2'|'elevationM';
export interface AccuracyReference {
  schema:'survey-accuracy-reference/1'; modelId:string; sourceStamp:string;
  provenance:{kind:'independent-survey'|'synthetic';method:string;operator:string;measuredAt:string;documentRef:string};
  measurements:Array<{elementId:string;metric:AccuracyMetric;reference:number;tolerance:number;uncertainty:number}>;
}
/** 保存实测输入和核验修订；报告在恢复/交付时重新计算，避免沿用过期的“通过”状态。 */
export interface AccuracyRecord {
  schema:'survey-accuracy-record/1'; reference:AccuracyReference; modelRevision:number; assessedAt:string;
}
function assertReference(reference:AccuracyReference){
  const p=reference?.provenance,rows=reference?.measurements;
  if(reference?.schema!=='survey-accuracy-reference/1'||typeof reference.modelId!=='string'||!reference.modelId||typeof reference.sourceStamp!=='string'||!reference.sourceStamp)throw Error('精度基准缺少模型或测量来源。');
  if(!p||!['independent-survey','synthetic'].includes(p.kind)||![p.method,p.operator,p.measuredAt,p.documentRef].every(s=>typeof s==='string'&&s.trim().length>0)||!Number.isFinite(Date.parse(p.measuredAt))||!Array.isArray(rows)||!rows.length||rows.length>20000)throw Error('精度基准缺少有效测量来源、日期或核验项。');
  const seen=new Set<string>();
  for(const row of rows){
    if(!row||typeof row.elementId!=='string'||!row.elementId||!['lengthM','heightM','thicknessM','widthM','offsetM','sillM','areaM2','elevationM'].includes(row.metric)||![row.reference,row.tolerance,row.uncertainty].every(Number.isFinite)||row.tolerance<=0||row.uncertainty<0)throw Error('参考值、容差或测量不确定度无效。');
    const key=row.elementId+':'+row.metric;if(seen.has(key))throw Error('精度基准存在重复核验项。');seen.add(key);
  }
}
export function assertAccuracyRecord(record:AccuracyRecord){
  if(record?.schema!=='survey-accuracy-record/1'||!Number.isSafeInteger(record.modelRevision)||record.modelRevision<1||typeof record.assessedAt!=='string'||!Number.isFinite(Date.parse(record.assessedAt)))throw Error('工程尺寸核验记录无效。');
  assertReference(record.reference);
}
export function createAccuracyRecord(model:BuildingModel,reference:AccuracyReference):AccuracyRecord {
  assessAccuracy(model,reference);
  return {schema:'survey-accuracy-record/1',reference:structuredClone(reference),modelRevision:model.revision,assessedAt:new Date().toISOString()};
}
export function reportForAccuracyRecord(model:BuildingModel,record:AccuracyRecord){
  assertAccuracyRecord(record);
  if(record.reference.modelId!==model.id||record.modelRevision!==model.revision||record.reference.sourceStamp!==model.sourceStamp)return undefined;
  return {...assessAccuracy(model,record.reference),createdAt:record.assessedAt};
}
/** 每项阈值与不确定度沿用相同单位；不将拟合残差当成独立测量真值。 */
export function assessAccuracy(model:BuildingModel,reference:AccuracyReference){
  if(validateBuilding(model).some(i=>i.code!=='UNREVIEWED'))throw Error('建筑模型无效，无法核验精度。');
  if(reference?.schema!=='survey-accuracy-reference/1'||reference.modelId!==model.id||reference.sourceStamp!==model.sourceStamp)throw Error('精度基准与当前模型或测量来源不一致。');
  assertReference(reference);
  const p=reference.provenance,rows=reference.measurements;
  const results=rows.map(row=>{
    const wall=model.walls.find(w=>w.id===row.elementId),opening=model.openings.find(o=>o.id===row.elementId),room=model.rooms.find(r=>r.id===row.elementId),level=model.levels.find(l=>l.id===row.elementId);
    let actual:number|undefined;
    if(wall)actual=({lengthM:wallLength(wall),heightM:wall.heightM,thicknessM:wall.thicknessM} as Partial<Record<AccuracyMetric,number>>)[row.metric];
    if(opening)actual=({widthM:opening.widthM,heightM:opening.heightM,offsetM:opening.offsetM,sillM:opening.sillM} as Partial<Record<AccuracyMetric,number>>)[row.metric];
    if(room)actual=({areaM2:polygonArea(room.boundaryM),heightM:room.heightM} as Partial<Record<AccuracyMetric,number>>)[row.metric];
    if(level&&row.metric==='elevationM')actual=level.elevationM;
    if(actual===undefined||!Number.isFinite(actual))throw Error('精度基准引用了不存在的构件或不适用的指标。');
    const error=actual-row.reference,absError=Math.abs(error),guardedError=absError+row.uncertainty;
    return {...row,unit:row.metric==='areaM2'?'m²':'m',actual,error,absError,guardedError,withinTolerance:guardedError<=row.tolerance+1e-12};
  });
  const failed=results.filter(r=>!r.withinTolerance).length;
  return {schema:'survey-accuracy-report/1',modelId:model.id,modelRevision:model.revision,sourceStamp:model.sourceStamp,sourceSha256:model.sourceSha256,createdAt:new Date().toISOString(),provenance:p,status:failed?'sample-out-of-tolerance':'sample-within-tolerance',independentReference:p.kind==='independent-survey',constructionAccepted:false,counts:{checked:results.length,failed,totalElements:model.walls.length+model.openings.length+model.rooms.length+model.levels.length,coveredElements:new Set(results.map(r=>r.elementId)).size},acceptanceRule:'abs(model-reference)+reference uncertainty <= user tolerance',results,limitations:['仅核验已列出的构件与标量尺寸，不代表全工程施工放行。','不包含配准误差、墙面位置/垂直度、材料或目标CAD/BIM兼容认证。','阈值和独立测量来源由提供者负责；合成基准不作为真实精度验收。']};
}
/** 候选清单只提供待填写字段，不把当前模型尺寸预填成独立真值。 */
export function accuracyReferenceTemplate(model:BuildingModel){
  const measurements:Array<{elementId:string;name:string;metric:AccuracyMetric;reference:null;tolerance:null;uncertainty:null}>=[];
  const add=(id:string,name:string,metrics:AccuracyMetric[])=>metrics.forEach(metric=>measurements.push({elementId:id,name,metric,reference:null,tolerance:null,uncertainty:null}));
  model.walls.forEach(w=>add(w.id,w.name??w.id,['lengthM','heightM','thicknessM']));model.openings.forEach(o=>add(o.id,o.name??o.id,['widthM','heightM','offsetM','sillM']));model.rooms.forEach(r=>add(r.id,r.name,['areaM2','heightM']));model.levels.forEach(l=>add(l.id,l.name,['elevationM']));
  return {schema:'survey-accuracy-reference/1',modelId:model.id,sourceStamp:model.sourceStamp,provenance:{kind:'independent-survey',method:'',operator:'',measuredAt:'',documentRef:''},measurements};
}
