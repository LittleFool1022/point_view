import {it,expect} from 'vitest';
import {assessAccuracy,accuracyReferenceTemplate,type AccuracyReference} from '../src/domain/accuracy';
import {newBuilding,manualEvidence} from '../src/domain/buildingOps';
function fixture(){const m=newBuilding({name:'known.pcd',bytes:new ArrayBuffer(0),units:'m',synthetic:true},{levelName:'L1',elevationM:0,heightM:3,thicknessM:.2});m.walls=[{id:'w1',levelId:m.levels[0]!.id,axisM:[[0,0],[10.02,0]],heightM:3,thicknessM:.2,evidence:manualEvidence(m)}];return m;}
function reference(m=fixture()):AccuracyReference{return {schema:'survey-accuracy-reference/1',modelId:m.id,sourceStamp:m.sourceStamp!,provenance:{kind:'synthetic',method:'known geometry',operator:'fixture',measuredAt:'2026-10-22',documentRef:'synthetic-test'},measurements:[{elementId:'w1',metric:'lengthM',reference:10,tolerance:.03,uncertainty:.005}]};}
it('有符号误差与测量不确定度共同判定，不把样本通过或合成基准当成施工放行',()=>{
 const m=fixture(),r=reference(m),report=assessAccuracy(m,r);expect(report.results[0]!.error).toBeCloseTo(.02);expect(report.results[0]!.guardedError).toBeCloseTo(.025);expect(report.status).toBe('sample-within-tolerance');expect(report.independentReference).toBe(false);expect(report.constructionAccepted).toBe(false);
 r.measurements[0]!.uncertainty=.02;expect(assessAccuracy(m,r).status).toBe('sample-out-of-tolerance');r.provenance.kind='independent-survey';expect(assessAccuracy(m,r).independentReference).toBe(true);expect(assessAccuracy(m,r).constructionAccepted).toBe(false);
});
it('拒绝错误来源、非法或重复核验项；模板不预填模型值作为真值',()=>{
 const m=fixture(),r=reference(m),template=accuracyReferenceTemplate(m);expect(template.measurements.every(v=>v.reference===null&&v.tolerance===null&&v.uncertainty===null)).toBe(true);expect(()=>assessAccuracy(m,template as any)).toThrow();
 expect(()=>assessAccuracy(m,{...r,sourceStamp:'other'})).toThrow('来源');expect(()=>assessAccuracy(m,{...r,modelId:'other'})).toThrow('来源');expect(()=>assessAccuracy(m,{...r,measurements:[...r.measurements,...r.measurements]})).toThrow('重复');
 for(const delta of [{uncertainty:-1},{tolerance:0},{reference:NaN},{elementId:'missing'},{metric:'areaM2'}])expect(()=>assessAccuracy(m,{...r,measurements:[{...r.measurements[0]!,...delta} as any]})).toThrow();
});
