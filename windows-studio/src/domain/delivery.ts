import {cadSheet,createCadSheet} from "../../../src/cad/sheet";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createCadDelivery } from "../../../src/cad/package";
import type { DrawingModel } from "../../../src/cad/model";
import { reportForDimensionVerification, type DimensionVerificationRecord } from "./dimensionVerification";
import type { SurveySource } from "./project";
import { sourceSize } from "./source";

export interface SurveyCadPackageOptions {
  /** 独立尺寸核验记录；缺省或已过期时成果包明确标为未核验。 */
  dimensionVerification?: DimensionVerificationRecord;
  /** 导出后发现的问题（例如回读差异告警），随复核清单导出。 */
  blockingIssues?: string[];
}
/** 给旧 CAD 成果包补充本应用的大数据分析方式、源件身份、尺寸核验与复核清单。 */
export async function createSurveyDelivery(model: DrawingModel, source: SurveySource,renderPdf?:(document:{html:string;widthMm:number;heightMm:number})=>Promise<ArrayBuffer>,options: SurveyCadPackageOptions={}) {
  const result = await createCadDelivery(model, "survey-drawing"), entries = unzipSync(result.archive);
  const manifestName = Object.keys(entries).find(name => name.endsWith(".manifest.json"))!;
  const manifest = JSON.parse(strFromU8(entries[manifestName]!));
  const sourceBytes=source.native?undefined:source.bytes??await source.file?.arrayBuffer();
  const sourceSha256=source.native?.sha256??(sourceBytes?[...new Uint8Array(await crypto.subtle.digest("SHA-256",sourceBytes))].map(v=>v.toString(16).padStart(2,"0")).join(""):undefined);
  if(!sourceSha256)throw Error("源点云身份缺失，无法生成交付清单。");
  // 尺寸核验绑定到工程里的源件身份：桌面句柄哈希或浏览器内计算哈希，不重新换算。
  const projectSourceSha256=source.native?.sha256??source.bytesSha256??sourceSha256;
  const name = "survey-drawing/analysis.json";
  const bytes = strToU8(JSON.stringify({ source: { name: source.name, bytes: sourceSize(source), sha256: sourceSha256, synthetic: source.synthetic, clips: source.clips ?? [], deviceReceipt: source.deviceReceipt }, sourcePointCount: model.statistics.sourcePointCount, parameters: model.parameters, drawingCoordinateSystem: model.drawingCoordinateSystem, warnings: model.warnings }, null, 2));
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer))].map(b => b.toString(16).padStart(2, "0")).join("");
  const sheet=cadSheet(model);
  const add=async(name:string,data:Uint8Array,mime:string)=>{const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data.slice().buffer as ArrayBuffer))].map(v=>v.toString(16).padStart(2,'0')).join('');entries['survey-drawing/'+name]=data;manifest.files.push({name,size:data.length,mime,sha256});};
  if(!sheet.outsideEntityIds.length&&!sheet.titleOverlapEntityIds.length){
    const vector=createCadSheet(model);
    await add('sheet.svg',strToU8(vector.svg),'image/svg+xml');
    await add('sheet.html',strToU8(vector.html),'text/html');
    if(renderPdf)await add('sheet.pdf',new Uint8Array(await renderPdf({html:vector.html,widthMm:sheet.widthMm,heightMm:sheet.heightMm})),'application/pdf');
  }
  manifest.plot={...sheet,modelUnits:'mm',paperUnits:'mm',modelLayoutScale:`1:${sheet.denominator}`,paperLayoutScale:'1:1',pdfIncluded:!!entries['survey-drawing/sheet.pdf']};
  const verification=options.dimensionVerification?reportForDimensionVerification(model,options.dimensionVerification,projectSourceSha256):undefined;
  const verificationStale=!!options.dimensionVerification&&!verification;
  const independentFieldDimensions=verification?.status??"not-verified";
  const reviewName="survey-drawing/review.json";
  const reviewBytes=strToU8(JSON.stringify({schema:"survey-cad-review/1",purpose:"review",constructionAccepted:false,drawingId:model.drawingId,sourceSha256,units:"mm",scale:model.scale,paperSize:model.paperSize,plot:manifest.plot,dimensions:{native:model.dimensions?.length??0,legacyGraphics:model.entities.filter(e=>e.category==='dimension'&&!e.metadata?.dimensionId).length,roundingMm:model.parameters.roundingMm,independentVerification:verification?"survey-drawing/dimension-verification.json":verificationStale?"stale-excluded":"not-provided"},checks:{registration:model.accuracy.registrationStatus,independentFieldDimensions,targetCadApplication:"not-verified"},warnings:model.warnings.filter(w=>w.severity!=="info"),blockingIssues:options.blockingIssues??[]},null,2));
  const reviewHash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",reviewBytes.slice().buffer as ArrayBuffer))].map(b=>b.toString(16).padStart(2,"0")).join("");
  entries[reviewName]=reviewBytes;manifest.files.push({name:"review.json",size:reviewBytes.length,mime:"application/json",sha256:reviewHash});
  entries[name] = bytes; manifest.files.push({ name: "analysis.json", size: bytes.length, mime: "application/json", sha256 });
  // 核验报告与参考值随成果包导出，不含独立实测时写明确的未核验记录。
  const dimensionName="survey-drawing/dimension-verification.json";
  const dimensionBytes=strToU8(JSON.stringify(verification??{schema:"survey-dimension-verification/1",drawingId:model.drawingId,sourceSha256,status:"not-verified",reason:verificationStale?"核验记录与当前图纸或源件不一致，已排除旧结论。":"缺少独立实测参考值。",constructionAccepted:false},null,2));
  const dimensionHash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",dimensionBytes.slice().buffer as ArrayBuffer))].map(v=>v.toString(16).padStart(2,"0")).join("");
  entries[dimensionName]=dimensionBytes;manifest.files.push({name:"dimension-verification.json",size:dimensionBytes.length,mime:"application/json",sha256:dimensionHash});
  entries[manifestName] = strToU8(JSON.stringify(manifest, null, 2));
  return { ...result, archive: zipSync(entries),plot:manifest.plot };
}
