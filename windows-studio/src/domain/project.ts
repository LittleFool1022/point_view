import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { validateDrawingModel, type DrawingModel, type CadAnnotation, type CadDrawingSettings } from "../../../src/cad/model";
import type { CadProjection } from "../../../src/cad/geometry";
import type { SourceUnit } from "../pipeline/analysis";
import { sourceSize, type SourceInput } from "./source";
import { validateClips, type ClipRule } from "./cleaning";
import { REVIEW_CODES, assertBuildingShape, validateBuilding, type BuildingModel } from "./building";
import { assertRenderScene, type RenderSceneSettings } from "./renderScene";
import { assertPairedReview, verifyPairedReview, type PairedReview, type PairedFrameReference } from "./pairedReview";
import { assertDeviceReceipt } from "./device";
import { assertAccuracyRecord, reportForAccuracyRecord, type AccuracyRecord } from "./accuracy";
export interface SurveySource extends SourceInput { clips?: ClipRule[]; units: SourceUnit; synthetic: boolean }
export interface SurveyProject { source: SurveySource; accuracy?:AccuracyRecord; pairedReview?: PairedReview; activeKeyframePage?:string; pairedReviewIndex?:PairedFrameReference[]; building?: BuildingModel; renderScene?:RenderSceneSettings; drawing?: DrawingModel; drawingStale?:boolean; annotations: CadAnnotation[]; projection: CadProjection; settings: Partial<CadDrawingSettings> }
const LIMIT = 256 * 1024 * 1024;
async function hash(bytes: ArrayBuffer) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join(""); }
export async function encodeProject(project: SurveyProject): Promise<Uint8Array> {
  if (sourceSize(project.source) > LIMIT || project.source.native) throw Error("大工程请在 Windows 文件流模式下保存。");
  const bytes = project.source.bytes ?? await project.source.file?.arrayBuffer();
  if (!bytes) throw Error("工程缺少源数据。");
  if (project.pairedReview) await verifyPairedReview(project.pairedReview, project.source);
  const manifest = { schema: "survey-project/1", source: { name: project.source.name, units: project.source.units, synthetic: project.source.synthetic, clips: project.source.clips, sha256: await hash(bytes), deviceReceipt: project.source.deviceReceipt }, accuracy:project.accuracy, projection: project.projection, settings: project.settings, annotations: project.annotations, drawing: project.drawing, drawingStale:project.drawingStale, building: project.building, renderScene: project.renderScene, pairedReview: project.pairedReview };
  if(project.accuracy){assertAccuracyRecord(project.accuracy);if(project.building)reportForAccuracyRecord(project.building,project.accuracy);}
  if(manifest.source.deviceReceipt)assertDeviceReceipt(manifest.source.deviceReceipt,manifest.source);
  return zipSync({ "project.json": strToU8(JSON.stringify(manifest)), "source.bin": new Uint8Array(bytes) });
}
export function validateProjectState(m: any) {
  if (!["survey-project/1", "survey-project/2", "survey-project/3"].includes(m?.schema) || typeof m.source?.name !== "string" || !["m", "mm"].includes(m.source.units) || typeof m.source.synthetic !== "boolean" || !["xy", "xz", "yz"].includes(m.projection) || !Array.isArray(m.annotations) || !m.settings || typeof m.settings !== "object") throw Error("不是支持的测量工程。");
  if(m.schema==="survey-project/3" && (!Array.isArray(m.pairedReviewIndex) || !m.pairedReviewIndex.length || typeof m.activeKeyframePage!=="string"))throw Error("工程关键帧卷尚未完整校验。");
  if(m.drawingStale!==undefined&&typeof m.drawingStale!=="boolean")throw Error("图纸更新状态无效。");
  validateClips(m.source.clips ?? []);
  if(m.source.deviceReceipt)assertDeviceReceipt(m.source.deviceReceipt,m.source);
  if(m.pairedReview)assertPairedReview(m.pairedReview);
  if(m.renderScene)assertRenderScene(m.renderScene);
  // 人工复核记录（确认洞口、人工墙段、软删除留痕）随工程保存并在检查中可见，不作为几何或关联错误拒绝打开。
  if(m.building) { assertBuildingShape(m.building); if(validateBuilding(m.building).some(i=>i.code!=="UNREVIEWED"&&!REVIEW_CODES.includes(i.code))) throw Error("工程建筑模型几何或关联关系无效。"); }
  if(m.accuracy){assertAccuracyRecord(m.accuracy);if(m.building)reportForAccuracyRecord(m.building,m.accuracy);}
  for (const o of m.building?.openings ?? []) for (const k of o.keyframes ?? []) {
    if(k.sourceSha256!==m.source.sha256) throw Error("门窗关键帧与工程原件不一致。");
    if(m.pairedReview) {
      const frame=(m.pairedReviewIndex??m.pairedReview.frames).find((f:any)=>f.id===k.frameId);
      if(k.session!==(frame?.session??m.pairedReview.session) || (frame?.sourceSha256 && frame.sourceSha256!==m.source.sha256) || !frame || frame.sha256!==k.imageSha256 || !frame.candidates.some((c:any)=>c.id===k.candidateId)) throw Error("门窗关键帧来源无法在工程中恢复。");
    }
  }
  for (const a of m.annotations) if (typeof a.text !== "string" || !Number.isFinite(a.x) || !Number.isFinite(a.y) || ![undefined, "text", "room", "door", "window"].includes(a.category)) throw Error("工程标注数据无效。");
  if (m.drawing && !validateDrawingModel(m.drawing).valid) throw Error("工程图纸数据无效。");
}
export async function decodeProject(buffer: ArrayBuffer): Promise<SurveyProject> {
  const entries = unzipSync(new Uint8Array(buffer), { filter: file => ["project.json", "source.bin"].includes(file.name) && file.originalSize <= LIMIT });
  if (!entries["project.json"] || !entries["source.bin"]) throw Error("工程缺少源文件或清单，或超过容量限制。");
  const m = JSON.parse(strFromU8(entries["project.json"]));
  validateProjectState(m);
  const bytes = entries["source.bin"].slice().buffer as ArrayBuffer;
  if (await hash(bytes) !== m.source.sha256) throw Error("工程源文件校验失败，未替换当前工程。");
  const source = { name: m.source.name, units: m.source.units, synthetic: m.source.synthetic, clips: m.source.clips, deviceReceipt: m.source.deviceReceipt, bytes };
  if(source.deviceReceipt)assertDeviceReceipt(source.deviceReceipt,{name:source.name,sha256:m.source.sha256,size:bytes.byteLength});
  if(m.pairedReview)await verifyPairedReview(m.pairedReview,source);
  return { source, accuracy:m.accuracy, pairedReview:m.pairedReview, building: m.building, renderScene:m.renderScene, drawing: m.drawing, drawingStale:m.drawingStale, annotations: m.annotations, projection: m.projection, settings: m.settings };
}
