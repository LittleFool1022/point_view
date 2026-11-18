import { CAD_AUTO_CONNECTION, CAD_MANUAL_CONNECTION, type CadArcEntity, type CadLineEntity, type CadPolylineEntity, type DrawingModel } from "./model";
import type { CadPoint2 } from "./dimensions";

export interface CadEndpoint { point: CadPoint2; entityId: string }
export type CadConnectionStyle = "auto" | "outer90" | "inner90" | "direct" | "arc";
export type ResolvedCadConnectionStyle = Exclude<CadConnectionStyle, "auto">;
export type CadConnectionEntity = CadLineEntity | CadPolylineEntity | CadArcEntity;

const JOIN_TOLERANCE_MM = 1;
const distance = (a: CadPoint2, b: CadPoint2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const normalize = (dx: number, dy: number): CadPoint2 | undefined => {
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? [dx / len, dy / len] : undefined;
};
const dot = (a: CadPoint2, b: CadPoint2) => a[0] * b[0] + a[1] * b[1];

function wallEndpoints(model: DrawingModel): Array<CadEndpoint & { layer: string }> {
  return model.entities.flatMap(entity => {
    if (entity.category !== "wall") return [];
    if (entity.type === "line") return [{ point: [...entity.start], entityId: entity.id, layer: entity.layer }, { point: [...entity.end], entityId: entity.id, layer: entity.layer }];
    if (entity.type === "polyline" && !entity.closed && entity.points.length > 1) {
      return [{ point: [...entity.points[0]!], entityId: entity.id, layer: entity.layer }, { point: [...entity.points.at(-1)!], entityId: entity.id, layer: entity.layer }];
    }
    if (entity.type === "arc") {
      return [
        { point: [entity.center[0] + Math.cos(entity.startAngle) * entity.radiusMm, entity.center[1] + Math.sin(entity.startAngle) * entity.radiusMm], entityId: entity.id, layer: entity.layer },
        { point: [entity.center[0] + Math.cos(entity.endAngle) * entity.radiusMm, entity.center[1] + Math.sin(entity.endAngle) * entity.radiusMm], entityId: entity.id, layer: entity.layer },
      ];
    }
    return [];
  });
}

function outgoingWallTangent(model: DrawingModel, endpoint: CadEndpoint): CadPoint2 | undefined {
  const entity = model.entities.find(item => item.id === endpoint.entityId);
  if (!entity) return undefined;
  if (entity.type === "line") {
    return distance(endpoint.point, entity.start) <= distance(endpoint.point, entity.end)
      ? normalize(entity.start[0] - entity.end[0], entity.start[1] - entity.end[1])
      : normalize(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
  }
  if (entity.type === "polyline" && entity.points.length >= 2) {
    const first = entity.points[0]!, last = entity.points.at(-1)!;
    return distance(endpoint.point, first) <= distance(endpoint.point, last)
      ? normalize(first[0] - entity.points[1]![0], first[1] - entity.points[1]![1])
      : normalize(last[0] - entity.points.at(-2)![0], last[1] - entity.points.at(-2)![1]);
  }
  return undefined;
}

function chooseCornerElbows(model: DrawingModel, start: CadEndpoint, end: CadEndpoint): { outer: CadPoint2; inner: CadPoint2 } {
  const c1: CadPoint2 = [end.point[0], start.point[1]];
  const c2: CadPoint2 = [start.point[0], end.point[1]];
  const uStart = outgoingWallTangent(model, start);
  const uEnd = outgoingWallTangent(model, end);
  const score = (corner: CadPoint2) => {
    const dStart = normalize(corner[0] - start.point[0], corner[1] - start.point[1]);
    const dEnd = normalize(corner[0] - end.point[0], corner[1] - end.point[1]);
    return (uStart && dStart ? dot(uStart, dStart) : 0) + (uEnd && dEnd ? dot(uEnd, dEnd) : 0);
  };
  const s1 = score(c1), s2 = score(c2);
  if (Math.abs(s1 - s2) > 0.25) return s1 > s2 ? { outer: c1, inner: c2 } : { outer: c2, inner: c1 };
  const center: CadPoint2 = [
    (model.modelBoundsMm.min[0] + model.modelBoundsMm.max[0]) / 2,
    (model.modelBoundsMm.min[1] + model.modelBoundsMm.max[1]) / 2,
  ];
  return distance(c1, center) >= distance(c2, center) ? { outer: c1, inner: c2 } : { outer: c2, inner: c1 };
}

export function resolveCadConnectionStyle(model: DrawingModel, start: CadEndpoint, end: CadEndpoint, style: CadConnectionStyle = "auto"): ResolvedCadConnectionStyle {
  if (style !== "auto") return style;
  const dx = Math.abs(end.point[0] - start.point[0]), dy = Math.abs(end.point[1] - start.point[1]);
  const minSpan = Math.min(dx, dy), maxSpan = Math.max(dx, dy);
  if (minSpan < 20 || maxSpan <= 1e-6) return "direct";
  const uStart = outgoingWallTangent(model, start), uEnd = outgoingWallTangent(model, end);
  if (uStart && uEnd) return Math.abs(dot(uStart, uEnd)) < 0.55 ? "outer90" : "direct";
  return minSpan / maxSpan >= 0.35 ? "outer90" : "direct";
}

function buildConnectionEntity(model: DrawingModel, start: CadEndpoint, end: CadEndpoint, resolved: ResolvedCadConnectionStyle, id: string): CadConnectionEntity {
  const metadata = { operation: CAD_MANUAL_CONNECTION, startEntityId: start.entityId, endEntityId: end.entityId, connectionStyle: resolved };
  const common = { id, layer: "INFERRED_WALL" as const, category: "wall" as const, source: "manual" as const, confidence: "confirmed" as const, metadata };
  const dx = end.point[0] - start.point[0], dy = end.point[1] - start.point[1];
  const axisAligned = Math.abs(dx) < 1e-3 || Math.abs(dy) < 1e-3;
  if (resolved === "direct" || ((resolved === "outer90" || resolved === "inner90") && axisAligned)) {
    return { ...common, type: "line", start: [...start.point], end: [...end.point] };
  }
  if (resolved === "outer90" || resolved === "inner90") {
    const { outer, inner } = chooseCornerElbows(model, start, end);
    const corner = resolved === "outer90" ? outer : inner;
    return { ...common, type: "polyline", points: [[...start.point], [...corner], [...end.point]], closed: false };
  }
  const chord = Math.hypot(dx, dy);
  const mid: CadPoint2 = [(start.point[0] + end.point[0]) / 2, (start.point[1] + end.point[1]) / 2];
  const nLeft: CadPoint2 = [-dy / chord, dx / chord];
  const nRight: CadPoint2 = [dy / chord, -dx / chord];
  let bulgeRef: CadPoint2;
  if (!axisAligned) {
    bulgeRef = chooseCornerElbows(model, start, end).outer;
  } else {
    const modelCenter: CadPoint2 = [
      (model.modelBoundsMm.min[0] + model.modelBoundsMm.max[0]) / 2,
      (model.modelBoundsMm.min[1] + model.modelBoundsMm.max[1]) / 2,
    ];
    const outward = normalize(mid[0] - modelCenter[0], mid[1] - modelCenter[1]) ?? nLeft;
    bulgeRef = [mid[0] + outward[0] * chord, mid[1] + outward[1] * chord];
  }
  const bulgeDir = dot([bulgeRef[0] - mid[0], bulgeRef[1] - mid[1]], nLeft) >= 0 ? nLeft : nRight;
  const h = chord / 2, radiusMm = chord / Math.SQRT2;
  const center: CadPoint2 = [mid[0] - bulgeDir[0] * h, mid[1] - bulgeDir[1] * h];
  const aStart = Math.atan2(start.point[1] - center[1], start.point[0] - center[0]);
  const aEnd = Math.atan2(end.point[1] - center[1], end.point[0] - center[0]);
  const ccwAB = ((aEnd - aStart) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  let startAngle: number, endAngle: number;
  if (ccwAB <= Math.PI) {
    startAngle = aStart;
    endAngle = aStart + ccwAB;
  } else {
    const ccwBA = ((aStart - aEnd) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    startAngle = aEnd;
    endAngle = aEnd + ccwBA;
  }
  return { ...common, type: "arc", center, radiusMm, startAngle, endAngle };
}

/** 端点至少与另一个墙线端点相距 1mm 内才视为连接；不自动补齐门洞。 */
export function openCadEndpoints(model: DrawingModel, visible?: (layer: string) => boolean): CadEndpoint[] {
  const endpoints = wallEndpoints(model);
  return endpoints.filter((endpoint, index) => (!visible || visible(endpoint.layer)) && !endpoints.some((other, otherIndex) => index !== otherIndex && distance(endpoint.point, other.point) < JOIN_TOLERANCE_MM));
}

export function snapCadOpenEndpoint(model: DrawingModel, point: CadPoint2, toleranceMm: number, visible?: (layer: string) => boolean): CadEndpoint | undefined {
  let best: { endpoint: CadEndpoint; distance: number } | undefined;
  for (const endpoint of openCadEndpoints(model, visible)) {
    const current = distance(endpoint.point, point);
    if (current <= toleranceMm && (!best || current < best.distance)) best = { endpoint, distance: current };
  }
  return best?.endpoint;
}

export function manualCadConnections(model: DrawingModel): CadConnectionEntity[] {
  return model.entities.filter((entity): entity is CadConnectionEntity =>
    (entity.type === "line" || entity.type === "polyline" || entity.type === "arc") &&
    (entity.metadata?.operation === CAD_MANUAL_CONNECTION || entity.metadata?.operation === CAD_AUTO_CONNECTION));
}

export function previewCadConnection(model: DrawingModel, start: CadEndpoint, end: CadEndpoint, style: CadConnectionStyle = "auto"): CadConnectionEntity | undefined {
  if (distance(start.point, end.point) < 1e-6) return undefined;
  return buildConnectionEntity(model, start, end, resolveCadConnectionStyle(model, start, end, style), "preview-connection");
}

export function createCadConnection(model: DrawingModel, start: CadEndpoint, end: CadEndpoint, style: "direct"): CadLineEntity;
export function createCadConnection(model: DrawingModel, start: CadEndpoint, end: CadEndpoint, style?: CadConnectionStyle): CadConnectionEntity;
export function createCadConnection(model: DrawingModel, start: CadEndpoint, end: CadEndpoint, style: CadConnectionStyle = "auto"): CadConnectionEntity {
  if (start.entityId === end.entityId) throw Error("不能连接同一图元自身的两个端点。");
  const open = openCadEndpoints(model);
  for (const endpoint of [start, end]) {
    if (!open.some(candidate => candidate.entityId === endpoint.entityId && distance(candidate.point, endpoint.point) < 1e-6)) throw Error("端点连接状态已变化，请重新选择未连接端点。");
  }
  if (distance(start.point, end.point) < 1e-6) throw Error("两个端点位置重合，不能生成零长度连线。");
  return buildConnectionEntity(model, start, end, resolveCadConnectionStyle(model, start, end, style), crypto.randomUUID());
}

/** 只替换人工连线，保留实测、推断、尺寸、标注和图框；每次编辑后重算开放端点与复核提示。 */
export function withCadConnections(model: DrawingModel, connections: CadConnectionEntity[]): DrawingModel {
  const entities = [...model.entities.filter(entity => entity.metadata?.operation !== CAD_MANUAL_CONNECTION&&entity.metadata?.operation!==CAD_AUTO_CONNECTION), ...connections];
  const base = { ...model, entities }, openEndpoints = openCadEndpoints(base).length;
  const warnings = model.warnings.filter(warning => warning.code !== "MANUAL_WALL_CONNECTION").map(warning => warning.code === "WALL_LINES_REVIEW" ? {
    ...warning,
    message: `${openEndpoints} 个未连接端点（含门洞或缺失证据），墙线来自跨高度证据和直线拟合；未识别门窗，曲墙可能遗漏。仅拼接12cm内的近邻交点，未强制闭合，须复核墙体与尺寸；当前含 ${connections.length} 条人工连线；不构成施工图精度验收。`,
  } : warning);
  if (connections.length) warnings.push({ code: "MANUAL_WALL_CONNECTION", severity: "warning", message: `图纸含 ${connections.length} 条人工连接墙线；几何由用户指定，不代表直接实测，导出前必须复核。`, relatedLayer: "INFERRED_WALL" });
  const evidenceNote=model.titleBlock.evidenceNote.replace(/；含 \d+ 条人工端点连线/g,"");
  return {
    ...base, warnings,
    parameters: Object.assign({}, model.parameters, { openEndpoints }),
    statistics: { ...model.statistics, inferredWallEntities: entities.filter(entity => entity.layer === "INFERRED_WALL").length },
    titleBlock:{...model.titleBlock,evidenceNote:connections.length?`${evidenceNote}；含 ${connections.length} 条人工端点连线`:evidenceNote},
  };
}

function properCross(a:CadPoint2,b:CadPoint2,c:CadPoint2,d:CadPoint2):boolean{
  const cross=(p:CadPoint2,q:CadPoint2,r:CadPoint2)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
  if(Math.abs(abC)<1e-6&&Math.abs(abD)<1e-6&&Math.abs(cdA)<1e-6&&Math.abs(cdB)<1e-6){
    const overlap=Math.max(0,Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))-Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0])))+Math.max(0,Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]))-Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1])));
    return overlap>1;
  }
  return ((abC>0&&abD<0)||(abC<0&&abD>0))&&((cdA>0&&cdB<0)||(cdA<0&&cdB>0));
}

/** 仅建议不超过120mm且不交叉的一对一缺口；纯点云图不会据此宣称识别门洞。 */
export function suggestCadConnections(model:DrawingModel,maxGapMm=120):CadLineEntity[]{
  const endpoints=openCadEndpoints(model),pairs=endpoints.flatMap((start,i)=>endpoints.slice(i+1).map(end=>({start,end,distance:distance(start.point,end.point)}))).filter(p=>p.start.entityId!==p.end.entityId&&p.distance>1e-6&&p.distance<=maxGapMm).sort((a,b)=>a.distance-b.distance);
  const used=new Set<string>(),accepted:CadLineEntity[]=[],geometry=model.entities.flatMap(entity=>entity.type==='line'?[[entity.start,entity.end] as [CadPoint2,CadPoint2]]:[]);
  for(const pair of pairs){
    const key=(e:CadEndpoint)=>`${e.entityId}:${e.point[0]}:${e.point[1]}`;
    if(used.has(key(pair.start))||used.has(key(pair.end)))continue;
    const candidate: [CadPoint2,CadPoint2]=[pair.start.point,pair.end.point];
    if([...geometry,...accepted.map(line=>[line.start,line.end] as [CadPoint2,CadPoint2])].some(([a,b])=>properCross(candidate[0],candidate[1],a,b)))continue;
    accepted.push({...createCadConnection(model,pair.start,pair.end,"direct"),source:"inferred",confidence:"inferred",metadata:{operation:CAD_AUTO_CONNECTION,startEntityId:pair.start.entityId,endEntityId:pair.end.entityId,automatic:true,gapMm:pair.distance}});
    used.add(key(pair.start));used.add(key(pair.end));
  }
  return accepted;
}
