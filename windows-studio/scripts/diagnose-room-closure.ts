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
import { buildingFromSegments, roomsFromWalls } from "../src/domain/buildingOps";
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
// 同一输入重放展开后的各阶段计数；墙段与被诊断实现不一致时阶段计数不可用。
const replayed = traceWallLines(working);
if (replayed.segments.length !== fitted.segments.length || !replayed.segments.every((s, i) => distance(s.a, fitted.segments[i]!.a) < 1e-6 && distance(s.b, fitted.segments[i]!.b) < 1e-6)) throw Error("阶段计数实现与 fitWallLines 不一致。");
const segments = fitted.segments;
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
  return { index, a: s.a.map(round) as P, b: s.b.map(round) as P, lengthM: round(length), angleDeg: round(deg), supportCells: s.support, rmsMm: round(s.rmsM * 1000), pointsInThickness: inside, pointsNearBand: near, midpointM: [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2].map(round) as P };
});
// 共线聚类（重复/碎片判定）：方向差 <1.5° 且与簇代表线垂直距离 <0.15 m、投影相接 <0.5 m。
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
// 端点拓扑（当前 roomsFromWalls 口径）：0.2 mm 合并后统计度数，按连通分量给出环/淘汰原因。
const nodes: P[] = [], ends: Array<[number, number]> = [];
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
const building = buildingFromSegments({ name, bytes: stat.size, units: "m" as const, synthetic: false, native: { token: "diagnosis", name, size: stat.size, sha256 } } as never, { elevationM, heightM, thicknessM, levelName: "诊断" }, segments);
const rooms = roomsFromWalls(building, building.levels[0]!.id, heightM);
// 墙网级缺口：链上每个悬空端到最近其它墙轴的端头间距，区分“缺连接”与“缺墙”。
const dangling = new Map<number, string>(); ends.forEach(([a, b], e) => { if (degree[a] === 1) dangling.set(e, "start"); if (degree[b] === 1) dangling.set(e, "end"); });
const chainGaps = [...dangling].map(([index, end]) => {
  const s = segments[index]!, p = end === "start" ? s.a : s.b;
  let best: { nearestWallIndex: number; gapM: number } | undefined;
  segments.forEach((other, i) => { if (i === index) return; const dx = other.b[0] - other.a[0], dy = other.b[1] - other.a[1], length = Math.hypot(dx, dy), t = Math.max(0, Math.min(1, ((p[0] - other.a[0]) * dx + (p[1] - other.a[1]) * dy) / (length * length))), q: P = [other.a[0] + dx * t, other.a[1] + dy * t], gap = distance(p, q); if (!best || gap < best.gapM) best = { nearestWallIndex: i, gapM: round(gap) }; });
  return { wallIndex: index, end, lengthM: round(distance(s.a, s.b)), category: classified[index]!.category, pointM: p.map(round) as P, nearestWallIndex: best?.nearestWallIndex, nearestGapM: best?.gapM };
});
const report = {
  source: { name, bytes: stat.size, sha256, pointCount: working.visible.length, elevationM, heightM, thicknessM },
  timings: { decodeSeconds: round(decodeSeconds), fitSeconds: round(fitSeconds) },
  chain: {
    sourcePoints: working.visible.length, inHeightBandPoints: inBand, evidenceCells: fitted.evidenceCells,
    fittedSegments: segments.length, wallCandidates: segments.length, openingsAutoDetected: 0,
    wallNodes: nodes.length, degreeHistogram, connectedComponents: components.length,
    componentsRejectedAtNonDegree2: components.filter(c => c.rejectedAt === "non-degree-2-node").length,
    componentsRejectedAtTooSmall: components.filter(c => c.rejectedAt === "component-too-small").length,
    closedRings: components.filter(c => c.rejectedAt === "closed-ring").length,
    rooms: rooms.length,
  },
  stages: replayed.trace,
  tally,
  clusters: clusters.map((c, i) => ({ cluster: i, walls: c.members.length, totalLengthM: round(c.members.reduce((sum, m) => sum + metrics[m]!.lengthM, 0)), members: c.members })),
  components, chainGaps, segments: classified,
};
await writeFile(`${out}/diagnosis.json`, JSON.stringify(report, null, 2));
await writeFile(`${out}/segments.json`, JSON.stringify(segments));
const all = segments.flatMap(s => [s.a, s.b]), minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0])), minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1])), pad = Math.max(1, (maxX - minX + maxY - minY) / 40);
const colour: Record<string, string> = { wall: "#dceee8", duplicate: "#e0b25c", artifact: "#c96b6b", suspect: "#7fb0d8" };
await writeFile(`${out}/walls.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" width="1400" height="900"><rect x="${minX - pad}" y="${-maxY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#20282c"/>${segments.map((s, i) => `<line x1="${s.a[0]}" y1="${-s.a[1]}" x2="${s.b[0]}" y2="${-s.b[1]}" stroke="${colour[classified[i]!.category]}" stroke-width="${pad / 120}"><title>#${i} ${classified[i]!.category} ${round(distance(s.a, s.b))}m</title></line>`).join("")}</svg>`);
console.log(JSON.stringify({ source: report.source, chain: report.chain, tally, timings: report.timings }, null, 2));
