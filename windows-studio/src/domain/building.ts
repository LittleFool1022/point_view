import { validOpeningDesign, openingTemplate, type OpeningDesign } from "./openingTemplates";
/** 建筑语义采用米制、Z向上；墙轴线与源点云共用工程坐标。 */
export type Vec2 = [number, number];
export type Evidence = { kind: "measured" | "inferred" | "manual"; sourceAssetId: string; revision: number; confirmed: boolean };
export interface Level { id: string; name: string; elevationM: number }
export interface Wall { id: string; name?: string; levelId: string; axisM: [Vec2, Vec2]; heightM: number; thicknessM: number; evidence: Evidence }
export interface OpeningDetection { method:'wall-elevation/1'; cellM:number; slabM:number; sourcePoints:number; supportPoints:number; cues:string[]; proposalM:[number,number,number,number] }
export interface KeyframeObservation {
  session: string; sourceSha256: string; frameId: string; cameraId: "front" | "left" | "right";
  imageSha256: string; candidateId: string; predictedLabel: "door" | "window"; score: number;
  model: { id: string; revision: string; artifactSha256?: string; runtime?: string }; reviewNote: string;
  /** 仅记录识别时的可见支持；构件尺寸取自用户编辑的参数。 */
  visibleSupport?: { wallId: string; u: [number, number]; z: [number, number] };
}
export interface Opening { id: string; name?: string; kind: "door" | "window"; design?: OpeningDesign; detection?: OpeningDetection; keyframes?: KeyframeObservation[]; wallId: string; offsetM: number; widthM: number; heightM: number; sillM: number; evidence: Evidence }
export interface Room { id: string; levelId: string; name: string; boundaryM: Vec2[]; heightM: number; evidence: Evidence }
export interface BuildingModel {
  schema: "survey-building/1"; id: string; revision: number; units: "m"; up: "Z";
  sourceStamp?: string; sourceName?: string; sourceSha256?: string; assumptions?: string[];
  levels: Level[]; walls: Wall[]; openings: Opening[]; rooms: Room[];
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
/** 工程读取前先检查结构，避免损坏的嵌套数组触发渲染或导出异常。 */
export function assertBuildingShape(m: any): asserts m is BuildingModel {
  const list = (v: any) => Array.isArray(v) && v.length <= 20000;
  const point = (p: any) => Array.isArray(p) && p.length===2 && p.every(Number.isFinite);
  const evidence = (e: any) => e && ["measured","inferred","manual"].includes(e.kind) && typeof e.sourceAssetId==="string" && Number.isSafeInteger(e.revision) && e.revision>=0 && typeof e.confirmed==="boolean";
  if (!m || m.schema!=="survey-building/1" || typeof m.id!=="string" || !Number.isSafeInteger(m.revision) || m.revision<1 || ![m.levels,m.walls,m.openings,m.rooms].every(list)
    || !m.levels.every((l: any)=>l && typeof l.id==="string" && typeof l.name==="string" && Number.isFinite(l.elevationM))
    || !m.walls.every((w: any)=>w && typeof w.id==="string" && typeof w.levelId==="string" && Array.isArray(w.axisM) && w.axisM.length===2 && w.axisM.every(point) && evidence(w.evidence))
    || !m.openings.every((o: any)=>o && typeof o.id==="string" && ["door","window"].includes(o.kind) && typeof o.wallId==="string" && evidence(o.evidence) && (o.detection===undefined || (o.detection?.method==='wall-elevation/1' && [o.detection.cellM,o.detection.slabM,o.detection.sourcePoints,o.detection.supportPoints].every((v:any)=>Number.isFinite(v)&&v>0) && Array.isArray(o.detection.cues) && o.detection.cues.every((v:any)=>typeof v==='string') && Array.isArray(o.detection.proposalM) && o.detection.proposalM.length===4 && o.detection.proposalM.every(Number.isFinite))))
    || !m.rooms.every((r: any)=>r && typeof r.id==="string" && typeof r.levelId==="string" && typeof r.name==="string" && Array.isArray(r.boundaryM) && r.boundaryM.length<=1000 && r.boundaryM.every(point) && evidence(r.evidence))) throw Error("建筑模型结构无效。");
  if (!m.openings.every((o: Opening) => validKeyframes(o.keyframes))) throw Error("门窗关键帧来源无效。");
}
export function validateBuilding(model: BuildingModel): ModelIssue[] {
  try { assertBuildingShape(model); } catch { return [{elementId:model?.id??"model",code:"MALFORMED",message:"建筑模型结构无效。"}]; }
  const issues: ModelIssue[] = [], ids = new Set<string>(), levels = new Set(model.levels.map(l => l.id));
  const add = (elementId: string, code: string, message: string) => issues.push({ elementId, code, message });
  if (model.units !== "m" || model.up !== "Z") add(model.id, "COORDINATES", "建筑模型必须声明米制、Z向上。");
  if (!model.levels.length) add(model.id, "NO_LEVEL", "缺少楼层。");
  for (const e of [...model.levels,...model.walls,...model.openings,...model.rooms]) { if (!e.id || ids.has(e.id)) add(e.id,"DUPLICATE_ID","构件编号为空或重复。"); ids.add(e.id); if ("evidence" in e && !e.evidence.confirmed) add(e.id,"UNREVIEWED","构件尚未复核。"); }
  for (const w of model.walls) { if (!levels.has(w.levelId)) add(w.id,"LEVEL_MISSING","墙体楼层不存在。"); if (wallLength(w)<.001 || ![w.heightM,w.thicknessM].every(n=>Number.isFinite(n)&&n>0)) add(w.id,"WALL_GEOMETRY","墙体长度、高度或厚度无效。"); }
  const observationOwners=new Set<string>();
  for (const o of model.openings) {
    for(const k of o.keyframes??[]){const key=JSON.stringify([k.session,k.frameId,k.candidateId]);if(observationOwners.has(key))add(o.id,"KEYFRAME_DUPLICATE","同一关键帧观察被重复关联多个门窗。");observationOwners.add(key);}
    if(o.keyframes?.some(k=>model.sourceSha256 && k.sourceSha256!==model.sourceSha256)) add(o.id,"KEYFRAME_SOURCE","门窗关键帧与建筑原件不一致。");
    if (!validOpeningDesign(o)) add(o.id,"OPENING_TEMPLATE","门窗模板类型或框宽无效，框宽须小于洞口短边的四分之一且不超过0.15m。");
    const w=model.walls.find(w=>w.id===o.wallId); if (!w) { add(o.id,"HOST_MISSING","门窗必须关联有效墙体。"); continue; }
    if (![o.offsetM,o.widthM,o.heightM,o.sillM].every(Number.isFinite) || o.offsetM<0 || o.widthM<=0 || o.heightM<=0 || o.sillM<0 || o.offsetM+o.widthM>wallLength(w)+1e-7 || o.sillM+o.heightM>w.heightM+1e-7) add(o.id,"OPENING_BOUNDS","门窗超出宿主墙体或尺寸无效。");
    for (const other of model.openings) if (other.id>o.id && other.wallId===o.wallId && Math.min(o.offsetM+o.widthM,other.offsetM+other.widthM)-Math.max(o.offsetM,other.offsetM)>1e-7 && Math.min(o.sillM+o.heightM,other.sillM+other.heightM)-Math.max(o.sillM,other.sillM)>1e-7) add(o.id,"OPENING_OVERLAP","同一墙体的洞口互相重叠。");
  }
  for (const r of model.rooms) { if (!levels.has(r.levelId)) add(r.id,"LEVEL_MISSING","房间楼层不存在。"); if (!validPolygon(r.boundaryM) || !Number.isFinite(r.heightM) || r.heightM<=0) add(r.id,"ROOM_BOUNDARY","房间边界自交、未形成有效面积或高度无效。"); }
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
