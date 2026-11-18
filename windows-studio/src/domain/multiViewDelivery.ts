import { PDFDocument } from "pdf-lib";
import { strToU8, zipSync } from "fflate";
import { cadSheet, createCadSheet } from "../../../src/cad/sheet";
import { createMultiViewDrawing, MULTI_VIEW_ORDER, assertMultiViewModels, type MultiViewModels } from "../../../src/cad/multiView";
import { exportCadDxf } from "../../../src/cad/dxf";
import type { DrawingModel } from "../../../src/cad/model";
import type { CadProjection } from "../../../src/cad/geometry";
import { createAnnotationPayload } from "../../../src/cad/package";
import { createSurveyEvidence, surveySourceSha256 } from "./delivery";
import type { SurveySource } from "./project";

type RenderPdf = (document: { html: string; widthMm: number; heightMm: number }) => Promise<ArrayBuffer>;
const LABELS: Record<CadProjection, string> = { xy: "俯视图", xz: "正视图", yz: "侧视图" };

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function combinedDrawing(models:MultiViewModels,edited?:DrawingModel):DrawingModel{
  const combined=edited??createMultiViewDrawing(models);
  if(combined.parameters.analysisMode!=="point-cloud-multi-view")throw Error("交付图纸不是三视总图，已拒绝导出。");
  return combined;
}

function assertPlotFits(combined:DrawingModel):void{
  const plot=cadSheet(combined);
  if(plot.outsideEntityIds.length||plot.titleOverlapEntityIds.length)throw Error("三视总图存在超框或标题栏重叠，请先调整图幅和比例，再导出。");
}

function multiViewHtml(combined:DrawingModel):string{return createCadSheet(combined).html;}

/** 总 DXF、SVG 与单页 PDF 共用当前整体编辑后的合成模型。 */
export async function renderMultiViewPdf(models: MultiViewModels, renderPdf: RenderPdf, edited?:DrawingModel): Promise<Uint8Array> {
  assertMultiViewModels(models);
  const combined=combinedDrawing(models,edited);assertPlotFits(combined);
  const vector=createCadSheet(combined);
  const source=await PDFDocument.load(await renderPdf({html:vector.html,widthMm:vector.sheet.widthMm,heightMm:vector.sheet.heightMm}));
  if(source.getPageCount()!==1)throw Error(`三视总图 PDF 应为单页，实际为 ${source.getPageCount()} 页，已中止导出。`);
  source.setTitle("建筑测绘三视总图");
  return source.save();
}

export async function createMultiViewSurveyDelivery(models: MultiViewModels, source: SurveySource, renderPdf?: RenderPdf, edited?:DrawingModel) {
  const combined=combinedDrawing(models,edited);assertPlotFits(combined);
  const entries: Record<string, Uint8Array> = {}, files: Array<{ name: string; size: number; mime: string; sha256?: string }> = [];
  const add = async (name: string, data: Uint8Array, mime: string) => {
    entries[`survey-drawing/${name}`] = data;
    files.push({ name, size: data.byteLength, mime, sha256: await sha256(data) });
  };
  const sourceSha256 = await surveySourceSha256(source);
  assertMultiViewModels(models,sourceSha256);
  if(combined.sourceSha256!==sourceSha256)throw Error("三视总图与交付源件 SHA-256 不一致，请重新生成图纸。");
  for (const projection of MULTI_VIEW_ORDER) {
    const evidence=createSurveyEvidence(models[projection],source,sourceSha256);
    await add(`${projection}/analysis.json`,strToU8(JSON.stringify(evidence.analysis,null,2)),"application/json");
  }
  const evidence=createSurveyEvidence(combined,source,sourceSha256,!!renderPdf);
  await add("multiview.annotations.json",strToU8(JSON.stringify(createAnnotationPayload(combined),null,2)),"application/json");
  await add("analysis.json",strToU8(JSON.stringify(evidence.analysis,null,2)),"application/json");
  await add("review.json",strToU8(JSON.stringify(evidence.review,null,2)),"application/json");
  const vector=createCadSheet(combined);
  await add("multiview.dxf",exportCadDxf(combined),"application/dxf");
  await add("multiview.svg",strToU8(vector.svg),"image/svg+xml");
  await add("multiview.html",strToU8(multiViewHtml(combined)),"text/html");
  if (renderPdf) await add("multiview.pdf", await renderMultiViewPdf(models, renderPdf,combined), "application/pdf");
  const manifest = {
    schemaVersion: "point-view-cad-multiview-manifest/1.1.0",
    purpose: "review", constructionAccepted: false, units: "mm", sourceSha256,
    combinedDrawingId:combined.drawingId,
    views: MULTI_VIEW_ORDER.map(projection => ({ projection, label: LABELS[projection], drawingId: models[projection].drawingId, view: models[projection].view })),
    modelSpaceLayout: "plan-front-side-horizontal-unscaled-millimeter-offsets", editing:"combined",pdfPageCount:1,pdfIncluded:!!renderPdf,files,
  };
  const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
  entries["survey-drawing/multiview.manifest.json"] = manifestBytes;
  files.push({ name: "multiview.manifest.json", size: manifestBytes.byteLength, mime: "application/json" });
  return { archiveName: "survey-multiview.zip", archive: zipSync(entries, { level: 6 }), plot: { outsideEntityIds: [], titleOverlapEntityIds: [], views: [...MULTI_VIEW_ORDER], pdfIncluded: !!renderPdf } };
}
