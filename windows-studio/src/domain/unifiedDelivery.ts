import {STUDIO_VERSION} from "../version";
import { zipSync, unzipSync, strToU8 } from 'fflate';
import type { CadAnnotation, CadDrawingSettings } from '../../../src/cad/model';
import { validateBuilding, buildingQuantities, type BuildingModel } from './building';
import { sourceStamp } from './buildingOps';
import { annotateSurveyDrawing, drawingFromBuilding } from './buildingDrawing';
import { createSurveyDelivery } from './delivery';
import { sha256, verifyPairedReview, type PairedReview, type PairedFrameReference } from './pairedReview';
import type { SurveySource } from './project';
import { sourceSize } from './source';
import { reportForAccuracyRecord, type AccuracyRecord } from './accuracy';
export interface IfcArtifact { bytes: Uint8Array; check: {schema:string; products:number; triangles:number} }
export async function createUnifiedDelivery(input:{source:SurveySource;model:BuildingModel;accuracy?:AccuracyRecord;review?:PairedReview;reviewIndex?:PairedFrameReference[];settings:Partial<CadDrawingSettings>;pointCount:number;annotations?:CadAnnotation[];annotationLevelId?:string;makeIfc:(m:BuildingModel)=>Promise<IfcArtifact>;checkCancelled?:()=>void}) {
  const {source,review,settings,pointCount,makeIfc}=input;
  // 固定一次输入快照；全部文件均由这一修订现生成，不拼接工作区旧导出文件。
  const model=structuredClone(input.model);
  if(model.sourceStamp!==sourceStamp(source))throw Error('模型测量依据已过期，请更新模型后生成成果包。');
  const error=validateBuilding(model).find(i=>i.code!=='UNREVIEWED');if(error)throw Error(error.message);
  const hash=source.native?.sha256??await sha256(source.bytes??await source.file!.arrayBuffer());
  if(model.sourceSha256&&model.sourceSha256!==hash)throw Error('建筑模型与源点云 SHA256 不一致。');
  model.sourceSha256=hash;
  const accuracyReport=input.accuracy?reportForAccuracyRecord(model,input.accuracy):undefined;
  const accuracy={state:input.accuracy?(accuracyReport?'current':'stale'):'not-provided',status:accuracyReport?.status,independentReference:accuracyReport?.independentReference??false,checked:accuracyReport?.counts.checked??0,failed:accuracyReport?.counts.failed??0};
  if(review)await verifyPairedReview(review,source);
  if(input.reviewIndex?.some(f=>f.sourceSha256!==hash)||input.reviewIndex&&new Set(input.reviewIndex.map(f=>f.id)).size!==input.reviewIndex.length)throw Error('原图卷索引与源件不一致。');
  if(!Number.isSafeInteger(pointCount)||pointCount<1)throw Error('缺少完整源点计数。');
  const entries:Record<string,Uint8Array>={},drawings=[];
  entries['building.json']=strToU8(JSON.stringify(model,null,2));
  const modelSha256=await sha256(entries['building.json']!.slice().buffer as ArrayBuffer);
  const ifc=await makeIfc(model);input.checkCancelled?.();
  if(ifc.check.schema!=='IFC4'||ifc.check.products<1||ifc.check.triangles<1)throw Error('IFC解析与实体几何检查未通过。');
  entries['model-review.ifc']=ifc.bytes;
  for(const [index,level] of model.levels.entries()){
    if(!model.walls.some(w=>w.levelId===level.id))continue;
    input.checkCancelled?.();
    const drawing=annotateSurveyDrawing(drawingFromBuilding(model,level.id,settings,pointCount),input.annotationLevelId===level.id?(input.annotations??[]):[]),result=await createSurveyDelivery(drawing,source);
    for(const [name,bytes] of Object.entries(unzipSync(result.archive)))entries[`cad/level-${index+1}/${name}`]=bytes;
    drawings.push(drawing);
  }
  if(!drawings.length)throw Error('模型没有可出图的墙体。');
  const issues=validateBuilding(model),observationIssues=[];
  if(!accuracyReport)observationIssues.push({elementId:model.id,code:input.accuracy?'ACCURACY_STALE':'ACCURACY_NOT_CHECKED',message:input.accuracy?'尺寸核验对应旧模型或测量范围，未混入当前成果包。':'本成果包未提供独立尺寸核验。'});
  else {
    entries['accuracy-reference.json']=strToU8(JSON.stringify(input.accuracy!.reference,null,2));
    entries['accuracy-report.json']=strToU8(JSON.stringify(accuracyReport,null,2));
    if(!accuracyReport.independentReference)observationIssues.push({elementId:model.id,code:'ACCURACY_SYNTHETIC_REFERENCE',message:'尺寸核验使用合成基准，不能作为现场实测验收。'});
    if(accuracyReport.counts.failed)observationIssues.push({elementId:model.id,code:'ACCURACY_OUT_OF_TOLERANCE',message:`尺寸核验 ${accuracyReport.counts.failed} 项超差。`});
  }
  for(const opening of model.openings)for(const k of opening.keyframes??[]){
    const indexed=input.reviewIndex?.find(f=>f.id===k.frameId),frame=indexed??review?.frames.find(f=>f.id===k.frameId),candidate=frame?.candidates.find(a=>a.id===k.candidateId);
    if((indexed?.session??review?.session)!==k.session||frame?.sha256!==k.imageSha256||!candidate)observationIssues.push({elementId:opening.id,code:'OBSERVATION_UNAVAILABLE',message:'来源原图或识别观察未随当前工程关联。'});
    else if(candidate.decision!=='retain'||(candidate.reviewedLabel??candidate.label)!==opening.kind)observationIssues.push({elementId:opening.id,code:'OBSERVATION_CHANGED',message:'关键帧复核意见与构件不一致，请重新核对。'});
  }
  entries['annotations.json']=strToU8(JSON.stringify({levelId:input.annotationLevelId??null,items:input.annotations??[],appliedToCad:!!input.annotationLevelId},null,2));
  if(input.annotations?.length&&!input.annotationLevelId)observationIssues.push({elementId:model.id,code:'ANNOTATIONS_UNASSIGNED',message:'手工标注已保留在清单中，尚未关联到模型楼层CAD。'});
  entries['quantities.json']=strToU8(JSON.stringify(buildingQuantities(model),null,2));
  const report={schema:'survey-unified-review/1',modelId:model.id,modelRevision:model.revision,modelSha256,sourceSha256:hash,purpose:'review',constructionAccepted:false,accuracy,ifcCheck:ifc.check,issues:[...issues,...observationIssues],assumptions:model.assumptions??[],captureQuality:input.reviewIndex?(input.reviewIndex.every(f=>f.captureQuality==='verified')?'verified':'partial'):review?.captureQuality??'unknown',alignmentVerified:input.reviewIndex?input.reviewIndex.every(f=>f.alignmentVerified):review?.alignmentVerified??false,limitations:['墙轴、厚高、完整门窗边界及独立尺寸须复核。','IFC解析与实体检查不等同完整EXPRESS或目标软件验收。','本包不含完整源点云和原图，原件与图像通过可恢复工程交付。']};
  entries['review.json']=strToU8(JSON.stringify(report,null,2));
  if(review)entries['keyframe-decisions.json']=strToU8(JSON.stringify({schema:'survey-keyframe-decisions/1',session:review.session,sourceSha256:review.sourceSha256,model:review.model,frames:input.reviewIndex??review.frames.map(({id,name,cameraId,sha256,inference,candidates})=>({id,name,cameraId:cameraId??'front',sha256,inference,candidates}))},null,2));
  const files=await Promise.all(Object.entries(entries).map(async([name,bytes])=>({name,bytes:bytes.length,sha256:await sha256(bytes.slice().buffer as ArrayBuffer)})));
  const manifest={schema:'survey-unified-delivery/1',software:{name:'Guanyao Survey Studio',version:'0.9.4'},createdAt:new Date().toISOString(),purpose:'review',constructionAccepted:false,accuracy,source:{name:source.name,bytes:sourceSize(source),sha256:hash,points:pointCount,units:source.units,synthetic:source.synthetic,clips:source.clips??[]},building:{id:model.id,revision:model.revision,sha256:modelSha256},levels:drawings.map(d=>({drawingId:d.drawingId,...d.parameters})),deviceReceipt:source.deviceReceipt,sourceIncluded:false,originalImagesIncluded:false,files};
  entries['manifest.json']=strToU8(JSON.stringify(manifest,null,2));
  input.checkCancelled?.();
  return {archive:zipSync(entries),manifest,report,drawings};
}
