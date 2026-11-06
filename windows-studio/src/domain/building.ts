import { validOpeningDesign, openingTemplate, type OpeningDesign } from "./openingTemplates";
/** 建筑语义采用米制、Z向上；墙轴线与源点云共用工程坐标。 */
export type Vec2 = [number, number];
export type Evidence = { kind: "measured" | "inferred" | "manual"; sourceAssetId: string; revision: number; confirmed: boolean };
export interface Level { id: string; name: string; elevationM: number }
export interface Wall { id: string; name?: string; levelId: string; axisM: [Vec2, Vec2]; heightM: number; thicknessM: number; evidence: Evidence; source?: WallSource; removed?: WallRemoval }
/**
 * 墙段来源：自动拟合/墙网候选与人工新增、人工修改可区分。人工改动过的墙段不再属于自动结果，
 * 重新拟合时按工程复核设定处理（`reviewPolicy`）。
 */
export interface WallSource { kind: "fit" | "manual"; origin: "fit" | "manual"; at: string; issueId?: string; actionId?: string }
/** 软删除留痕：被删墙段不再参与墙网与房间，但保留原几何与来源，且可撤销。 */
export interface WallRemoval { at: string; operator: "manual"; reason: string; issueId?: string; actionId?: string; wall: Wall }
export type ReviewActionKind = "connect" | "add-wall" | "remove-wall" | "resolved-opening";
/** 人工复核处置记录：未闭合项、动作、操作者来源=人工、时间与处置前后房间数。 */
export interface ReviewAction {
  id: string; issueId?: string; action: ReviewActionKind; operator: "manual"; at: string; source: "review";
  levelId: string; roomsBefore: number; roomsAfter: number; wallIds: string[]; note: string;
}
/** 重新自动拟合时对人工构件的处理：`block-on-fit` 缺省，拟合前列出将失效的人工项并阻断；`rehang` 保留并重新挂接。 */
export type ReviewPolicy = "rehang" | "block-on-fit";
export interface OpeningDetection { method:'wall-elevation/1'; cellM:number; slabM:number; sourcePoints:number; supportPoints:number; cues:string[]; proposalM:[number,number,number,number] }
export interface KeyframeObservation {
  session: string; sourceSha256: string; frameId: string; cameraId: "front" | "left" | "right";
  imageSha256: string; candidateId: string; predictedLabel: "door" | "window"; score: number;
  model: { id: string; revision: string; artifactSha256?: string; runtime?: string }; reviewNote: string;
  /** 仅记录识别时的可见支持；构件尺寸取自用户编辑的参数。 */
  visibleSupport?: { wallId: string; u: [number, number]; z: [number, number] };
}
export interface Opening { id: string; name?: string; kind: "door" | "window"; design?: OpeningDesign; detection?: OpeningDetection; keyframes?: KeyframeObservation[]; wallId: string; offsetM: number; widthM: number; heightM: number; sillM: number; evidence: Evidence }
/** 房间最小面来源：组成墙段、墙网节点与由墙轴几何算出的面积/周长，用于追溯。 */
export interface RoomLoop { wallIds: string[]; nodesM: Vec2[]; areaM2: number; perimeterM: number }
export interface Room { id: string; levelId: string; name: string; boundaryM: Vec2[]; heightM: number; evidence: Evidence; loop?: RoomLoop }
/** 未能成面的区域：不放弃整条连通分量，也不为凑面积虚构连接，只如实记录位置、墙段与原因。 */
export interface UnclosedIssue {
  id: string; levelId: string; kind: "wall-gap" | "dangling-end"; pointM: Vec2; toM?: Vec2; gapM?: number;
  wallIds: string[]; reason: string; evidence: Evidence;
  /** 人工确认为洞口：不再计入未闭合数，问题记录保留，且不据此生成房间。 */
  resolution?: "resolved-opening";
  /** 已由人工连接处置闭合；保留记录供追溯，不计入未闭合数。 */
  closedBy?: { actionId: string; at: string };
}
export interface BuildingModel {
  schema: "survey-building/1"; id: string; revision: number; units: "m"; up: "Z";
  sourceStamp?: string; sourceName?: string; sourceSha256?: string; assumptions?: string[];
  levels: Level[]; walls: Wall[]; openings: Opening[]; rooms: Room[]; unclosedIssues?: UnclosedIssue[];
  /** 人工复核处置记录（按时间追加）；随工程保存，重新拟合不丢弃。 */
  reviewActions?: ReviewAction[];
  /** 重新拟合时的人工构件处理策略；缺省按 `block-on-fit` 处理（列出失效项并阻断）。 */
  reviewPolicy?: ReviewPolicy;
}
/** 墙网闭合诊断计数；同时记录在模型交付检查记录中，说明房间如何从墙网得到。 */
export interface ClosureReport {
  walls: number; nodes: number; degreeHistogram: Record<string, number>; faces: number; rooms: number;
  rejected: { smallFace: number; invalidBoundary: number }; unclosedIssues: { wallGap: number; danglingEnd: number };
}
export interface ModelIssue { elementId: string; code: string; message: string }
export const wallLength = (w: Wall) => Math.hypot(w.axisM[1][0] - w.axisM[0][0], w.axisM[1][1] - w.axisM[0][1]);
export const polygonArea = (p: Vec2[]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]!; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const cross = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function validKeyframes(items: unknown) {
  if (items === undefined) return true;
  if (!Array.isArray(items) || !items.length || items.length > 60) return false;
  const ids = new Set<string>(), hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  return items.every(o => {
    if (o?.model && ((o.model.artifactSha256!==undefined&&!hash(o.model.artifactSha256)) || (o.model.runtime!==undefined&&typeof o.model.runtime!=='string'))) return false;
    if (!o || ![o.session,o.frameId,o.candidateId,o.model?.id,o.model?.revision].every(v=>typeof v==='string'&&v.length>0) || !hash(o.sourceSha256) || !hash(o.imageSha256) || !['front','left','right'].includes(o.cameraId) || !['door','window'].includes(o.predictedLabel) || !Number.isFinite(o.score) || o.score<0 || o.score>1 || typeof o.reviewNote!=='string' || o.reviewNote.length>2000) return false;
    if (o.visibleSupport && (typeof o.visibleSupport.wallId!=='string' || ![o.visibleSupport.u,o.visibleSupport.z].every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]<p[1]))) return false;
    const key=JSON.stringify([o.session,o.frameId,o.candidateId]); if(ids.has(key))return false;ids.add(key);return true;
  });
}
export function validPolygon(p: Vec2[]) {
  if (p.length < 3 || polygonArea(p) < .000001) return false;
  const on = (a: Vec2, b: Vec2, c: Vec2) => Math.abs(cross(a,b,c)) < 1e-9 && c[0] >= Math.min(a[0],b[0])-1e-9 && c[0] <= Math.max(a[0],b[0])+1e-9 && c[1] >= Math.min(a[1],b[1])-1e-9 && c[1] <= Math.max(a[1],b[1])+1e-9;
  for (let i=0;i<p.length;i++) {
    const a=p[i]!, b=p[(i+1)%p.length]!; if (Math.hypot(a[0]-b[0],a[1]-b[1])<.001) return false;
    for (let j=i+1;j<p.length;j++) { if (j===i+1 || (i===0 && j===p.length-1)) continue; const c=p[j]!,d=p[(j+1)%p.length]!;
      if ((cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) || on(a,b,c) || on(a,b,d) || on(c,d,a) || on(c,d,b)) return false;
    }
  }
  return true;
}
const REVIEW_ACTIONS = ["connect", "add-wall", "remove-wall", "resolved-opening"];
/** 人工复核产生的提示类检查码：记录保留并可见，但不属于几何或关联错误（不阻止保存与打开）。 */
export const REVIEW_CODES = ["UNCLOSED", "UNCLOSED_TRACE", "RESOLVED_OPENING", "CLOSED_BY_REVIEW", "MANUAL_WALL", "WALL_REMOVED"];
const stamp = (v: any) => typeof v === "string" && Number.isFinite(Date.parse(v));
function validWallSource(s: any) {
  if (s === undefined) return true;
  return !!s && ["fit","manual"].includes(s.kind) && ["fit","manual"].includes(s.origin) && stamp(s.at)
    && (s.issueId===undefined || typeof s.issueId==="string") && (s.actionId===undefined || typeof s.actionId==="string");
}
function validRemoval(r: any): boolean {
  if (r === undefined) return true;
  if (!r || !stamp(r.at) || r.operator!=="manual" || typeof r.reason!=="string" || r.reason.length>500) return false;
  if (r.issueId!==undefined && typeof r.issueId!=="string") return false;
  if (r.actionId!==undefined && typeof r.actionId!=="string") return false;
  const w = r.wall;
  return !!w && typeof w.id==="string" && typeof w.levelId==="string" && Array.isArray(w.axisM) && w.axisM.length===2
    && w.axisM.every((p: any) => Array.isArray(p) && p.length===2 && p.every(Number.isFinite))
    && Number.isFinite(w.heightM) && Number.isFinite(w.thicknessM) && validWallSource(w.source) && validRemoval(w.removed);
}
function validActions(list: any) {
  if (!Array.isArray(list) || list.length > 20000) return false;
  return list.every((a: any) => a && typeof a.id==="string" && REVIEW_ACTIONS.includes(a.action) && a.operator==="manual" && a.source==="review"
    && stamp(a.at) && typeof a.levelId==="string" && [a.roomsBefore,a.roomsAfter].every((v: any) => Number.isSafeInteger(v) && v >= 0)
    && Array.isArray(a.wallIds) && a.wallIds.every((v: any) => typeof v==="string") && typeof a.note==="string" && a.note.length<=1000
    && (a.issueId===undefined || typeof a.issueId==="string"));
}
/** 墙段是否为人工来源（新增或人工修改过）：人工墙段不参与自动拟合口径与自动尺寸核验。 */
export const manualWall = (w: Wall, _m?: BuildingModel) => w.source?.kind === "manual";
/** 未删除的墙段（软删除留痕后仍保留在 walls 中，但不参与墙网与房间）。 */
export const activeWalls = (m: BuildingModel, levelId?: string) => m.walls.filter(w => !w.removed && (levelId===undefined || w.levelId===levelId));

/** 工程读取前先检查结构，避免损坏的嵌套数组触发渲染或导出异常。 */
export function assertBuildingShape(m: any): asserts m is BuildingModel {
  const list = (v: any) => Array.isArray(v) && v.length <= 20000;
  const point = (p: any) => Array.isArray(p) && p.length===2 && p.every(Number.isFinite);
  const evidence = (e: any) => e && ["measured","inferred","manual"].includes(e.kind) && typeof e.sourceAssetId==="string" && Number.isSafeInteger(e.revision) && e.revision>=0 && typeof e.confirmed==="boolean";
  if (!m || m.schema!=="survey-building/1" || typeof m.id!=="string" || !Number.isSafeInteger(m.revision) || m.revision<1 || ![m.levels,m.walls,m.openings,m.rooms].every(list)
    || !m.levels.every((l: any)=>l && typeof l.id==="string" && typeof l.name==="string" && Number.isFinite(l.elevationM))
    || !m.walls.every((w: any)=>w && typeof w.id==="string" && typeof w.levelId==="string" && Array.isArray(w.axisM) && w.axisM.length===2 && w.axisM.every(point) && evidence(w.evidence) && validWallSource(w.source) && validRemoval(w.removed))
    || !m.openings.every((o: any)=>o && typeof o.id==="string" && ["door","window"].includes(o.kind) && typeof o.wallId==="string" && evidence(o.evidence) && (o.detection===undefined || (o.detection?.method==='wall-elevation/1' && [o.detection.cellM,o.detection.slabM,o.detection.sourcePoints,o.detection.supportPoints].every((v:any)=>Number.isFinite(v)&&v>0) && Array.isArray(o.detection.cues) && o.detection.cues.every((v:any)=>typeof v==='string') && Array.isArray(o.detection.proposalM) && o.detection.proposalM.length===4 && o.detection.proposalM.every(Number.isFinite))))
    || !m.rooms.every((r: any)=>r && typeof r.id==="string" && typeof r.levelId==="string" && typeof r.name==="string" && Array.isArray(r.boundaryM) && r.boundaryM.length<=1000 && r.boundaryM.every(point) && evidence(r.evidence) && (r.loop===undefined || (Array.isArray(r.loop.wallIds) && r.loop.wallIds.every((v:any)=>typeof v==='string') && Array.isArray(r.loop.nodesM) && r.loop.nodesM.every(point) && [r.loop.areaM2,r.loop.perimeterM].every((v:any)=>Number.isFinite(v)&&v>=0))))
    || (m.unclosedIssues!==undefined && (!list(m.unclosedIssues) || !m.unclosedIssues.every((i: any)=>i && typeof i.id==='string' && typeof i.levelId==='string' && ["wall-gap","dangling-end"].includes(i.kind) && point(i.pointM) && (i.toM===undefined || point(i.toM)) && (i.gapM===undefined || (Number.isFinite(i.gapM)&&i.gapM>=0)) && Array.isArray(i.wallIds) && i.wallIds.every((v:any)=>typeof v==='string') && typeof i.reason==='string' && i.reason.length<=500 && evidence(i.evidence) && (i.resolution===undefined || i.resolution==="resolved-opening") && (i.closedBy===undefined || (typeof i.closedBy.actionId==='string' && typeof i.closedBy.at==='string' && Number.isFinite(Date.parse(i.closedBy.at)))))))
    || (m.reviewActions!==undefined && !validActions(m.reviewActions)) || (m.reviewPolicy!==undefined && !["rehang","block-on-fit"].includes(m.reviewPolicy))) throw Error("建筑模型结构无效。");
  if (!m.openings.every((o: Opening) => validKeyframes(o.keyframes))) throw Error("门窗关键帧来源无效。");
}
export function validateBuilding(model: BuildingModel): ModelIssue[] {
  try { assertBuildingShape(model); } catch { return [{elementId:model?.id??"model",code:"MALFORMED",message:"建筑模型结构无效。"}]; }
  const issues: ModelIssue[] = [], ids = new Set<string>(), levels = new Set(model.levels.map(l => l.id));
  const add = (elementId: string, code: string, message: string) => issues.push({ elementId, code, message });
  if (model.units !== "m" || model.up !== "Z") add(model.id, "COORDINATES", "建筑模型必须声明米制、Z向上。");
  // 未闭合与复核记录按问题/处置编号去重。
  for (const e of [...(model.unclosedIssues ?? []), ...(model.reviewActions ?? [])]) { if (!e.id || ids.has(e.id)) add(e.id,"DUPLICATE_ID","构件编号为空或重复。"); ids.add(e.id); }
  // 软删除留痕沿用被删墙段本身的编号（同一构件，不重复占号）。
  for (const w of model.walls) if (w.removed && w.removed.wall.id !== w.id) add(w.id,"REMOVAL_TRACE","软删除留痕的墙段编号与被删墙段不一致。");
  if (!model.levels.length) add(model.id, "NO_LEVEL", "缺少楼层。");
  for (const e of [...model.levels,...model.walls,...model.openings,...model.rooms]) { if (!e.id || ids.has(e.id)) add(e.id,"DUPLICATE_ID","构件编号为空或重复。"); ids.add(e.id); if ("evidence" in e && !e.evidence.confirmed) add(e.id,"UNREVIEWED","构件尚未复核。"); }
  for (const w of model.walls) { if (!levels.has(w.levelId)) add(w.id,"LEVEL_MISSING","墙体楼层不存在。"); if (wallLength(w)<.001 || ![w.heightM,w.thicknessM].every(n=>Number.isFinite(n)&&n>0)) add(w.id,"WALL_GEOMETRY","墙体长度、高度或厚度无效。"); if (w.removed) add(w.id,"WALL_REMOVED","墙段已由人工删除，不参与墙网与房间：" + w.removed.reason); }
  for (const w of model.walls) { if (!w.removed && manualWall(w, model)) add(w.id,"MANUAL_WALL","人工墙段（新增或人工修改）：不作为自动拟合结果，也不参与自动尺寸核验的独立实测口径。"); }
  const observationOwners=new Set<string>();
  for (const o of model.openings) {
    for(const k of o.keyframes??[]){const key=JSON.stringify([k.session,k.frameId,k.candidateId]);if(observationOwners.has(key))add(o.id,"KEYFRAME_DUPLICATE","同一关键帧观察被重复关联多个门窗。");observationOwners.add(key);}
    if(o.keyframes?.some(k=>model.sourceSha256 && k.sourceSha256!==model.sourceSha256)) add(o.id,"KEYFRAME_SOURCE","门窗关键帧与建筑原件不一致。");
    if (!validOpeningDesign(o)) add(o.id,"OPENING_TEMPLATE","门窗模板类型或框宽无效，框宽须小于洞口短边的四分之一且不超过0.15m。");
    const w=model.walls.find(w=>w.id===o.wallId); if (!w) { add(o.id,"HOST_MISSING","门窗必须关联有效墙体。"); continue; }
    if (![o.offsetM,o.widthM,o.heightM,o.sillM].every(Number.isFinite) || o.offsetM<0 || o.widthM<=0 || o.heightM<=0 || o.sillM<0 || o.offsetM+o.widthM>wallLength(w)+1e-7 || o.sillM+o.heightM>w.heightM+1e-7) add(o.id,"OPENING_BOUNDS","门窗超出宿主墙体或尺寸无效。");
    for (const other of model.openings) if (other.id>o.id && other.wallId===o.wallId && Math.min(o.offsetM+o.widthM,other.offsetM+other.widthM)-Math.max(o.offsetM,other.offsetM)>1e-7 && Math.min(o.sillM+o.heightM,other.sillM+other.heightM)-Math.max(o.sillM,other.sillM)>1e-7) add(o.id,"OPENING_OVERLAP","同一墙体的洞口互相重叠。");
  }
  for (const r of model.rooms) { if (!levels.has(r.levelId)) add(r.id,"LEVEL_MISSING","房间楼层不存在。"); if (!validPolygon(r.boundaryM) || !Number.isFinite(r.heightM) || r.heightM<=0) add(r.id,"ROOM_BOUNDARY","房间边界自交、未形成有效面积或高度无效。"); if (r.loop?.wallIds.some(id=>!model.walls.some(w=>w.id===id))) add(r.id,"ROOM_TRACE","房间组成墙段已不存在。"); }
  // 未闭合问题如实进入检查记录：它不阻止模型保存，但阻止“全部已复核”式交付结论。
  // 人工确认为洞口的项与已由人工连接闭合的项保留记录，但不再计入未闭合，也不据此生成房间。
  // 涉及墙段若全部被人工删除，该项按留痕折叠，不再报追溯失效。
  for (const i of model.unclosedIssues ?? []) { if (!levels.has(i.levelId)) add(i.id,"LEVEL_MISSING","未闭合问题楼层不存在。"); const hosts=model.walls.filter(w=>i.wallIds.includes(w.id)); if (hosts.length && !hosts.some(w=>!w.removed)) add(i.id,"UNCLOSED_TRACE","涉及的墙段已全部删除，处置记录保留：" + i.reason);  if (i.resolution==="resolved-opening") add(i.id,"RESOLVED_OPENING","已由人工确认为洞口，不计入未闭合：" + i.reason); else if (i.closedBy) add(i.id,"CLOSED_BY_REVIEW","已由人工连接处置闭合：" + i.reason); else if (!i.evidence.confirmed) add(i.id,"UNCLOSED","墙体未闭合，未生成房间：" + i.reason); }
  for (const a of model.reviewActions ?? []) if (!levels.has(a.levelId)) add(a.id,"LEVEL_MISSING","复核处置记录楼层不存在。");
  return issues;
}
export function buildingQuantities(m: BuildingModel) {
  return { openings:m.openings.map(o=>({id:o.id,name:o.name??o.id,wallId:o.wallId,kind:o.kind,template:openingTemplate(o)?.name??"通用实体",widthM:o.widthM,heightM:o.heightM,sillM:o.sillM,areaM2:o.widthM*o.heightM,frameWidthM:o.design?.frameWidthM})), walls: m.walls.map(w=>{const gross=wallLength(w)*w.heightM; const holes=m.openings.filter(o=>o.wallId===w.id).reduce((s,o)=>s+o.widthM*o.heightM,0);return {id:w.id,name:w.name??w.id,levelId:w.levelId,lengthM:wallLength(w),grossAreaM2:gross,netAreaM2:gross-holes,netVolumeM3:(gross-holes)*w.thicknessM};}), rooms:m.rooms.map(r=>({id:r.id,name:r.name,levelId:r.levelId,areaM2:polygonArea(r.boundaryM),volumeM3:polygonArea(r.boundaryM)*r.heightM})) };
}
/** 按洞口边界切分墙实体，预览和工程量采用同一几何，不用颜色覆盖假装开洞。 */
export function wallPieces(w: Wall, openings: Opening[]) {
  const holes=openings.filter(o=>o.wallId===w.id), xs=[...new Set([0,wallLength(w),...holes.flatMap(o=>[o.offsetM,o.offsetM+o.widthM])])].sort((a,b)=>a-b), zs=[...new Set([0,w.heightM,...holes.flatMap(o=>[o.sillM,o.sillM+o.heightM])])].sort((a,b)=>a-b);
  const pieces: Array<{x:number;z:number;width:number;height:number}>=[];
  for(let i=1;i<xs.length;i++)for(let j=1;j<zs.length;j++){const x=(xs[i-1]!+xs[i]!)/2,z=(zs[j-1]!+zs[j]!)/2; if(!holes.some(o=>x>o.offsetM&&x<o.offsetM+o.widthM&&z>o.sillM&&z<o.sillM+o.heightM)) pieces.push({x,z,width:xs[i]!-xs[i-1]!,height:zs[j]!-zs[j-1]!});}
  return pieces;
}
