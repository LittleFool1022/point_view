import {cadSheet,createCadSheet} from "../../../src/cad/sheet";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createCadDelivery } from "../../../src/cad/package";
import type { DrawingModel } from "../../../src/cad/model";
import type { SurveySource } from "./project";
import { sourceSize } from "./source";

/** 给旧 CAD 成果包补充本应用的大数据分析方式和源件身份。 */
export async function createSurveyDelivery(model: DrawingModel, source: SurveySource,renderPdf?:(document:{html:string;widthMm:number;heightMm:number})=>Promise<ArrayBuffer>) {
  const result = await createCadDelivery(model, "survey-drawing"), entries = unzipSync(result.archive);
  const manifestName = Object.keys(entries).find(name => name.endsWith(".manifest.json"))!;
  const manifest = JSON.parse(strFromU8(entries[manifestName]!));
  const sourceBytes=source.native?undefined:source.bytes??await source.file?.arrayBuffer();
  const sourceSha256=source.native?.sha256??(sourceBytes?[...new Uint8Array(await crypto.subtle.digest("SHA-256",sourceBytes))].map(v=>v.toString(16).padStart(2,"0")).join(""):undefined);
  if(!sourceSha256)throw Error("源点云身份缺失，无法生成交付清单。");
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
  const reviewName="survey-drawing/review.json";
  const reviewBytes=strToU8(JSON.stringify({schema:"survey-cad-review/1",purpose:"review",constructionAccepted:false,drawingId:model.drawingId,sourceSha256,units:"mm",scale:model.scale,paperSize:model.paperSize,plot:manifest.plot,dimensions:{native:model.dimensions?.length??0,legacyGraphics:model.entities.filter(e=>e.category==='dimension'&&!e.metadata?.dimensionId).length,roundingMm:model.parameters.roundingMm},checks:{registration:model.accuracy.registrationStatus,independentFieldDimensions:"not-verified",targetCadApplication:"not-verified"},warnings:model.warnings.filter(w=>w.severity!=="info")},null,2));
  const reviewHash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",reviewBytes.slice().buffer as ArrayBuffer))].map(b=>b.toString(16).padStart(2,"0")).join("");
  entries[reviewName]=reviewBytes;manifest.files.push({name:"review.json",size:reviewBytes.length,mime:"application/json",sha256:reviewHash});
  entries[name] = bytes; manifest.files.push({ name: "analysis.json", size: bytes.length, mime: "application/json", sha256 });
  entries[manifestName] = strToU8(JSON.stringify(manifest, null, 2));
  return { ...result, archive: zipSync(entries),plot:manifest.plot };
}
