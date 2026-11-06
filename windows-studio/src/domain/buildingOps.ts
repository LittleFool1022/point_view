import { polygonArea, validPolygon, type BuildingModel, type ClosureReport, type Evidence, type Room, type UnclosedIssue, type Vec2, type Wall } from "./building";
import type { SurveySource } from "./project";
import { sourceSize } from "./source";
import type { WallSegment } from "../pipeline/wallLines";
export interface BuildingOptions { elevationM:number; heightM:number; thicknessM:number; levelName:string }
export const sourceStamp = (s: SurveySource) => JSON.stringify({name:s.name,bytes:sourceSize(s),units:s.units,clips:s.clips??[]});
/** 平面图最小面提取的功能参数（几何健全性下限与追溯窗口），不是精度阈值。 */
export const ROOM_MIN_AREA_M2 = .5; // 小于此面积的最小面多为墙厚或交叉产生的窄条，不当作房间
export const ROOM_UNCLOSED_SEARCH_M = 3; // 悬空端在此半径内找最近的其它墙段，超出则无从定位
/** 缺口判定：同一墙轴上两端距离不超过此值的算缺口/洞口，超过则算两侧墙未对齐（悬空端）。 */
export const ROOM_WALL_GAP_M = 1.5;
export const ROOM_UNCLOSED_MAX_PRINT = 50; // 写入模型的未闭合问题条数上限，超出部分仍计入诊断计数
export const ROOM_NODE_TOLERANCE_M = .02; // 墙网节点合并容差（拟合端点级）；同组分叉点会被自动拆分
const UNCLOSED_REASON = {
  "wall-gap": (gap:number) => `缺口 ${gap.toFixed(2)} m：两端应是同一道墙的延续或洞口，未自动补墙`,
  "dangling-end": (gap:number) => `悬空端：最近墙段 ${gap.toFixed(2)} m，未形成闭合最小面`,
} as const;
export const newBuilding = (source: SurveySource, options: BuildingOptions): BuildingModel => ({ schema:"survey-building/1",id:crypto.randomUUID(),revision:1,units:"m",up:"Z",sourceStamp:sourceStamp(source),sourceName:source.name,sourceSha256:source.native?.sha256,levels:[{id:crypto.randomUUID(),name:options.levelName,elevationM:options.elevationM}],walls:[],openings:[],rooms:[],unclosedIssues:[],assumptions:[`楼层标高${options.elevationM}m、墙高${options.heightM}m、墙厚${options.thicknessM}m为用户设置，未作为实测值验证。`,"候选墙面迹线暂作墙轴，需复核中心轴与厚度；门窗不从点云缺口自动推断。","房间取自墙网平面图最小面；未能成面的缺口与悬空端列为未闭合问题，不补墙、不虚构连接。"] });
export const manualEvidence = (m: BuildingModel): Evidence => ({kind:"manual",sourceAssetId:m.sourceSha256??m.sourceStamp??m.id,revision:m.revision,confirmed:false});
export function buildingFromSegments(source:SurveySource, options:BuildingOptions, segments:WallSegment[]) {
  const m=newBuilding(source,options), level=m.levels[0]!;
  m.walls=segments.map((s,i)=>({id:crypto.randomUUID(),name:`墙 ${i+1}`,levelId:level.id,axisM:[s.a,s.b],heightM:options.heightM,thicknessM:options.thicknessM,evidence:{...manualEvidence(m),kind:"inferred"}}));
  const closure=closeLevel(m,level.id,options.heightM); m.rooms=closure.rooms; m.unclosedIssues=closure.unclosedIssues; return m;
}
/** 房间结果及其墙网诊断：从同一墙网几何一次算出，供模型与交付检查记录共用。 */
export function roomsFromWalls(m: BuildingModel, levelId: string, heightM: number) {
  return closeLevel(m, levelId, heightM).rooms;
}
export function levelClosure(m: BuildingModel, levelId: string): ClosureReport {
  const { report } = closeLevel(m, levelId);
  return report;
}
/** 本层墙网结果（房间与未闭合清单）：人工处置后按同一墙网几何重算用，返回对象为新建，不改动输入模型。 */
export function levelRoomsAndIssues(m: BuildingModel, levelId: string): { rooms: Room[]; unclosedIssues: UnclosedIssue[] } {
  const { rooms, unclosedIssues } = closeLevel(m, levelId);
  return { rooms, unclosedIssues };
}

type Point = Vec2;
/** 墙网节点：同一位置合并后的连接点，记录其上的墙段与是否为本层分叉点。 */
interface NetNode { p: Point; walls: number[]; branch: boolean }
/** 墙网边：一段墙轴（一条墙可被分叉节点拆成多段），两端节点 + 方向。 */
interface NetEdge { wall: number; u: number; v: number }
interface HalfEdge { from: number; to: number; angle: number; edge: number }
interface LevelClosure { rooms: Room[]; unclosedIssues: UnclosedIssue[]; report: ClosureReport }

/**
 * 由墙网节点/边构建平面图并提取最小面（最小闭合环）作为房间候选：
 * 每个连通分量按“墙角处转角最小”的有向半边遍历，得到所有有界面；由此 T 形、十形与多房间
 * 网络都能出房间，不再要求整条分量全部端点度为 2。未能成面的缺口与悬空端不补墙，
 * 如实输出为未闭合问题。面积/周长取墙轴几何，不做精度认证。
 */
function closeLevel(m: BuildingModel, levelId: string, heightM?: number): LevelClosure {
  // 人工软删除的墙段保留留痕但不参与墙网与房间。
  const walls = m.walls.filter(w => w.levelId === levelId && !w.removed);
  const nodes: NetNode[] = [], edges: NetEdge[] = [];
  const nodeAt = (p: Point) => { const i = nodes.findIndex(q => Math.hypot(q.p[0]-p[0], q.p[1]-p[1]) < ROOM_NODE_TOLERANCE_M); if (i >= 0) return i; nodes.push({ p:[p[0],p[1]], walls:[], branch:false }); return nodes.length-1; };
  walls.forEach((w,i) => {
    const a = nodeAt(w.axisM[0]), b = nodeAt(w.axisM[1]); nodes[a]!.walls.push(i); nodes[b]!.walls.push(i);
    edges.push({ wall:i, u:a, v:b });
  });
  // 分叉节点（度 >2）把墙段切成独立边，平面图才与真实墙网一致：T 形处一段墙变两段。
  const split: NetEdge[] = [];
  edges.forEach(e => {
    const w = walls[e.wall]!, a = nodes[e.u]!.p, b = nodes[e.v]!.p, dx = b[0]-a[0], dy = b[1]-a[1], length = Math.hypot(dx,dy);
    const cuts = nodes.map((n,i)=>({n,i})).filter(({n,i}) => i !== e.u && i !== e.v && Math.hypot(n.p[0]-a[0], n.p[1]-a[1]) + Math.hypot(n.p[0]-b[0], n.p[1]-b[1]) <= length + .002)
      .map(({n,i}) => ({ i, t:(Math.hypot(n.p[0]-a[0], n.p[1]-a[1]) + length - Math.hypot(n.p[0]-b[0], n.p[1]-b[1]))/2 })).sort((x,y)=>x.t-y.t);
    let previous = e.u;
    for (const c of cuts) { if (Math.hypot(nodes[previous]!.p[0]-nodes[c.i]!.p[0], nodes[previous]!.p[1]-nodes[c.i]!.p[1]) < .001) continue; split.push({ wall:e.wall, u:previous, v:c.i }); previous = c.i; }
    if (nodes[previous]!.p[0] !== b[0] || nodes[previous]!.p[1] !== b[1]) split.push({ wall:e.wall, u:previous, v:e.v });
  });
  for (const n of nodes) n.branch = n.walls.length > 2;
  // 有向半边按墙网方向排序；面遍历取“转角最小”的顺时针邻边，得到全部最小面。
  const outgoing: HalfEdge[][] = nodes.map(()=>[]);
  split.forEach((e,index) => {
    const a = nodes[e.u]!.p, b = nodes[e.v]!.p, angle = Math.atan2(b[1]-a[1], b[0]-a[0]);
    outgoing[e.u]!.push({ from:e.u, to:e.v, angle, edge:index });
    outgoing[e.v]!.push({ from:e.v, to:e.u, angle:angle > 0 ? angle - Math.PI : angle + Math.PI, edge:index });
  });
  const halfCount = split.length * 2;
  const id = (h: HalfEdge) => split[h.edge]!.u === h.from && split[h.edge]!.v === h.to ? h.edge * 2 : h.edge * 2 + 1;
  const twin = (h: HalfEdge) => split[h.edge]!.u === h.from && split[h.edge]!.v === h.to ? split[h.edge]!.v : split[h.edge]!.u;
  const next = (h: HalfEdge) => {
    const target = twin(h), candidates = outgoing[target]!, back = h.angle + Math.PI;
    let best: HalfEdge | undefined, bestTurn = Infinity;
    for (const c of candidates) { if (c.edge === h.edge) continue; let turn = back - c.angle; while (turn <= 0) turn += 2*Math.PI; while (turn > 2*Math.PI) turn -= 2*Math.PI; if (turn < bestTurn - 1e-12) { bestTurn = turn; best = c; } }
    if (best) return best;
    // 度为 1 的端点无法成面：沿原边折返终止遍历。
    return outgoing[target]!.find(c => c.edge === h.edge)!;
  };
  const seen = new Set<number>(), all: HalfEdge[] = split.flatMap((e,i) => [{ from:e.u, to:e.v, angle:0, edge:i }, { from:e.v, to:e.u, angle:0, edge:i }]);
  for (const h of all) { const o = outgoing[h.from]!.find(c => c.edge===h.edge)!; h.angle = o.angle; }
  const loops: { half: HalfEdge[]; area: number }[] = [];
  for (const start of all) {
    const startId = id(start); if (seen.has(startId)) continue;
    const half: HalfEdge[] = []; let h = start, guard = 0;
    do { seen.add(id(h)); half.push(h); h = next(h); } while (id(h) !== startId && ++guard <= halfCount);
    if (id(h) !== startId) continue;
    const points = half.map(x => nodes[x.from]!.p);
    if (points.length < 3 || twin(half[0]!) === half[0]!.to && half.length < 2) continue;
    const signed = points.reduce((sum,p,i) => { const q = points[(i+1)%points.length]!; return sum + p[0]*q[1] - q[0]*p[1]; }, 0);
    loops.push({ half, area: signed/2 }); // 逆时针为正：内面；负值为外面或残环
  }
  const inner = loops.filter(l => l.area > 0).sort((a,b) => b.area - a.area);
  const rooms: Room[] = [], rejected = { smallFace:0, invalidBoundary:0 };
  for (const { half } of inner) {
    const ring = half.map(x => ({ p: nodes[x.from]!.p, wall: split[x.edge]!.wall }));
    const simple = simplifyRing(ring);
    const axis: Vec2[] = simple.map(v => v.p), ordered = simple.map(v => v.wall);
    if (polygonArea(axis) < ROOM_MIN_AREA_M2) { rejected.smallFace++; continue; }
    const signed = axis.reduce((sum,p,i) => { const q = axis[(i+1)%axis.length]!; return sum + p[0]*q[1] - q[0]*p[1]; }, 0), sign = signed > 0 ? 1 : -1;
    // 墙轴向房间内侧偏移半墙厚，相邻墙轴交点构成净边界；拒绝无效收缩结果。
    const shifted = axis.map((p,i) => { const q = axis[(i+1)%axis.length]!, dx = q[0]-p[0], dy = q[1]-p[1], len = Math.hypot(dx,dy), d = walls[ordered[i]!]!.thicknessM/2; return { p:[p[0]-sign*dy/len*d, p[1]+sign*dx/len*d] as Vec2, u:[dx,dy] as Vec2 }; });
    const boundary: Vec2[] = []; let valid = true;
    for (let i = 0; i < shifted.length; i++) { const a = shifted[(i+shifted.length-1)%shifted.length]!, b = shifted[i]!, det = a.u[0]*b.u[1]-a.u[1]*b.u[0]; if (Math.abs(det) < 1e-8) { valid = false; break; } const t = ((b.p[0]-a.p[0])*b.u[1]-(b.p[1]-a.p[1])*b.u[0])/det; boundary.push([a.p[0]+a.u[0]*t, a.p[1]+a.u[1]*t]); }
    if (!valid || !validPolygon(boundary) || polygonArea(boundary) >= polygonArea(axis)) { rejected.invalidBoundary++; continue; }
    const wallIds = [...new Set(ordered.map(i => walls[i]!.id))];
    const perimeterM = axis.reduce((sum,p,i) => sum + Math.hypot(axis[(i+1)%axis.length]![0]-p[0], axis[(i+1)%axis.length]![1]-p[1]), 0);
    rooms.push({ id:crypto.randomUUID(), name:`房间 ${rooms.length+1}`, levelId, boundaryM:boundary, heightM:heightM ?? Math.min(...ordered.map(i => walls[i]!.heightM)), evidence:{ ...manualEvidence(m), kind:"inferred" }, loop:{ wallIds, nodesM:axis.map(p => [p[0],p[1]] as Vec2), areaM2:polygonArea(axis), perimeterM } });
  }
  const unclosed = unclosedIssues(m, levelId, walls, nodes, split);
  const degreeHistogram: Record<string, number> = {}; for (const n of nodes) degreeHistogram[String(n.walls.length)] = (degreeHistogram[String(n.walls.length)] ?? 0) + 1;
  return { rooms, unclosedIssues: unclosed, report: { walls: walls.length, nodes: nodes.length, degreeHistogram, faces: inner.length, rooms: rooms.length, rejected, unclosedIssues: { wallGap: unclosed.filter(i=>i.kind==="wall-gap").length, danglingEnd: unclosed.filter(i=>i.kind==="dangling-end").length } } };
}

/**
 * 把面环整理成用于净边界收缩的简单多边形：去掉首尾重复点、T 形处沿原轴往返的“尖刺”
 * 与共线中间点；它们不围出面积，保留会让半墙厚收缩求交退化。墙段归属随顶点保留供追溯。
 */
function simplifyRing(ring: { p: Point; wall: number }[]) {
  let out = ring.slice();
  const near = (a: Point, b: Point) => Math.hypot(a[0]-b[0], a[1]-b[1]) <= 1e-9;
  out = out.filter((v,i) => i === 0 || !near(out[i-1]!.p, v.p));
  while (out.length > 1 && near(out[out.length-1]!.p, out[0]!.p)) out.pop();
  for (let pass = 0; pass < out.length && out.length > 3; pass++) {
    const n = out.length; let cut = -1;
    for (let i = 0; i < n; i++) {
      const a = out[(i+n-1)%n]!.p, b = out[i]!.p, c = out[(i+1)%n]!.p;
      const ux = b[0]-a[0], uy = b[1]-a[1], vx = c[0]-b[0], vy = c[1]-b[1], lu = Math.hypot(ux,uy), lv = Math.hypot(vx,vy);
      if (lu <= 1e-9 || lv <= 1e-9) { cut = i; break; }
      const twist = Math.abs(ux*vy-uy*vx) / (lu*lv), dot = (ux*vx+uy*vy) / (lu*lv);
      if (dot <= -1 + 1e-9 || twist <= 1e-6) { cut = i; break; }
    }
    if (cut < 0) break;
    out.splice(cut, 1);
  }
  return out;
}

/**
 * 未能成面的位置：墙网中度为 1 的悬空端（含单段墙的两端）以及同一墙轴上孤立墙段的两端。
 * 每个位置找最近的另一条墙轴：沿同一墙轴继续（垂距小于墙厚）的延续或洞口记为缺口，
 * 其余记为悬空端；只记录位置、墙段与缺口距离，不补墙、不改几何。
 */
function unclosedIssues(m: BuildingModel, levelId: string, walls: Wall[], nodes: NetNode[], split: NetEdge[]) {
  const issues: UnclosedIssue[] = [];
  const degree = new Map<number, number>(); for (const e of split) { degree.set(e.u, (degree.get(e.u) ?? 0)+1); degree.set(e.v, (degree.get(e.v) ?? 0)+1); }
  // 节点所属墙：悬空端所在的墙不算“最近墙”，否则每段悬空墙都会报出一处零距离缺口。
  const attached = new Map<number, Set<number>>(); for (const e of split) { for (const n of [e.u, e.v]) { if (!attached.has(n)) attached.set(n, new Set()); attached.get(n)!.add(e.wall); } }
  type Lookup = { point: Point; gap: number; wall: number; collinear: boolean };
  const measure = (p: Point, wall: Wall) => {
    const a = wall.axisM[0], b = wall.axisM[1], dx = b[0]-a[0], dy = b[1]-a[1], length = Math.hypot(dx,dy);
    const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (length*length))), q: Point = [a[0]+dx*t, a[1]+dy*t], gap = Math.hypot(p[0]-q[0], p[1]-q[1]);
    // 同一墙轴延续：端点到该墙轴所在直线的垂距小于墙厚，且落在这段墙之外（洞口或接续）。
    const perpendicular = Math.abs((p[0]-a[0])*dy - (p[1]-a[1])*dx) / length, beyond = t <= 1e-9 || t >= 1 - 1e-9;
    return { point:q, gap, collinear:perpendicular <= wall.thicknessM && beyond };
  };
  const nearest = (p: Point, exclude: Set<number>): Lookup | undefined => {
    const candidates: Lookup[] = [];
    let i = 0;
    while (i < walls.length) { const wall = walls[i]!, m = measure(p, wall); if (!exclude.has(i) && m.gap >= 1e-6 && m.gap <= ROOM_UNCLOSED_SEARCH_M) candidates.push({ point:m.point, gap:m.gap, collinear:m.collinear && m.gap <= ROOM_WALL_GAP_M, wall:i }); i++; }
    return candidates.sort((a,b) => a.gap - b.gap)[0];
  };
  const reported = new Set<string>();
  const report = (p: Point, lookup: Lookup, own: number[]) => {
    // 同一条缝从两端都会被走到：按“墙段对 + 位置”去重，避免同一缺口产出两条问题。
    const key = `${[...own, lookup.wall].sort((a,b)=>a-b).join("-")}@${p.map(v=>v.toFixed(2)).join(",")}`;
    if (reported.has(key)) return;
    reported.add(key);
    const kind: UnclosedIssue["kind"] = lookup.collinear ? "wall-gap" : "dangling-end";
    issues.push({ id:crypto.randomUUID(), levelId, kind, pointM:[p[0], p[1]], toM:lookup.point, gapM:Number(lookup.gap.toFixed(4)), wallIds:[...new Set([...own, lookup.wall])].sort((a,b)=>a-b).map(i=>walls[i]!.id), reason:UNCLOSED_REASON[kind](lookup.gap), evidence:{ ...manualEvidence(m), kind:"inferred" } });
  };
  const reportedEnds = new Set<string>();
  for (const [index, n] of nodes.entries()) {
    if ((degree.get(index) ?? 0) !== 1) continue;
    const own = attached.get(index) ?? new Set<number>();
    // 悬空端所在的墙本身不算“最近墙”；两端都悬空的墙再沿墙轴远端与延长方向找接续的墙。
    const found = nearest(n.p, own);
    if (found) { report(n.p, found, [...own]); continue; }
    for (const w of own) {
      const wall = walls[w]!, far = Math.hypot(wall.axisM[0][0]-n.p[0], wall.axisM[0][1]-n.p[1]) < Math.hypot(wall.axisM[1][0]-n.p[0], wall.axisM[1][1]-n.p[1]) ? wall.axisM[1] : wall.axisM[0];
      const length = Math.hypot(far[0]-n.p[0], far[1]-n.p[1]); if (length <= 1e-6) continue;
      const reachDistance = ROOM_UNCLOSED_SEARCH_M * .9, ahead = nearest([n.p[0] + (far[0]-n.p[0]) / length * reachDistance, n.p[1] + (far[1]-n.p[1]) / length * reachDistance], own);
      if (!ahead) continue;
      // 同一缺口从另一端也会被发现：按位置与最近墙去重，避免同一条缝报两条。
      const key = `${w}:${ahead.wall}`;
      if (reportedEnds.has(key)) continue;
      reportedEnds.add(key);
      report([n.p[0] + (far[0]-n.p[0]) / length * reachDistance, n.p[1] + (far[1]-n.p[1]) / length * reachDistance], ahead, [w]);
    }
  }
  return issues.sort((a,b) => (a.gapM ?? 0) - (b.gapM ?? 0)).slice(0, ROOM_UNCLOSED_MAX_PRINT);
}

/** 墙属性更新仅在平面几何变化时重算净边界，同一墙环保留房间身份和净高。 */
export function updateWall(m: BuildingModel, wall: Wall): BuildingModel {
  const old = m.walls.find(w => w.id === wall.id);
  if (!old) throw Error('待修改墙体不存在。');
  const next = {...m, walls: m.walls.map(w => w.id === wall.id ? wall : w)};
  const planarChanged = old.levelId !== wall.levelId || old.thicknessM !== wall.thicknessM || JSON.stringify(old.axisM) !== JSON.stringify(wall.axisM);
  if (!planarChanged && old.heightM === wall.heightM) return next;
  next.openings = m.openings.map(o => o.wallId === wall.id ? {...o, evidence: {...o.evidence, confirmed: false}} : o);
  const affected = new Set([old.levelId, wall.levelId]);
  const staleIssues = (issues: UnclosedIssue[] | undefined) => (issues ?? []).filter(i => !affected.has(i.levelId));
  if (!planarChanged) {
    next.rooms = m.rooms.map(r => affected.has(r.levelId) ? {...r, evidence: {...r.evidence, confirmed: false}} : r);
    next.unclosedIssues = staleIssues(m.unclosedIssues);
    return next;
  }
  // 兼容旧工程：先用旧净边界找回宿主墙环，再按墙 ID 对应新边界；不按数组序号猜测房间。
  const sameBoundary = (a: Vec2[], b: Vec2[]) => a.length === b.length && b.some((_, start) =>
    [1, -1].some(step => a.every((p, i) => {
      const q = b[(start + step * i + b.length) % b.length]!;
      return Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-7;
    })));
  next.rooms = m.rooms.filter(r => !affected.has(r.levelId) || r.evidence.kind !== 'inferred')
    .map(r => affected.has(r.levelId) ? {...r, evidence: {...r.evidence, confirmed: false}} : r);
  const previous = new Map<string, Room>();
  for (const level of affected) for (const c of wallRoomCandidates(m, level)) {
    const room = m.rooms.find(r => r.levelId === level && r.evidence.kind === 'inferred' && sameBoundary(r.boundaryM, c.room.boundaryM));
    if (room) previous.set(c.wallKey, room);
  }
  for (const level of affected) {
    for (const c of wallRoomCandidates(next, level)) {
      const room = previous.get(c.wallKey);
      if (room) next.rooms.push(sameBoundary(room.boundaryM, c.room.boundaryM) && room.levelId === level ? room :
        {...room, levelId: level, boundaryM: c.room.boundaryM, loop: c.room.loop, evidence: {...room.evidence, revision: m.revision, confirmed: false}});
    }
  }
  next.unclosedIssues = [...staleIssues(m.unclosedIssues), ...[...affected].flatMap(level => closeLevel(next, level).unclosedIssues)];
  return next;
}
/** 墙环身份键：组成墙段 ID 排序，几何变化后仍能认出同一房间。 */
function wallRoomCandidates(m: BuildingModel, levelId: string) {
  return closeLevel(m, levelId).rooms.map(room => ({ room, wallKey: JSON.stringify([...(room.loop?.wallIds ?? [])].sort()) }));
}

/** 用户确认类别与边界后转换为待复核构件，不自动标记为已测量或已复核。 */
export function openingFromElevation(m:BuildingModel,wallId:string,c:import('../pipeline/wallElevation').OpeningCandidate,e:import('../pipeline/wallElevation').WallElevation,template:import('./openingTemplates').OpeningTemplateId){
  const wall=m.walls.find(w=>w.id===wallId),floor=m.levels.find(l=>l.id===wall?.levelId);
  if(!wall||!floor||c.kind==='unknown'||e.wallId!==wallId||JSON.stringify(e.axisM)!==JSON.stringify(wall.axisM)||c.supportPoints<20)throw Error('请选择有效墙面证据，并确认候选属于门或窗。');
  if(c.bottomM<floor.elevationM-1e-7||c.bottomM+c.heightM>floor.elevationM+wall.heightM+1e-7)throw Error('候选超出当前墙体标高范围，请先依据立面证据修正楼层标高或墙高。');
  return {id:crypto.randomUUID(),name:(c.kind==='door'?'门':'窗')+' · 立面候选',kind:c.kind,wallId,offsetM:c.offsetM,widthM:c.widthM,heightM:c.heightM,sillM:c.bottomM-floor.elevationM,design:{template,frameWidthM:Math.min(.05,c.widthM/5,c.heightM/5)},evidence:{...manualEvidence(m),kind:'inferred' as const},detection:{method:'wall-elevation/1' as const,cellM:e.options.cellM,slabM:e.options.slabM,sourcePoints:e.sourcePointCount,supportPoints:c.supportPoints,cues:c.cues,proposalM:[c.offsetM,c.bottomM,c.widthM,c.heightM] as [number,number,number,number]}};
}
