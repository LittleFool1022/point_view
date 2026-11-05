/**
 * 真实样本房间最小面复跑：沿 `analysis.worker.ts` 的 building 分支（高度剖切 → fitWallLines）
 * 取墙段，再用同一套墙网几何统计“拼接口径”与“最小面口径”的闭合结果：
 * 连通分量、度 1 悬空端、闭合环数、房间面积/周长、未闭合问题清单。
 *
 * 用法：SURVEY_REAL_FIXTURE=/path/to/file.pcd npm run replay:room-faces
 * 只读源件，不改写它；输出 JSON/SVG 至 artifacts/room-faces/<样本名>/。
 * 墙段来自拟合器当前输出（含其 0.12 m 端点拼接）；只是墙网几何的诊断视角，
 * 不是精度验收，也不构成对拟合/连接规则的修改。
 */
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { readCloud } from "../src/pipeline/binaryPcd";
import { fitWallLines } from "../src/pipeline/wallLines";
import { buildingFromSegments, levelClosure } from "../src/domain/buildingOps";
import { polygonArea, type Vec2 } from "../src/domain/building";
import type { PointCloudData } from "../../src/domain/types";

const file = process.env.SURVEY_REAL_FIXTURE;
if (!file) throw Error("Set SURVEY_REAL_FIXTURE to the original binary PCD.");
const elevationM = Number(process.env.ELEVATION_M ?? 0), heightM = Number(process.env.HEIGHT_M ?? 3), thicknessM = Number(process.env.THICKNESS_M ?? .2);
const name = basename(file), out = `artifacts/room-faces/${name.replace(/\.pcd$/i, "")}`;
await mkdir(out, { recursive: true });
type P = [number, number];
const round = (v: number) => Number(v.toFixed(3)), distance = (a: P, b: P) => Math.hypot(a[0]-b[0], a[1]-b[1]);

const handle = await open(file, "r"), stat = await handle.stat(), hash = createHash("sha256");
for (let offset = 0; offset < stat.size; offset += 64 * 1024 ** 2) { const size = Math.min(64 * 1024 ** 2, stat.size - offset), buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, offset); hash.update(buffer); }
const sha256 = hash.digest("hex"), source = { name, bytes: stat.size, units: "m" as const, synthetic: false, native: { token: "replay", name, size: stat.size, sha256 } };
const started = performance.now();
const decoded = await readCloud(source as never, "m", async (offset, size) => { const b = Buffer.alloc(size); await handle.read(b, 0, size, offset); return b.buffer; }, () => {});
await handle.close();
const decodeSeconds = (performance.now() - started) / 1000;
// 与 analysis.worker.ts 完全相同的剖切方式：保留带内点，其余标为不可见（不改源点）。
const cloud = decoded.cloud, working: PointCloudData = { ...cloud, visible: cloud.visible.slice() };
let inBand = 0;
for (let i = 0; i < working.visible.length; i++) { const z = working.positions[i * 3 + 2]!; if (z < elevationM || z > elevationM + heightM) working.visible[i] = 0; else inBand++; }
const fitStart = performance.now();
const fitted = await fitWallLines(working, () => {});
const fitSeconds = (performance.now() - fitStart) / 1000;
const segments = fitted.segments;

// 墙网节点度数（0.2 mm 合并口径），用于给每段墙标注是否位于闭合环上。
const nodeIndex = (p: P, nodes: P[]) => { let i = nodes.findIndex(q => distance(q, p) < .002); if (i < 0) { nodes.push(p); i = nodes.length - 1; } return i; };
const np: P[] = [], degree: number[] = [], closed = new Set<number>();
for (const s of segments) for (const p of [s.a, s.b]) { const i = nodeIndex(p, np); degree[i] = (degree[i] ?? 0) + 1; }
const building = buildingFromSegments(source as never, { elevationM, heightM, thicknessM, levelName: "复跑" }, segments);
const closure = levelClosure(building, building.levels[0]!.id);
for (const room of building.rooms.filter(r => r.levelId === building.levels[0]!.id)) for (const id of room.loop?.wallIds ?? []) closed.add(building.walls.findIndex(w => w.id === id));
const segmentNodes = segments.map(s => [nodeIndex(s.a, np), nodeIndex(s.b, np)] as [number, number]);

// 拼接口径对照：沿用诊断 PR 的“连通分量全部度为 2 才算闭合环”，两口径在同一组墙段上比较。
const adjacent = np.map(() => [] as number[]); segmentNodes.forEach(([a, b], e) => { adjacent[a]!.push(e); adjacent[b]!.push(e); });
const visited = new Set<number>(); let components = 0, degree2Rings = 0, componentWalls = 0;
for (let edge = 0; edge < segments.length; edge++) {
  if (visited.has(edge)) continue;
  components++; const component: number[] = [], queue = [edge];
  while (queue.length) { const e = queue.pop()!; if (visited.has(e)) continue; visited.add(e); component.push(e); for (const n of segmentNodes[e]!) for (const other of adjacent[n]!) if (!visited.has(other)) queue.push(other); }
  componentWalls = Math.max(componentWalls, component.length);
  if (component.length >= 3 && component.every(e => segmentNodes[e]!.every(n => adjacent[n]!.length === 2))) degree2Rings++;
}
const rooms = building.rooms.filter(r => r.levelId === building.levels[0]!.id);
const issues = building.unclosedIssues ?? [];
const report = {
  source: { name, bytes: stat.size, sha256, pointCount: working.visible.length, elevationM, heightM, thicknessM },
  timings: { decodeSeconds: round(decodeSeconds), fitSeconds: round(fitSeconds) },
  chain: {
    sourcePoints: working.visible.length, inHeightBandPoints: inBand, evidenceCells: fitted.evidenceCells,
    fittedSegments: segments.length, wallNodes: np.length,
    degreeHistogram: degree.reduce<Record<string, number>>((h, d) => ({ ...h, [d]: (h[d] ?? 0) + 1 }), {}),
    // 拼接口径（旧口径）：分量内全部端点度为 2 才算房间。
    legacy: { connectedComponents: components, largestComponentWalls: componentWalls, closedRings: degree2Rings, rooms: 0 },
    // 最小面口径（本口径）：平面图最小面即房间，未成面的缺口/悬空端进入未闭合清单。
    faces: closure.faces, closedRings: rooms.length, rooms: rooms.length, rejected: closure.rejected,
    // 最小面口径也没有房间时，最大的几个面全部按最小面积下限或净边界退化被淘汰，说明墙网里尚未出现可居住的面。
    faceSizes: rooms.length ? rooms.map(r => round(r.loop?.areaM2 ?? 0)) : [],
    unclosedIssues: closure.unclosedIssues, unclosedPrinted: issues.length,
  },
  rooms: rooms.map((r, i) => ({
    index: i, name: r.name, areaM2: round(polygonArea(r.boundaryM)), loopAreaM2: round(r.loop?.areaM2 ?? 0), perimeterM: round(r.loop?.perimeterM ?? 0),
    boundaryM: r.boundaryM.map(p => p.map(round)), nodesM: (r.loop?.nodesM ?? []).map(p => p.map(round)),
    wallIndexes: (r.loop?.wallIds ?? []).map(id => building.walls.findIndex(w => w.id === id)).sort((a, b) => a - b),
  })),
  unclosedIssues: issues.map((i, index) => ({ index, kind: i.kind, gapM: i.gapM, pointM: i.pointM.map(round), toM: i.toM?.map(round), wallIndexes: i.wallIds.map(id => building.walls.findIndex(w => w.id === id)), reason: i.reason })),
  segments: segments.map((s, i) => ({ index: i, a: s.a.map(round) as P, b: s.b.map(round) as P, lengthM: round(distance(s.a, s.b)), support: s.support, rmsMm: round(s.rmsM * 1000), inRoom: closed.has(i) })),
};
await writeFile(`${out}/room-faces.json`, JSON.stringify(report, null, 2));
// 视图：墙轴（灰）、房间最小面（绿）、未闭合位置（红点 + 指向最近墙段的细线）。
const all = segments.flatMap(s => [s.a, s.b]), xs = all.map(p => p[0]), ys = all.map(p => p[1]);
const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), pad = Math.max(1, (maxX - minX + maxY - minY) / 40);
const roomFaces = rooms.map(r => `<polygon points="${(r.loop?.nodesM ?? r.boundaryM).map(p => `${p[0]},${-p[1]}`).join(" ")}" fill="#3fae7a" fill-opacity=".28" stroke="#3fae7a" stroke-width="${pad / 200}"><title>${r.name} ${polygonArea(r.boundaryM).toFixed(2)} m²</title></polygon>`).join("");
const wallsSvg = segments.map((s, i) => `<line x1="${s.a[0]}" y1="${-s.a[1]}" x2="${s.b[0]}" y2="${-s.b[1]}" stroke="${closed.has(i) ? "#dceee8" : "#8e9aa2"}" stroke-width="${pad / 160}"><title>#${i} ${distance(s.a, s.b).toFixed(2)} m</title></line>`).join("");
const issueSvg = issues.map(i => `<g><line x1="${i.pointM[0]}" y1="${-i.pointM[1]}" x2="${i.toM?.[0] ?? i.pointM[0]}" y2="${-(i.toM?.[1] ?? i.pointM[1])}" stroke="#d9534f" stroke-width="${pad / 300}"/><circle cx="${i.pointM[0]}" cy="${-i.pointM[1]}" r="${pad / 90}" fill="#d9534f"><title>${i.kind} ${i.gapM} m：${i.reason}</title></circle></g>`).join("");
await writeFile(`${out}/room-faces.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" width="1400" height="900"><rect x="${minX - pad}" y="${-maxY - pad}" width="${maxX - minX + 2 * pad}" height="${maxY - minY + 2 * pad}" fill="#20282c"/>${roomFaces}${wallsSvg}${issueSvg}</svg>`);
console.log(JSON.stringify({ source: report.source, chain: report.chain, rooms: report.rooms.map(r => ({ name: r.name, areaM2: r.areaM2, perimeterM: r.perimeterM, wallIndexes: r.wallIndexes })), timings: report.timings }, null, 2));
