/**
 * 墙网与房间闭合诊断：沿 高度剖切 → 证据格 → RANSAC/直线 → 分段 → 墙候选 → 端点连接 → 墙网 →
 * 闭合环 → 房间 逐级给出通过/失败计数，并对全部墙候选逐条给出几何与证据度量，
 * 用于复现和解释真实样本“55 个墙候选、0 门窗、0 个闭合房间”。
 *
 * 用法：SURVEY_REAL_FIXTURE=/path/to/file.pcd npm run diagnose:room-closure
 * 只读源件；输出 JSON/SVG 至 artifacts/room-closure/<样本名>/，不改动源点云。
 * 没有 RD-01 独立真值时本脚本只做功能诊断，分类用于定位失败阶段，不构成精度验收。
 */
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { readCloud } from "../src/pipeline/binaryPcd";
import { fitWallLines } from "../src/pipeline/wallLines";
import { DEDUPE_AXIS_GAP_M, DEDUPE_DIRECTION_DEG, DEDUPE_PROJECTION_GAP_M, mergeWallSegments } from "../src/pipeline/wallDedupe";
import { buildWallNetwork } from "../src/pipeline/wallNetwork";
import { buildingFromSegments, levelClosure, roomsFromWalls } from "../src/domain/buildingOps";
import { traceWallLines } from "./replay-wall-lines";
import type { PointCloudData } from "../../src/domain/types";

const file = process.env.SURVEY_REAL_FIXTURE;
if (!file) throw Error("Set SURVEY_REAL_FIXTURE to the original binary PCD.");
const elevationM = Number(process.env.ELEVATION_M ?? 0), heightM = Number(process.env.HEIGHT_M ?? 3), thicknessM = Number(process.env.THICKNESS_M ?? .2);
const name = basename(file), out = `artifacts/room-closure/${name.replace(/\.pcd$/i, "")}`;
await mkdir(out, { recursive: true });
type P = [number, number];
const round = (v: number) => Number(v.toFixed(3)), distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const handle = await open(file, "r"), stat = await handle.stat(), hash = createHash("sha256");
for (let offset = 0; offset < stat.size; offset += 64 * 1024 ** 2) { const size = Math.min(64 * 1024 ** 2, stat.size - offset), buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, offset); hash.update(buffer); }
const sha256 = hash.digest("hex");
const started = performance.now();
const decoded = await readCloud({ name, native: { token: "diagnosis", name, size: stat.size, sha256 } }, "m", async (offset, size) => { const b = Buffer.alloc(size); await handle.read(b, 0, size, offset); return b.buffer; }, () => {});
await handle.close();
const decodeSeconds = (performance.now() - started) / 1000;
const cloud = decoded.cloud, working: PointCloudData = { ...cloud, visible: cloud.visible.slice() };
let inBand = 0;
for (let i = 0; i < working.visible.length; i++) { const z = working.positions[i * 3 + 2]!; if (z < elevationM || z > elevationM + heightM) working.visible[i] = 0; else inBand++; }
const fitStart = performance.now();
const fitted = await fitWallLines(working, () => {});
const fitSeconds = (performance.now() - fitStart) / 1000;
// 同一输入重放展开后的各阶段计数；重放必须与 fitWallLines 逐级一致（拟合段数 → 去重段数 → 连接段数），
// 各级都对上时阶段计数才可信。三级分别是：拟合候选（原 66 条）→ 去重合并后（a）→ 墙网连接后（b）。
const replayed = traceWallLines(working);
const replaySegments = replayed.rawSegments, replayDeduped = replayed.deduped, before = replayDeduped, segments = fitted.segments;
if (replaySegments.length !== fitted.fittedSegments) throw Error("阶段计数实现与 fitWallLines 不一致：拟合段数不同。");
if (replayDeduped.segments.length !== fitted.dedupedSegments) throw Error("阶段计数实现与 fitWallLines 不一致：去重段数不同。");
if (fitted.mergeGroups.length !== replayDeduped.groups.length) throw Error("阶段计数实现与 fitWallLines 不一致：合并组数不同。");
// 连接结果逐段对照（节点顺序与切分方式决定段序，必须一致才能真正比较阶段统计）。
if (replayed.segments.length !== segments.length || !replayed.segments.every((s, i) => distance(s.a, segments[i]!.a) < 1e-6 && distance(s.b, segments[i]!.b) < 1e-6)) throw Error("阶段计数实现与 fitWallLines 的连接结果不一致。");
const mergedMembers = new Set(fitted.mergeGroups.flatMap(g => g.sourceIndexes));
if ([...mergedMembers].some(index => !replaySegments[index])) throw Error("合并来源编号超出拟合输出范围。");
// 连接前后对照：去重合并后的墙候选 → buildWallNetwork（连接后）分别统计节点/端点/分量。
const network = fitted.network;
// 去重去向：每组在连接结果里落到哪些段（子段按去重段号归并），用于逐条核对"被连接吸收还是仍独立"。
const joinedOf = (dedupedIndex: number) => segments.flatMap((s, index) => s.dedupedIndex === dedupedIndex ? [index] : []);
const piecesPerDeduped = segments.reduce<Record<string, number>>((acc, s) => ({ ...acc, [String(s.dedupedIndex)]: (acc[String(s.dedupedIndex)] ?? 0) + 1 }), {});
// 逐段证据：墙厚带内点数决定可否确认为墙；墙厚带外近邻点数决定是否为孤立伪影。
const metrics = segments.map((s, index) => {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], length = Math.hypot(dx, dy), half = thicknessM / 2;
  let inside = 0, near = 0;
  for (let p = 0; p < working.visible.length; p++) {
    if (!working.visible[p]) continue;
    const x = working.positions[p * 3]! - s.a[0], y = working.positions[p * 3 + 1]! - s.a[1], u = (x * dx + y * dy) / length, d = Math.abs(x * dy - y * dx) / length;
    if (u < 0 || u > length) continue;
    if (d <= half) inside++;
    if (d <= .45) near++;
  }
  const deg = ((Math.atan2(dy, dx) * 180 / Math.PI) % 180 + 180) % 180;
  // sources/mergeGroup 把合并结果回指到拟合原始输出编号（diagnosis.json 的 index 与 segments-before-merge.json）。
  return { index, a: s.a.map(round) as P, b: s.b.map(round) as P, lengthM: round(length), angleDeg: round(deg), supportCells: s.support, rmsMm: round(s.rmsM * 1000), pointsInThickness: inside, pointsNearBand: near, midpointM: [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2].map(round) as P, sources: s.sources ?? [index], mergeGroup: s.merge ? before.groups.findIndex(g => g.sourceIndexes[0] === s.sources![0]) : null };
});
// 共线聚类（重复/碎片判定）：方向差 <1.5° 且与簇代表线垂直距离 <0.15 m、投影相接 <0.5 m。
// 这一段沿用诊断口径（含 0.5 m 投影容差），只用于给**合并后**的每条候选标注类别与依据；
// 真正决定合并与否的是 fitWallLines 之后 wallDedupe.ts 的命名常量判据。
const clusters: Array<{ a: P; b: P; angleDeg: number; members: number[] }> = [];
for (const m of [...metrics].sort((x, y) => y.lengthM - x.lengthM)) {
  const target = clusters.find(c => {
    const delta = Math.abs(((m.angleDeg - c.angleDeg) % 180 + 270) % 180 - 90);
    if (delta >= 1.5) return false;
    const gx = c.b[0] - c.a[0], gy = c.b[1] - c.a[1], gl = Math.hypot(gx, gy), ux = gx / gl, uy = gy / gl;
    const projected = [m.a, m.b].map(p => (p[0] - c.a[0]) * ux + (p[1] - c.a[1]) * uy);
    const clearance = Math.min(...[m.a, m.b].map(p => Math.abs((p[0] - c.a[0]) * uy - (p[1] - c.a[1]) * ux)));
    // 投影后两段之间的空隙（相接或重叠时为 0）。
    const gap = Math.max(0, Math.max(Math.min(...projected), 0) - Math.min(Math.max(...projected), gl));
    return clearance < .15 && gap < .5;
  });
  if (target) target.members.push(m.index); else clusters.push({ a: m.a, b: m.b, angleDeg: m.angleDeg, members: [m.index] });
}
const clusterOf = new Map<number, number>(); clusters.forEach((c, i) => c.members.forEach(m => clusterOf.set(m, i)));
const MIN_POINTS_IN_THICKNESS = 500, MIN_POINTS_PER_CELL = 300;
const classified = metrics.map(m => {
  const cluster = clusterOf.get(m.index)!, group = clusters[cluster]!;
  const confirmed = m.pointsInThickness > MIN_POINTS_IN_THICKNESS, isolated = m.pointsNearBand < m.supportCells * MIN_POINTS_PER_CELL;
  if (!confirmed && isolated) return { ...m, cluster, category: "artifact", basis: `墙厚带内 ${m.pointsInThickness} 点，0.45 m 带宽内约 ${(m.pointsNearBand / m.supportCells).toFixed(0)} 点/证据格：孤立或稀疏表面` };
  if (!confirmed) return { ...m, cluster, category: "suspect", basis: `墙厚带内 ${m.pointsInThickness} 点：证据不足且无明显孤立特征` };
  if (group.members.length > 1 && group.members[0] !== m.index) return { ...m, cluster, category: "duplicate", basis: `与 #${group.members[0]} 共线（方向差 <1.5°、间距 <0.15 m、投影相接），该组 ${group.members.length} 段` };
  return { ...m, cluster, category: "wall", basis: `墙厚带内 ${m.pointsInThickness} 点（${(m.pointsInThickness / m.supportCells).toFixed(0)} 点/证据格），跨高度证据 ${m.supportCells} 格` };
});
const tally: Record<string, number> = { wall: 0, duplicate: 0, artifact: 0, suspect: 0 };
for (const c of classified) tally[c.category] = (tally[c.category] ?? 0) + 1;
// 合并前每段的类别沿用同一分类函数（逐段证据与诊断共线簇口径），用于给出"合并前 30 条重复"与合并后逐组对照。
const metricsBefore = replaySegments.map((s, index) => {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], length = Math.hypot(dx, dy), half = thicknessM / 2;
  let inside = 0, near = 0;
  for (let p = 0; p < working.visible.length; p++) {
    if (!working.visible[p]) continue;
    const x = working.positions[p * 3]! - s.a[0], y = working.positions[p * 3 + 1]! - s.a[1], u = (x * dx + y * dy) / length, d = Math.abs(x * dy - y * dx) / length;
    if (u < 0 || u > length) continue;
    if (d <= half) inside++;
    if (d <= .45) near++;
  }
  return { index, a: s.a, b: s.b, lengthM: length, supportCells: s.support, pointsInThickness: inside, pointsNearBand: near };
});
const clustersBefore: Array<{ a: P; b: P; angleDeg: number; members: number[] }> = [];
for (const m of [...metricsBefore].sort((x, y) => y.lengthM - x.lengthM)) {
  const deg = ((Math.atan2(m.b[1] - m.a[1], m.b[0] - m.a[0]) * 180 / Math.PI) % 180 + 180) % 180;
  const target = clustersBefore.find(c => {
    const delta = Math.abs(((deg - c.angleDeg) % 180 + 270) % 180 - 90);
    if (delta >= 1.5) return false;
    const gx = c.b[0] - c.a[0], gy = c.b[1] - c.a[1], gl = Math.hypot(gx, gy), ux = gx / gl, uy = gy / gl;
    const projected = [m.a, m.b].map(p => (p[0] - c.a[0]) * ux + (p[1] - c.a[1]) * uy);
    const clearance = Math.min(...[m.a, m.b].map(p => Math.abs((p[0] - c.a[0]) * uy - (p[1] - c.a[1]) * ux)));
    const gap = Math.max(0, Math.max(Math.min(...projected), 0) - Math.min(Math.max(...projected), gl));
    return clearance < .15 && gap < .5;
  });
  if (target) target.members.push(m.index); else clustersBefore.push({ a: m.a as P, b: m.b as P, angleDeg: deg, members: [m.index] });
}
const clusterOfBefore = new Map<number, number>(); clustersBefore.forEach((c, i) => c.members.forEach(m => clusterOfBefore.set(m, i)));
const classifiedBefore = new Map(metricsBefore.map(m => {
  const group = clustersBefore[clusterOfBefore.get(m.index)!]!;
  const confirmed = m.pointsInThickness > MIN_POINTS_IN_THICKNESS, isolated = m.pointsNearBand < m.supportCells * MIN_POINTS_PER_CELL;
  const category = !confirmed && isolated ? "artifact" : !confirmed ? "suspect" : group.members.length > 1 && group.members[0] !== m.index ? "duplicate" : "wall";
  return [m.index, category] as const;
}));
const tallyBefore: Record<string, number> = { wall: 0, duplicate: 0, artifact: 0, suspect: 0 };
for (const c of classifiedBefore.values()) tallyBefore[c] = (tallyBefore[c] ?? 0) + 1;

// 端点拓扑（当前 roomsFromWalls 口径）：0.2 mm 合并后统计度数，按连通分量给出环/淘汰原因。
const nodes: P[] = [], ends: Array<[number, number]> = [], beforeNodes: P[] = [], beforeEnds: Array<[number, number]> = [];
for (const s of replaySegments) { const at = (p: P) => { const i = beforeNodes.findIndex(q => distance(q, p) < .002); if (i < 0) { beforeNodes.push(p); return beforeNodes.length - 1; } return i; }; beforeEnds.push([at(s.a), at(s.b)]); }
for (const s of segments) { const at = (p: P) => { const i = nodes.findIndex(q => distance(q, p) < .002); if (i < 0) { nodes.push(p); return nodes.length - 1; } return i; }; ends.push([at(s.a), at(s.b)]); }
const degree = nodes.map(() => 0); for (const [a, b] of ends) { degree[a]!++; degree[b]!++; }
const degreeHistogram: Record<string, number> = {}; for (const d of degree) degreeHistogram[d] = (degreeHistogram[d] ?? 0) + 1;
const adjacent = nodes.map(() => [] as number[]); ends.forEach(([a, b], e) => { adjacent[a]!.push(e); adjacent[b]!.push(e); });
const visited = new Set<number>(), components: Array<{ walls: number; rejectedAt: string; openNodes: number; lengthM: number; wallIndexes: number[] }> = [];
for (let edge = 0; edge < ends.length; edge++) {
  if (visited.has(edge)) continue;
  const component: number[] = [], queue = [edge];
  while (queue.length) { const e = queue.pop()!; if (visited.has(e)) continue; visited.add(e); component.push(e); for (const n of ends[e]!) for (const other of adjacent[n]!) if (!visited.has(other)) queue.push(other); }
  const open = [...new Set(component.flatMap(e => ends[e]!.filter(n => adjacent[n]!.length !== 2)))];
  components.push({ walls: component.length, rejectedAt: component.length < 3 ? "component-too-small" : open.length ? "non-degree-2-node" : "closed-ring", openNodes: open.length, lengthM: round(component.reduce((sum, e) => sum + distance(segments[e]!.a, segments[e]!.b), 0)), wallIndexes: component });
}
const source = { name, bytes: stat.size, units: "m" as const, synthetic: false, native: { token: "diagnosis", name, size: stat.size, sha256 } } as never;
const building = buildingFromSegments(source, { elevationM, heightM, thicknessM, levelName: "诊断" }, segments);
const levelId = building.levels[0]!.id;
// 房间取墙网平面图最小面（修复 c）；同时保留"分量全部度为 2"的旧口径环数，两者在同一组墙段上对照。
const closure = levelClosure(building, levelId);
const rooms = roomsFromWalls(building, levelId, heightM);
// 合体对照：同一原件在"只去重（a）"与"只连接（b）"两种单跑条件下能得到的房间数，用于解释三者叠合的增量。
const soloDedupe = (() => { const b = buildingFromSegments(source, { elevationM, heightM, thicknessM, levelName: "a" }, before.segments); return { walls: before.segments.length, rooms: b.rooms.length }; })();
const soloJoin = (() => { const m = buildingFromSegments(source, { elevationM, heightM, thicknessM, levelName: "b" }, replayed.network.segments.map(({ a, b, support, rmsM }) => ({ a, b, support, rmsM, sources: undefined, merge: null }))); return { walls: replayed.network.segments.length, rooms: m.rooms.length }; })();
// 墙网级缺口：链上每个悬空端到最近其它墙轴的端头间距，区分“缺连接”与“缺墙”。
const dangling = new Map<number, string>(); ends.forEach(([a, b], e) => { if (degree[a] === 1) dangling.set(e, "start"); if (degree[b] === 1) dangling.set(e, "end"); });
const chainGaps = [...dangling].map(([index, end]) => {
  const s = segments[index]!, p = end === "start" ? s.a : s.b;
  let best: { nearestWallIndex: number; gapM: number } | undefined;
  segments.forEach((other, i) => { if (i === index) return; const dx = other.b[0] - other.a[0], dy = other.b[1] - other.a[1], length = Math.hypot(dx, dy), t = Math.max(0, Math.min(1, ((p[0] - other.a[0]) * dx + (p[1] - other.a[1]) * dy) / (length * length))), q: P = [other.a[0] + dx * t, other.a[1] + dy * t], gap = distance(p, q); if (!best || gap < best.gapM) best = { nearestWallIndex: i, gapM: round(gap) }; });
  return { wallIndex: index, end, lengthM: round(distance(s.a, s.b)), category: classified[index]!.category, pointM: p.map(round) as P, nearestWallIndex: best?.nearestWallIndex, nearestGapM: best?.gapM };
});
function beforeTopology(list: ReadonlyArray<{ a: P; b: P }>) {
  const pts: P[] = [], pairs: Array<[number, number]> = [];
  for (const s of list) { const at = (p: P) => { const i = pts.findIndex(q => distance(q, p) < .002); if (i < 0) { pts.push(p); return pts.length - 1; } return i; }; pairs.push([at(s.a), at(s.b)]); }
  const deg = pts.map(() => 0); for (const [a, b] of pairs) { deg[a]!++; deg[b]!++; }
  const adj = pts.map(() => [] as number[]); pairs.forEach(([a, b], e) => { adj[a]!.push(e); adj[b]!.push(e); });
  const seen = new Set<number>(); let components = 0;
  for (let e = 0; e < pairs.length; e++) { if (seen.has(e)) continue; components++; const q = [e]; while (q.length) { const k = q.pop()!; if (seen.has(k)) continue; seen.add(k); for (const n of pairs[k]!) for (const o of adj[n]!) if (!seen.has(o)) q.push(o); } }
  return { edges: pairs.length, wallNodes: pts.length, degreeHistogram: deg.reduce((acc: Record<string, number>, d) => ({ ...acc, [d]: (acc[d] ?? 0) + 1 }), {}), openEndpoints: deg.filter(d => d === 1).length, connectedComponents: components };
}
const report = {
  source: { name, bytes: stat.size, sha256, pointCount: working.visible.length, elevationM, heightM, thicknessM },
  timings: { decodeSeconds: round(decodeSeconds), fitSeconds: round(fitSeconds) },
  dedupe: {
    // 判据是功能参数（同一墙轴/同一道墙的尺度），不是精度阈值。
    criteria: { directionDeg: DEDUPE_DIRECTION_DEG, axisGapM: DEDUPE_AXIS_GAP_M, projectionGapM: DEDUPE_PROJECTION_GAP_M },
    fittedSegments: fitted.fittedSegments, mergedSegments: segments.length, removedSegments: fitted.fittedSegments - segments.length,
    groups: fitted.mergeGroups.length,
    // 按 `sources[0]` 索引合并结果与原段，避免用下标假设顺序。
    groupDetail: fitted.mergeGroups.map(g => {
      const merged = segments.find(s => s.sources?.[0] === g.sourceIndexes[0])!, length = distance(merged.a, merged.b);
      const originals = new Map(replaySegments.map((s, index) => [index, s]));
      const ux = (merged.b[0] - merged.a[0]) / length, uy = (merged.b[1] - merged.a[1]) / length;
      let inside = true, maxOutsideM = 0, maxSideM = 0;
      for (const index of g.sourceIndexes) for (const p of [originals.get(index)!.a, originals.get(index)!.b]) {
        const t = (p[0] - merged.a[0]) * ux + (p[1] - merged.a[1]) * uy, side = Math.abs((p[0] - merged.a[0]) * uy - (p[1] - merged.a[1]) * ux);
        const outside = Math.max(0, -t, t - length); if (outside > 1e-6) inside = false;
        maxOutsideM = Math.max(maxOutsideM, outside); maxSideM = Math.max(maxSideM, side);
      }
      return { ...g, categories: g.sourceIndexes.map(index => classifiedBefore.get(index) ?? "unclassified"), mergedA: merged.a.map(round) as P, mergedB: merged.b.map(round) as P, mergedLengthM: round(length), originalsInsideMerged: inside, maxOutsideM: round(maxOutsideM), maxSourceSideOffsetM: round(maxSideM) };
    }),
  },
  chain: {
    // 1) 拟合候选（去重前）：无任何端点连接时的拓扑。
    fitted: beforeTopology(replaySegments),
    // 2) 去重合并后（修复 a）：同一墙轴重复段合并的墙候选拓扑。
    deduped: { ...beforeTopology(before.segments), mergedGroups: fitted.mergeGroups.length },
    // 3) 墙网连接后（修复 b：沿轴延长、T 形插节点、门口不连）。
    joined: { edges: network.edges, wallNodes: network.nodes.length, degreeHistogram: network.nodes.reduce((acc: Record<string, number>, n) => ({ ...acc, [n.degree]: (acc[n.degree] ?? 0) + 1 }), {}), join: network.join, unclosed: network.unclosed },
    // 4) 角部断点清单（修复 d）：逐对给出坐标/夹角/交点距离/证据与处理结果，与 unclosed 同一来源、同一清单口径。
    corners: {
      candidates: network.join.cornerCandidates, joined: network.join.corners,
      byOutcome: network.corners.reduce((acc: Record<string, number>, c) => ({ ...acc, [c.outcome === "joined" ? "joined" : `skipped:${c.reason}`]: (acc[c.outcome === "joined" ? "joined" : `skipped:${c.reason}`] ?? 0) + 1 }), {}),
      // 未闭合清单里按角部口径记录的原因条数（与 unclosed 同一数组，不另立口径）。
      unclosedByCornerReason: network.unclosed.reduce((acc: Record<string, number>, u) => (u.corner ? { ...acc, [u.corner]: (acc[u.corner] ?? 0) + 1 } : acc), {}),
      pairs: network.corners,
    },
    sourcePoints: working.visible.length, inHeightBandPoints: inBand, evidenceCells: fitted.evidenceCells,
    fittedSegments: fitted.fittedSegments, dedupedSegments: fitted.dedupedSegments, joinedSegments: segments.length, mergedGroups: fitted.mergeGroups.length,
    wallCandidates: segments.length, openingsAutoDetected: 0,
    wallNodes: nodes.length, degreeHistogram, connectedComponents: components.length,
    componentsRejectedAtNonDegree2: components.filter(c => c.rejectedAt === "non-degree-2-node").length,
    componentsRejectedAtTooSmall: components.filter(c => c.rejectedAt === "component-too-small").length,
    closedRings: components.filter(c => c.rejectedAt === "closed-ring").length,
    // 房间：修复 c 的最小面口径为准；旧度 2 环口径同时给出。
    rooms: rooms.length, legacyDegree2Rings: components.filter(c => c.rejectedAt === "closed-ring").length,
    closure,
    solo: { dedupeOnly: soloDedupe, joinOnly: soloJoin },
  },
  rooms: rooms.map((r, i) => ({ index: i, name: r.name, areaM2: round(r.loop?.areaM2 ?? 0), perimeterM: round(r.loop?.perimeterM ?? 0), boundaryM: r.boundaryM.map(p => p.map(round) as P), nodesM: (r.loop?.nodesM ?? []).map(p => p.map(round) as P), wallIndexes: [...new Set((r.loop?.wallIds ?? []).map(id => building.walls.findIndex(w => w.id === id)))].sort((x, y) => x - y) })),
  unclosedIssues: (building.unclosedIssues ?? []).map((i, index) => ({ index, kind: i.kind, gapM: i.gapM, pointM: i.pointM.map(round) as P, toM: i.toM?.map(round) as P | undefined, wallIndexes: i.wallIds.map(id => building.walls.findIndex(w => w.id === id)), reason: i.reason })),
  // 去重去向：每个去重结果段在连接结果里变成几段、是否仍是悬空端、是否落在某个房间的面环上。
  dedupeOutcome: before.segments.map((s, i) => {
    const joined = joinedOf(i), inRoom = (building.rooms ?? []).some(r => joined.some(j => r.loop?.wallIds.includes(building.walls[j]?.id ?? "")));
    const pieces = joined.map(j => ({ index: j, a: segments[j]!.a.map(round) as P, b: segments[j]!.b.map(round) as P, sources: segments[j]!.sources ?? [] }));
    // 自由端：该去重段在连接结果里的端点中，除同段子段首尾相接外没有其它墙端重合（0.2 mm 口径）。
    const endsOf = joined.flatMap(j => [segments[j]!.a, segments[j]!.b] as P[]);
    const freeEnds = endsOf.filter(p => endsOf.filter(q => distance(q, p) < .002).length === 1).length;
    return { dedupedIndex: i, sources: s.sources, merged: !!s.merge, a: s.a.map(round) as P, b: s.b.map(round) as P, lengthM: round(distance(s.a, s.b)), joinedPieces: pieces, splitCount: joined.length, inRoom, freeEnds };
  }),
  stages: replayed.trace,
  categoriesBefore: Array.from(classifiedBefore, ([index, category]) => { const f = replaySegments[index]!; return { index, category, lengthM: round(distance(f.a, f.b)), a: f.a.map(round) as P, b: f.b.map(round) as P }; }),
  tally,
  clusters: clusters.map((c, i) => ({ cluster: i, walls: c.members.length, totalLengthM: round(c.members.reduce((sum, m) => sum + metrics[m]!.lengthM, 0)), members: c.members })),
  components, chainGaps, segments: classified,
};
await writeFile(`${out}/diagnosis.json`, JSON.stringify(report, null, 2));
await writeFile(`${out}/segments.json`, JSON.stringify(segments));
await writeFile(`${out}/segments-before-merge.json`, JSON.stringify(replaySegments));
const all = segments.flatMap(s => [s.a, s.b]), minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0])), minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1])), pad = Math.max(1, (maxX - minX + maxY - minY) / 40);
const colour: Record<string, string> = { wall: "#dceee8", duplicate: "#e0b25c", artifact: "#c96b6b", suspect: "#7fb0d8" };
await writeFile(`${out}/walls-candidates.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" width="1400" height="900"><rect x="${minX - pad}" y="${-maxY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#20282c"/>${replaySegments.map((s) => `<line x1="${s.a[0]}" y1="${-s.a[1]}" x2="${s.b[0]}" y2="${-s.b[1]}" stroke="#dceee8" stroke-width="${pad / 200}"/>`).join("")}</svg>`);
await writeFile(`${out}/walls.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" width="1400" height="900"><rect x="${minX - pad}" y="${-maxY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#20282c"/>${segments.map((s, i) => `<line x1="${s.a[0]}" y1="${-s.a[1]}" x2="${s.b[0]}" y2="${-s.b[1]}" stroke="${colour[classified[i]!.category]}" stroke-width="${pad / 120}"><title>#${i} ${classified[i]!.category} ${round(distance(s.a, s.b))}m</title></line>`).join("")}</svg>`);
// 三级对照视图（同一视图范围、同一原件）：
// walls-candidates.svg 拟合候选（去重前）→ walls-before-merge.svg 去重合并后墙候选 → walls-joined.svg 连接后墙网+节点。
await writeFile(`${out}/walls-candidates.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" width="1400" height="900"><rect x="${minX - pad}" y="${-maxY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#20282c"/>${replaySegments.map((s, i) => `<line x1="${s.a[0]}" y1="${-s.a[1]}" x2="${s.b[0]}" y2="${-s.b[1]}" stroke="${colour[classifiedBefore.get(i) ?? "suspect"]}" stroke-width="${pad / 200}"><title>#${i} ${classifiedBefore.get(i)} ${round(distance(s.a, s.b))}m</title></line>`).join("")}</svg>`);
await writeFile(`${out}/walls-before-merge.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" width="1400" height="900"><rect x="${minX - pad}" y="${-maxY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#20282c"/>${before.segments.map((s, i) => `<line x1="${s.a[0]}" y1="${-s.a[1]}" x2="${s.b[0]}" y2="${-s.b[1]}" stroke="${s.merge ? "#e0b25c" : "#dceee8"}" stroke-width="${pad / 160}"><title>去重段 #${i} ← ${s.sources.join(",")} ${round(distance(s.a, s.b))}m</title></line>`).join("")}</svg>`);
// 连接前后的墙网视图：连接后按度数着色画墙段 + 节点圆点，便于对照节点数/度数变化。
const colourDegree = (d: number) => (d >= 3 ? "#7fd8c0" : d === 2 ? "#dceee8" : "#e0b25c");
await writeFile(`${out}/walls-joined.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" width="1400" height="900"><rect x="${minX - pad}" y="${-maxY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#20282c"/>${network.segments.map((s) => `<line x1="${s.a[0]}" y1="${-s.a[1]}" x2="${s.b[0]}" y2="${-s.b[1]}" stroke="#dceee8" stroke-width="${pad / 200}"/>`).join("")}${network.nodes.map((n) => `<circle cx="${n.p[0]}" cy="${-n.p[1]}" r="${pad / 130}" fill="${colourDegree(n.degree)}"/>`).join("")}</svg>`);
console.log(JSON.stringify({ source: report.source, dedupe: { criteria: report.dedupe.criteria, fittedSegments: fitted.fittedSegments, dedupedSegments: fitted.dedupedSegments, groups: report.dedupe.groups }, chain: report.chain, tallyBeforeMerge: tallyBefore, tally, timings: report.timings }, null, 2));
