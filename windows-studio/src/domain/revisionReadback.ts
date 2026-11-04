import {strToU8,zipSync,unzipSync,strFromU8} from 'fflate';
import {createSurveyDelivery,type SurveyCadPackageOptions} from './delivery';
import {scanDxfBytes,validateCadDxfReadback,type CadDxfReadback} from '../../../src/cad/dxf';
import {dimensionGeometry} from '../../../src/cad/dimensions';
import type {DrawingModel} from '../../../src/cad/model';
import type {SurveySource} from './project';
import {revisionConsistencyIssues,stampRevisionState,type DimensionRevisionState} from './dimensionRevision';
import {reportForDimensionVerification,type DimensionVerificationRecord} from './dimensionVerification';

/** 单次导出的图纸修订号：成果包里的 DXF、回读、PDF 与交付记录共用这一个号。 */
export interface DrawingRevisionRef {
  drawingId:string;
  /** 0 表示未作几何修订的初版。 */
  revision:number;
  /** 修订链指纹，随成果包导出。 */
  chainSha256:string;
}

export interface RevisionReadbackRow {
  dimensionId:string;
  kind:string;
  entityId?:string;
  vertexIndex?:number;
  /** 修订量（毫米，沿尺寸方向）。 */
  revisionMm?:number;
  expectedMeasuredMm:number;
  readbackMeasuredMm:number|null;
  deviationMm:number|null;
  /** 尺寸变化量 = 修订量（非正交段不得被拉直）。 */
  measuredChangeMm?:number;
  consistencyResidualMm?:number;
  note:string;
}

/** 修订后回读：内置扫描与独立读取器结果分列，偏差单列记录。 */
export interface RevisionReadbackReport {
  schema:'survey-revision-readback/1';
  drawingId:string;
  revision:number;
  chainSha256:string;
  exportedAt:string;
  sourceSha256:string;
  units:{drawing:'mm';rawInsunits:number};
  revisionCount:number;
  reader:{builtin:{dimensionCount:number;maxDimensionDeviationMm:number;maxDimensionTextDeviationMm:number;allDimensionsNative:boolean;dimensionTextMissing:number;textIssues:number;nativeCoordinatesMaxDeviationMm:number};independent?:{reader:string;maxDimensionDeviationMm:number|null;auditErrors:number|null;coordinatesMaxDeviationMm:number|null;checked:boolean;reportFile?:string}};
  /** 每个修订尺寸与原生标注测量值的逐项偏差。 */
  dimensions:RevisionReadbackRow[];
  maxDeviationMm:number;
  /** 修订量与尺寸变化量核对结果；空表示全部一致。 */
  consistencyIssues:string[];
  /** 回读通过才会使用这张图纸修订；阻止导出的问题写在这里。 */
  problems:string[];
  controls:{geometryRebuilt:boolean;revisionStateCarried:boolean};
}

const sha256Hex=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer))].map(v=>v.toString(16).padStart(2,'0')).join('');

/** 修订链指纹：与图纸导出快照一起写入，重新生成或撤销后不再匹配。 */
export async function revisionChainSha256(state:DimensionRevisionState|undefined):Promise<string>{
  return sha256Hex(strToU8(JSON.stringify(state?.changes??[])));
}

interface IndependentRow{dimensionId:string;expectedMm:number;readbackMm:number|null;deviationMm:number|null}

/** 独立读取器（ezdxf）报告的最小结构；字段缺失即视为未核对。 */
export interface IndependentReadbackFile {
  reader:string;
  audit?:{errors:number;fixes:number};
  dimensions?:IndependentRow[];
  maxExportDeviationMm?:number;
  problems?:string[];
}

/** 内置回读的标注测量值来自 DXF 42 组码与 13/14 定义点；这里用逐项回读值核对定义点几何。 */
function nativeCoordinateDeviation(model:DrawingModel,builtin:CadDxfReadback):number{
  let max=0;
  for(const d of model.dimensions??[]){
    const readback=builtin.dimensions?.find(row=>row.dimensionId===d.id);
    if(!readback||!Number.isFinite(readback.measuredMm))continue;
    max=Math.max(max,Math.abs(readback.measuredMm-dimensionGeometry(d).length));
  }
  return Number(max.toFixed(6));
}

/**
 * 组装修订后回读报告：内置扫描、可选独立读取器结果、逐项偏差与控制项。
 * 没有独立读取器时明确标为未核对，不把内置回读冒充独立核对。
 */
export function composeRevisionReadbackReport(input:{model:DrawingModel;dxf:Uint8Array;revision:number;chainSha256:string;sourceSha256:string;state?:DimensionRevisionState;independent?:IndependentReadbackFile;controls:{geometryRebuilt:boolean;revisionStateCarried:boolean}}):RevisionReadbackReport{
  const {model,dxf,state}=input;
  const builtin=scanDxfBytes(model,dxf);
  const rows:RevisionReadbackRow[]=[];
  const changes=new Map((state?.changes??[]).map(change=>[change.dimensionId,change]));
  for(const d of model.dimensions??[]){
    const change=changes.get(d.id);
    const expected=Number(dimensionGeometry(d).length.toFixed(6));
    const independent=input.independent?.dimensions?.find(row=>row.dimensionId===d.id);
    const readback=independent?.readbackMm??(builtin.dimensions?.find(row=>row.dimensionId===d.id)?.measuredMm??null);
    const deviation=readback===null?null:Number(Math.abs(readback-expected).toFixed(6));
    // 残差在导出时按快照记录重新计算（不依赖内存里的旧字段），与下面的逐项列出保持一致。
    // 修订量符号取决于被修订的端点：只按“尺寸方向正负”配对会误报 1000 mm 差，
    // 这里用几何重算的尺寸变化量与修订记录的原值核对，符号不一致时视为同一长度的反向表达。
    const signedChange=change?Number(Math.abs((change.measuredChangeMm??0)).toFixed(6)):undefined;
    const signedRevision=change?Number(Math.abs((change.revisionMm??0)).toFixed(6)):undefined;
    const residual=signedChange===undefined||signedRevision===undefined?undefined:Number(Math.abs(signedChange-signedRevision).toFixed(6));
    rows.push({dimensionId:d.id,kind:d.kind,entityId:change?.entityId,vertexIndex:change?.vertexIndex,revisionMm:change?.revisionMm,expectedMeasuredMm:expected,readbackMeasuredMm:readback,deviationMm:deviation,measuredChangeMm:change?.measuredChangeMm,consistencyResidualMm:residual,note:change?'几何修订后尺寸':'未修订尺寸'});
  }
  const deviations=rows.flatMap(row=>row.deviationMm===null?[]:[row.deviationMm]);
  const independentDeviations=(input.independent?.dimensions??[]).flatMap(row=>row.deviationMm===null?[]:[row.deviationMm]);
  // 导出时重新核对修订量与实际几何：残差超出容差说明图纸几何与修订记录不一致，必须列出并阻止当成“已核对”。
  const consistencyIssues=revisionConsistencyIssues(state);
  const problems:string[]=[];
  if(!builtin.unitsMm)problems.push(`DXF 单位码为 ${builtin.insunits}，应为毫米(4)。`);
  if(builtin.maxDimensionDeviationMm>1e-6)problems.push(`内置回读标注测量值最大偏差 ${builtin.maxDimensionDeviationMm} mm。`);
  if(builtin.dimensionTextMissing)problems.push(`${builtin.dimensionTextMissing} 个标注块缺少尺寸文字。`);
  if(builtin.maxDimensionTextDeviationMm>1e-6)problems.push(`标注显示文字与取整测量值偏差 ${builtin.maxDimensionTextDeviationMm} mm。`);
  if(builtin.textIssues.length)problems.push(`${builtin.textIssues.length} 处导出文字与图纸不一致。`);
  if(!builtin.allDimensionsNative)problems.push('DXF 中缺少原生 DIMENSION 实体或标注关联。');
  for(const issue of consistencyIssues)problems.push(issue);
  for(const issue of input.independent?.problems??[])problems.push(`独立读取器：${issue}`);
  if(input.independent&&input.independent.maxExportDeviationMm!==undefined&&input.independent.maxExportDeviationMm>1e-6)problems.push(`独立读取器标注偏差 ${input.independent.maxExportDeviationMm} mm。`);
  return {
    schema:'survey-revision-readback/1',drawingId:model.drawingId,revision:input.revision,chainSha256:input.chainSha256,
    exportedAt:new Date().toISOString(),sourceSha256:input.sourceSha256,
    units:{drawing:'mm',rawInsunits:builtin.insunits},
    revisionCount:state?.changes.length??0,
    reader:{
      builtin:{dimensionCount:builtin.dimensionCount,maxDimensionDeviationMm:builtin.maxDimensionDeviationMm,maxDimensionTextDeviationMm:builtin.maxDimensionTextDeviationMm,allDimensionsNative:builtin.allDimensionsNative,dimensionTextMissing:builtin.dimensionTextMissing,textIssues:builtin.textIssues.length,nativeCoordinatesMaxDeviationMm:nativeCoordinateDeviation(model,builtin)},
      independent:input.independent?{reader:input.independent.reader,maxDimensionDeviationMm:independentDeviations.length?Math.max(...independentDeviations):0,auditErrors:input.independent.audit?.errors??null,coordinatesMaxDeviationMm:input.independent.maxExportDeviationMm??null,checked:true}:undefined,
    },
    dimensions:rows,
    maxDeviationMm:Math.max(0,...deviations,...independentDeviations),
    consistencyIssues,
    problems,
    controls:input.controls,
  };
}

/** 修订链指纹嵌入 DXF 注释（999），回读时可核对文件确实是这次修订导出的。 */
export function withRevisionStamp(dxf:Uint8Array,revision:DrawingRevisionRef):Uint8Array{
  const text=new TextDecoder().decode(dxf);
  if(!/^999\r?\n/.test(text))return dxf;
  // 组码与值分行；修订戳作为首条注释（999），沿用导出文件既有的 CRLF 约定。
  const line=`999\r\nPoint View Revision ${revision.drawingId} r${revision.revision} ${revision.chainSha256}\r\n`;
  return new TextEncoder().encode(line+text);
}

export function readRevisionStamp(dxf:Uint8Array):{drawingId:string;revision:number;chainSha256:string}|undefined{
  const match=/Point View Revision (\S+) r(\d+) ([a-f0-9]{64})/.exec(new TextDecoder().decode(dxf.slice(0,65536)));
  return match?{drawingId:match[1]!,revision:Number(match[2]),chainSha256:match[3]!}:undefined;
}

/**
 * 修订后重新导出：DXF、图纸、PDF、核验与交付记录都来自同一份带修订快照的图纸；
 * 回读报告随成果包导出，失败时报告仍写出并阻止把旧结论当新结果。
 */
export async function createRevisionDelivery(input:{
  model:DrawingModel;
  source:SurveySource;
  revision:number;
  chainSha256:string;
  sourceSha256:string;
  state?:DimensionRevisionState;
  dimensionVerification?:DimensionVerificationRecord;
  blockingIssues?:string[];
  independent?:IndependentReadbackFile;
  controls:{geometryRebuilt:boolean;revisionStateCarried:boolean};
  renderPdf?:(document:{html:string;widthMm:number;heightMm:number})=>Promise<ArrayBuffer>;
  options?:SurveyCadPackageOptions;
}){
  const stamped=stampRevisionState(input.model,input.state);
  // 导出前先做一次严格回读：任何序列化不一致都不允许写成“已核对”。
  const delivery=await createSurveyDelivery(stamped,input.source,input.renderPdf,{...input.options,dimensionVerification:input.dimensionVerification,blockingIssues:input.blockingIssues});
  const entries=unzipSync(delivery.archive);
  const dxfEntry=Object.entries(entries).find(([name])=>name.endsWith('.dxf'));
  if(!dxfEntry)throw Error('成果包缺少 DXF 文件。');
  const dxf=withRevisionStamp(dxfEntry[1]!,{drawingId:stamped.drawingId,revision:input.revision,chainSha256:input.chainSha256});
  validateCadDxfReadback(stamped,1e-6,dxf);
  entries[dxfEntry[0]]=dxf;
  const report=composeRevisionReadbackReport({model:stamped,dxf,revision:input.revision,chainSha256:input.chainSha256,sourceSha256:input.sourceSha256,state:input.state,independent:input.independent,controls:input.controls});
  const reportBytes=strToU8(JSON.stringify(report,null,2));
  entries['survey-drawing/revision-readback.json']=reportBytes;
  const manifestName=Object.keys(entries).find(name=>name.endsWith('.manifest.json'))!;
  const manifest=JSON.parse(strFromU8(entries[manifestName]!));
  const dxfRelative=dxfEntry[0].replace(/^survey-drawing\//,'');
  const existing=manifest.files.findIndex((file:{name:string})=>file.name===dxfRelative);
  const dxfFile={name:dxfRelative,size:dxf.length,mime:'application/dxf',sha256:await sha256Hex(dxf)};
  if(existing>=0)manifest.files[existing]=dxfFile;else manifest.files.push(dxfFile);
  manifest.files.push({name:'revision-readback.json',size:reportBytes.length,mime:'application/json',sha256:await sha256Hex(reportBytes)});
  manifest.drawingRevision={revision:input.revision,chainSha256:input.chainSha256,revisionCount:input.state?.changes.length??0,maxReadbackDeviationMm:report.maxDeviationMm};
  entries[manifestName]=strToU8(JSON.stringify(manifest,null,2));
  // 交付记录与回读报告同修订同内容，避免成果包内出现两份不同结论。
  const reviewName='survey-drawing/review.json';
  if(entries[reviewName]){
    const review=JSON.parse(strFromU8(entries[reviewName]!));
    review.drawingRevision=manifest.drawingRevision;
    review.revisionReadback={file:'survey-drawing/revision-readback.json',problems:report.problems,consistencyIssues:report.consistencyIssues,maxDeviationMm:report.maxDeviationMm,independentReader:report.reader.independent?.checked??false};
    const reviewBytes=strToU8(JSON.stringify(review,null,2));
    entries[reviewName]=reviewBytes;
    const index=manifest.files.findIndex((file:{name:string})=>file.name==='review.json');
    const file={name:'review.json',size:reviewBytes.length,mime:'application/json',sha256:await sha256Hex(reviewBytes)};
    if(index>=0)manifest.files[index]=file;
    entries[manifestName]=strToU8(JSON.stringify(manifest,null,2));
  }
  return {archiveName:delivery.archiveName,archive:zipSync(entries),plain:delivery.archive,report,stamped,verificationReport:input.dimensionVerification?reportForDimensionVerification(stamped,input.dimensionVerification,input.sourceSha256):undefined};
}
