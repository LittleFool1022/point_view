/**
 * RD-02 可复现实测脚本：真实样本 2000 万点，全量解码后在“真实建筑范围”内跑墙候选，
 * 再用工程现有框选清理能力（RegionClipRule）删除选定的窗外/室外杂点区域，复跑墙候选并逐段对照。
 *
 * 用法（需在工作目录 windows-studio/ 下执行，开发依赖已安装）：
 *   SURVEY_REAL_FIXTURE=<原件.pcd> SURVEY_WORKSPACE=<输出目录> \
 *   SURVEY_REGIONS='[{"id":"A0","label":"...","x":[33,45],"y":[-3,2.5],"z":[-10,20],"basis":"..."}]' \
 *   npm run cleanup:case-study
 * 可选环境变量：ELEVATION_M / HEIGHT_M / THICKNESS_M（默认 0 / 3 / 0.2）、SURVEY_SEED（默认 [12.5,-2.5]）、
 *   SURVEY_ARTIFACT_BOXES（如 [{"id":"#6","box":[-5.1,-2.4,-3.1,-1.5]}]，核对指定伪影段在清理前后是否仍在）。
 * 只读源件；输出写入 SURVEY_WORKSPACE（默认 artifacts/cleanup-case-study/<样本名>）。
 * 未验证范围：Windows/Electron 实机保存重开、界面交互；本脚本不改动任何源点云或工程文件。
 */
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { PNG } from "pngjs";
import { readCloud } from "../src/pipeline/binaryPcd";
import { fitWallLines, type WallSegment } from "../src/pipeline/wallLines";
import { ClipState, type RegionClipRule } from "../src/domain/cleaning";
import { buildingFromSegments, levelClosure, roomsFromWalls } from "../src/domain/buildingOps";
import type { PointCloudData } from "../../src/domain/types";
import type { SurveySource } from "../src/domain/project";

type P = [number, number];
const file = process.env.SURVEY_REAL_FIXTURE;
if (!file) throw Error("Set SURVEY_REAL_FIXTURE to the original binary PCD.");
const name = basename(file);
const out = process.env.SURVEY_WORKSPACE ?? `artifacts/cleanup-case-study/${name.replace(/\.pcd$/i, "")}`;
await mkdir(out, { recursive: true });
const elevationM = Number(process.env.ELEVATION_M ?? 0), heightM = Number(process.env.HEIGHT_M ?? 3), thicknessM = Number(process.env.THICKNESS_M ?? .2);
const round = (v: number, n = 3) => Number(v.toFixed(n));
const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---- 1. 源件只读核对 ----
const handle = await open(file, "r"), stat = await handle.stat(), hash = createHash("sha256");
for (let offset = 0; offset < stat.size; offset += 64 * 1024 ** 2) { const size = Math.min(64 * 1024 ** 2, stat.size - offset), buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, offset); hash.update(buffer); }
const sha256Before = hash.digest("hex");
const decodeStart = performance.now();
const decoded = await readCloud({ name, native: { token: "cleanup", name, size: stat.size, sha256: sha256Before } }, "m", async (offset, size) => { const b = Buffer.alloc(size); await handle.read(b, 0, size, offset); return b.buffer; }, () => {});
const decodeSeconds = (performance.now() - decodeStart) / 1000;
await handle.close();
const cloud = decoded.cloud;

// ---- 2. 真实建筑范围：全量 30 cm 栅格，按 1 m 窗口点密度取“连片高密度”包络 ----
// 采样视野外的稀疏/漂浮点不会因此被删除；真实建筑范围只用于拟合，与工程内“保留框内”口径一致。
const envelope = (c: PointCloudData, seed: P, cell = .3, window = 1, minPointsPerM2 = 500) => {
  const min: P = [Infinity, Infinity], max: P = [-Infinity, -Infinity];
  for (let i = 0; i < c.visible.length; i++) { if (!c.visible[i]) continue; const x = c.positions[i * 3]!, y = c.positions[i * 3 + 1]!; min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x); min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y); }
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1, ny = Math.ceil((max[1] - min[1]) / cell) + 1, cells = new Uint32Array(nx * ny);
  for (let i = 0; i < c.visible.length; i++) if (c.visible[i]) cells[Math.floor((c.positions[i * 3 + 1]! - min[1]) / cell) * nx + Math.floor((c.positions[i * 3]! - min[0]) / cell)]!++;
  const ring = Math.round(window / cell), gx = Math.floor((nx - ring) / ring), gy = Math.floor((ny - ring) / ring);
  const dense = (wx: number, wy: number) => { let total = 0; for (let dy = 0; dy < ring; dy++) for (let dx = 0; dx < ring; dx++) total += cells[(wy * ring + dy) * nx + wx * ring + dx]!; return total >= minPointsPerM2 * window * window; };
  // 只取包含种子点的连片高密度窗口（8 邻接），避免把视野外零散漂浮点并入建筑范围。
  const seen = new Uint8Array(gx * gy), sx = Math.max(0, Math.min(gx - 1, Math.floor((seed[0] - min[0]) / window))), sy = Math.max(0, Math.min(gy - 1, Math.floor((seed[1] - min[1]) / window)));
  const queue: number[] = [], box: { min: P; max: P } = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] }, bands: Array<{ x: P; y: P; points: number }> = [];
  let start = -1;
  for (let r = 0; r <= Math.max(gx, gy) && start < 0; r++) for (let dy = -r; dy <= r && start < 0; dy++) for (let dx = -r; dx <= r && start < 0; dx++) { const wx = sx + dx, wy = sy + dy; if (wx < 0 || wy < 0 || wx >= gx || wy >= gy) continue; if (dense(wx, wy)) start = wy * gx + wx; }
  if (start < 0) throw Error("种子点附近没有高密度区域，请检查建筑范围。");
  queue.push(start); seen[start] = 1;
  while (queue.length) {
    const k = queue.pop()!, wx = k % gx, wy = Math.floor(k / gx);
    let total = 0; for (let dy = 0; dy < ring; dy++) for (let dx = 0; dx < ring; dx++) total += cells[(wy * ring + dy) * nx + wx * ring + dx]!;
    const x0 = min[0] + wx * window, y0 = min[1] + wy * window, x1 = x0 + window, y1 = y0 + window;
    box.min[0] = Math.min(box.min[0], x0); box.min[1] = Math.min(box.min[1], y0); box.max[0] = Math.max(box.max[0], x1); box.max[1] = Math.max(box.max[1], y1);
    bands.push({ x: [x0, x1], y: [y0, y1], points: total });
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const w2 = wx + dx, h2 = wy + dy; if (w2 < 0 || h2 < 0 || w2 >= gx || h2 >= gy) continue; const k2 = h2 * gx + w2; if (!seen[k2] && dense(w2, h2)) { seen[k2] = 1; queue.push(k2); } }
  }
  return { ...box, bands, seed };
};
const envelopeStart = performance.now();
const seed: P = JSON.parse(process.env.SURVEY_SEED ?? "[12.5,-2.5]");
const buildingBox = envelope(cloud, seed);
const envelopeSeconds = (performance.now() - envelopeStart) / 1000;
const inBox = (x: number, y: number) => x >= buildingBox.min[0] && x <= buildingBox.max[0] && y >= buildingBox.min[1] && y <= buildingBox.max[1];
const countInBox = (c: PointCloudData) => { let n = 0; for (let i = 0; i < c.visible.length; i++) if (c.visible[i] && inBox(c.positions[i * 3]!, c.positions[i * 3 + 1]!)) n++; return n; };

// ---- 3. 选定区域：坐标、Z 范围与入选理由全部来自命令行，并随 JSON 落盘，他人可逐项重做 ----
// 清理只用工程现有 RegionClipRule（俯视正交投影矩形，穿透视线全部深度），与 CloudView 的框选同一实现。
const regions = JSON.parse(process.env.SURVEY_REGIONS ?? "[]") as Array<{ id: string; label: string; x: P; y: P; z: P; basis: string }>;
if (!regions.length) throw Error("Set SURVEY_REGIONS to the selected region list (JSON).");
const box = buildingBox, w = box.max[0] - box.min[0], h = box.max[1] - box.min[1], cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;
// 与 CloudView 俯视一致的 NDC 映射（正交俯视，覆盖整个建筑范围）。
const ruleFor = (region: { x: P; y: P }): RegionClipRule => { const r = [(region.x[0] - cx) * 2 / w, (region.y[0] - cy) * 2 / h, (region.x[1] - cx) * 2 / w, (region.y[1] - cy) * 2 / h].map(v => Math.max(-1, Math.min(1, v))) as [number, number, number, number]; return { matrix: [2 / w, 0, 0, 0, 0, 2 / h, 0, 0, 0, 0, 1, 0, -2 * cx / w, -2 * cy / h, 0, 1], rect: r, mode: "remove" }; };

// ---- 4. 墙候选链路（与 analysis.worker.ts 的 building 分支同一顺序：高度剖切 → fitWallLines → buildingFromSegments → roomsFromWalls）----
const source = { name, units: "m", synthetic: false, native: { token: "cleanup", name, size: stat.size, sha256: sha256Before } } as SurveySource;
const options = { elevationM, heightM, thicknessM, levelName: "清理案例" };
async function runChain(visible: Uint8Array) {
  const working: PointCloudData = { ...cloud, visible: visible.slice() };
  let band = 0;
  for (let i = 0; i < working.visible.length; i++) if (working.visible[i]) { const z = working.positions[i * 3 + 2]!; if (z < elevationM || z > elevationM + heightM) working.visible[i] = 0; else if (inBox(working.positions[i * 3]!, working.positions[i * 3 + 1]!)) band++; }
  const started = performance.now();
  const fitted = await fitWallLines(working, () => {});
  const fitSeconds = (performance.now() - started) / 1000;
  const building = buildingFromSegments(source, options, fitted.segments);
  const rooms = roomsFromWalls(building, building.levels[0]!.id, heightM);
  const report = levelClosure(building, building.levels[0]!.id);
  return { working, fitted, band, fitSeconds, segments: fitted.segments, rooms: rooms.length, unclosedIssues: building.unclosedIssues?.length ?? 0, closure: report, evidenceCells: fitted.evidenceCells, fittedSegments: fitted.fittedSegments ?? fitted.segments.length, dedupedSegments: fitted.dedupedSegments ?? fitted.segments.length };
}
const baseline = await runChain(Uint8Array.from(cloud.visible));

// ---- 5. 清理：只用工程现有框选剔除 ----
const regionStats = regions.map(region => {
  let points = 0, inBand = 0;
  for (let i = 0; i < cloud.visible.length; i++) {
    const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!, z = cloud.positions[i * 3 + 2]!;
    if (x < region.x[0] || x > region.x[1] || y < region.y[0] || y > region.y[1] || z < region.z[0] || z > region.z[1]) continue;
    points++; if (z >= elevationM && z <= elevationM + heightM) inBand++;
  }
  return { ...region, points, inHeightBandPoints: inBand };
});
// 清理只作用于工程内数据：Z 范围先按产品“高度范围”裁剪，再在框内按投影矩形剔除（同一 pointInClip 实现）。
const cleaned = Uint8Array.from(cloud.visible), removalLog: Array<{ region: string; removed: number }> = [];
let removed = 0;
for (const region of regionStats) {
  const rule = ruleFor(region);
  const band: PointCloudData = { ...cloud, visible: Uint8Array.from(cleaned) };
  for (let i = 0; i < band.visible.length; i++) { const z = band.positions[i * 3 + 2]!; if (band.visible[i] && (z < region.z[0] || z > region.z[1])) band.visible[i] = 0; }
  const hit = new ClipState(band).sync([rule]);
  let count = 0;
  for (let i = 0; i < cleaned.length; i++) if (band.visible[i]) cleaned[i] = 1; else if (cleaned[i] && band.positions[i * 3 + 2]! >= region.z[0] && band.positions[i * 3 + 2]! <= region.z[1]) { cleaned[i] = 0; count++; }
  removed += count; removalLog.push({ region: region.id, removed: count });
}
const after = await runChain(cleaned);

// ---- 6. 证据图（与本文档的 pr-evidence 图同源）：2 cm 俯视对照 + 区域放大 + 立面投影 ----
// 用 pngjs 直接写 PNG，避免额外图像库；图幅常量固定，便于前后对照。
const FIGURE = { cell: .02, scale: 3, X0: -5.15, X1: 46.5, Y0: -12.35, Y1: 8.65, zoomCell: .02, zoomScale: 3, sectionZ: [-6, 6] as [number, number] };
function topView(cloudRef: PointCloudData, keep: (i: number) => boolean, x0 = FIGURE.X0, x1 = FIGURE.X1, y0 = FIGURE.Y0, y1 = FIGURE.Y1, scale = FIGURE.scale) {
  const w = Math.round((x1 - x0) / FIGURE.cell), h = Math.round((y1 - y0) / FIGURE.cell), dens = new Float32Array(w * h), cols = new Float32Array(w * h * 3);
  for (let i = 0; i < cloudRef.visible.length; i++) {
    if (!keep(i)) continue;
    const x = cloudRef.positions[i * 3]!, y = cloudRef.positions[i * 3 + 1]!, z = cloudRef.positions[i * 3 + 2]!;
    if (x < x0 || x > x1 || y < y0 || y > y1 || z < elevationM || z > elevationM + heightM) continue;
    const k = Math.floor((y - y0) / FIGURE.cell) * w + Math.floor((x - x0) / FIGURE.cell);
    dens[k]!++; cols[k * 3] += cloudRef.colors[i * 3]!; cols[k * 3 + 1] += cloudRef.colors[i * 3 + 1]!; cols[k * 3 + 2] += cloudRef.colors[i * 3 + 2]!;
  }
  const img = new PNG({ width: w * scale, height: h * scale });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x, d = dens[k]!;
    const lum = d ? Math.min(1, Math.log1p(d) / Math.log1p(60)) * .85 + .15 : 0;
    const r = d ? Math.min(255, cols[k * 3]! / d * lum + 20) : 10, g = d ? Math.min(255, cols[k * 3 + 1]! / d * lum + 24) : 14, b = d ? Math.min(255, cols[k * 3 + 2]! / d * lum + 20) : 18;
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) { const idx = (((h - 1 - y) * scale + sy) * w * scale + x * scale + sx) * 4; img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b; img.data[idx + 3] = 255; }
  }
  return { img, w, h, scale, x0, y0, y1, cell: FIGURE.cell };
}
const put = (img: PNG, x: number, y: number, c: [number, number, number]) => { for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) { const ix = x + dx, iy = y + dy; if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) continue; const idx = (iy * img.width + ix) * 4; img.data[idx] = c[0]; img.data[idx + 1] = c[1]; img.data[idx + 2] = c[2]; img.data[idx + 3] = 255; } };
const line = (img: PNG, v: ReturnType<typeof topView>, a: P, b: P, c: [number, number, number]) => {
  const sx = (p: P) => Math.round((p[0] - v.x0) / v.cell) * v.scale, sy = (p: P) => Math.round((v.y1 - p[1]) / v.cell) * v.scale;
  const x0 = sx(a), y0 = sy(a), x1 = sx(b), y1 = sy(b), steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= steps; i++) put(img, Math.round(x0 + (x1 - x0) * i / steps), Math.round(y0 + (y1 - y0) * i / steps), c);
};
const rect = (img: PNG, v: ReturnType<typeof topView>, x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
  line(img, v, [x0, y0], [x1, y0], c); line(img, v, [x1, y0], [x1, y1], c); line(img, v, [x1, y1], [x0, y1], c); line(img, v, [x0, y1], [x0, y0], c);
};
const crop = (v: ReturnType<typeof topView>, box: [number, number, number, number]) => {
  const [bx0, by0, bx1, by1] = box, X0 = Math.floor((bx0 - v.x0) / v.cell) * v.scale, X1 = Math.ceil((bx1 - v.x0) / v.cell) * v.scale, Y0 = Math.floor((v.y1 - by1) / v.cell) * v.scale, Y1 = Math.ceil((v.y1 - by0) / v.cell) * v.scale;
  const w = Math.max(1, Math.min(v.img.width, X1) - Math.max(0, X0)), h = Math.max(1, Math.min(v.img.height, Y1) - Math.max(0, Y0)), out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = ((Math.max(0, Y0) + y) * v.img.width + Math.max(0, X0) + x) * 4, d = (y * w + x) * 4; for (let c = 0; c < 4; c++) out.data[d + c] = v.img.data[s + c]!; }
  return out;
};
const sideBySide = (left: PNG, right: PNG) => {
  const gap = 20, img = new PNG({ width: left.width + gap + right.width, height: Math.max(left.height, right.height) });
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  for (const [src, offset] of [[left, 0], [right, left.width + gap]] as Array<[PNG, number]>) for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) { const s = (y * src.width + x) * 4, d = (y * img.width + offset + x) * 4; for (let c = 0; c < 4; c++) img.data[d + c] = src.data[s + c]!; }
  return img;
};
const eastern = regions.reduce((m, r) => Math.max(m, r.x[1]), -Infinity), figureBox: [number, number, number, number] = [Math.min(...regions.map(r => r.x[0])), Math.min(...regions.map(r => r.y[0])), eastern, Math.max(...regions.map(r => r.y[1]))];
const viewBefore = topView(cloud, i => !!cloud.visible[i]), remaining = topView(cloud, i => !!cleaned[i]);
for (const [v, segs] of [[viewBefore, baseline.segments], [remaining, after.segments]] as Array<[ReturnType<typeof topView>, typeof baseline.segments]>) {
  rect(v.img, v, buildingBox.min[0], buildingBox.min[1], buildingBox.max[0], buildingBox.max[1], [90, 200, 140]);
  rect(v.img, v, figureBox[0], figureBox[1], figureBox[2], figureBox[3], [255, 190, 60]);
  for (const s of segs) line(v.img, v, s.a, s.b, [240, 250, 245]);
}
await mkdir(`${out}/figures`, { recursive: true });
await writeFile(`${out}/figures/before.png`, PNG.sync.write(viewBefore.img));
await writeFile(`${out}/figures/after.png`, PNG.sync.write(remaining.img));
await writeFile(`${out}/figures/before-after.png`, PNG.sync.write(sideBySide(viewBefore.img, remaining.img)));
await writeFile(`${out}/figures/region-before.png`, PNG.sync.write(crop(viewBefore, figureBox)));
await writeFile(`${out}/figures/region-after.png`, PNG.sync.write(crop(remaining, figureBox)));
// 图例：左 = 清理前，右 = 清理后；同一范围、同一配色、同一墙候选绘制方式。




// ---- 7. 墙段逐段对照 ----
// 逐段对照的第一层：给出每段的墙轴方向与中轴平行距离；判定“同一墙段”见下方 sameWall。
const axisDistance = (s: WallSegment, other: WallSegment) => {
  const length = distance(s.a, s.b), oLen = distance(other.a, other.b);
  const angle = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 180 / Math.PI, oAngle = Math.atan2(other.b[1] - other.a[1], other.b[0] - other.a[0]) * 180 / Math.PI;
  const raw = Math.abs(angle - oAngle) % 180, delta = Math.min(raw, 180 - raw);
  const dx = (other.b[0] - other.a[0]) / oLen, dy = (other.b[1] - other.a[1]) / oLen;
  const ax = (s.a[0] - other.a[0]) * dy - (s.a[1] - other.a[1]) * dx, bx = (s.b[0] - other.a[0]) * dy - (s.b[1] - other.a[1]) * dx;
  return { delta, perpendicular: Math.abs(ax + bx) / 2, lengthDelta: Math.abs(length - oLen) / 2 };
};
// 同一墙段判定按“覆盖 + 平行距离 + 沿轴首尾”三项，不要求互为唯一最近：
// 清理前后拟合会把同一面墙切成不同粒度的碎片，互为最近反而会把碎片顶给相邻墙轴。
// 覆盖：两段沿轴投影重叠长度 ÷ 较长段长度 ≥0.6；平行距离 ≤5 cm；方向差 ≤3°；首尾间隙 ≤0.3 m（墙缝）。
const overlap = (s: WallSegment, other: WallSegment) => {
  const m = axisDistance(s, other);
  const oLen = distance(other.a, other.b), ox = (other.b[0] - other.a[0]) / oLen, oy = (other.b[1] - other.a[1]) / oLen;
  const project = (p: P) => (p[0] - other.a[0]) * ox + (p[1] - other.a[1]) * oy;
  const t0 = project(s.a), t1 = project(s.b), sOwn = Math.abs(t1 - t0), o0 = 0, o1 = oLen;
  const low = Math.max(Math.min(t0, t1), o0), high = Math.min(Math.max(t0, t1), o1);
  const shared = Math.max(0, high - low), longest = Math.max(sOwn, oLen) || 1;
  const gap = Math.max(0, Math.min(t0, t1) - o1, o0 - Math.max(t0, t1));
  return { ...m, shared: shared / longest, rawShared: shared, gap, own: sOwn / longest, otherLength: oLen };
};
// 单侧诊断：对每段给出同一墙轴（方向差 ≤3°、平行距离 ≤5 cm）上的最优候选，用于区分“碎片重组”与“真实丢失”。
const bestAxisNeighbour = (s: WallSegment, pool: WallSegment[], lengthM: number) => {
  let best: { index: number; perpendicular: number; rawShared: number; gap: number; coverBase: number } | undefined;
  pool.forEach((other, index) => { const o = overlap(s, other); if (o.delta > 3 || o.perpendicular > .05) return; const candidate = { index, perpendicular: o.perpendicular, rawShared: o.rawShared, gap: o.gap, coverBase: Math.max(o.own * o.otherLength, Math.max(0, o.otherLength - o.gap)) };
    if (!best || candidate.rawShared > best.rawShared) best = candidate; });
  return best;
};
const sameWall = (s: WallSegment, other: WallSegment) => {
  const o = overlap(s, other);
  return o.delta <= 3 && o.perpendicular <= .05 && o.shared >= .6 && o.gap <= .3 ? o : undefined;
};
const matches = (s: WallSegment, pool: WallSegment[]) => {
  const hits: Array<{ index: number; o: NonNullable<ReturnType<typeof sameWall>> }> = [];
  pool.forEach((other, index) => { const o = sameWall(s, other); if (o) hits.push({ index, o }); });
  return hits.sort((a, b) => a.o.perpendicular - b.o.perpendicular);
};
const afterAxis = after.segments.map(s => matches(s, baseline.segments));
const beforeAxis = baseline.segments.map(s => matches(s, after.segments));
const mutual: Array<{ afterIndex: number; beforeIndex: number; perpendicularM: number; angleDeg: number; shared: number }> = [];
afterAxis.forEach((hits, afterIndex) => { for (const h of hits) if (beforeAxis[h.index]!.some(x => x.index === afterIndex)) { mutual.push({ afterIndex, beforeIndex: h.index, perpendicularM: round(h.o.perpendicular), angleDeg: round(h.o.delta, 2), shared: round(h.o.shared, 3) }); break; } });

const lost = baseline.segments.map((segment, index) => ({ segment, index, hit: beforeAxis[index] })).filter(({ index }) => !mutual.some(m => m.beforeIndex === index))
  .map(({ segment, index, hit }) => ({ index, a: segment.a.map(round) as P, b: segment.b.map(round) as P, lengthM: round(distance(segment.a, segment.b)), support: segment.support, nearestAfter: hit.length ? { index: hit[0]!.index, perpendicularM: round(hit[0]!.o.perpendicular), shared: round(hit[0]!.o.shared, 3), gapM: round(hit[0]!.o.gap, 3) } : null }));
const added = after.segments.map((segment, index) => ({ segment, index, hit: afterAxis[index] })).filter(({ index }) => !mutual.some(m => m.afterIndex === index))
  .map(({ segment, index, hit }) => ({ index, a: segment.a.map(round) as P, b: segment.b.map(round) as P, lengthM: round(distance(segment.a, segment.b)), support: segment.support, nearestBefore: hit.length ? { index: hit[0]!.index, perpendicularM: round(hit[0]!.o.perpendicular), shared: round(hit[0]!.o.shared, 3), gapM: round(hit[0]!.o.gap, 3) } : null }));
// 东端墙段端点支撑：区域 A 之后（x > 33）墙候选是否仍有真实点支撑。
const eastSupport = (working: PointCloudData, segments: WallSegment[]) => segments.filter(s => Math.max(s.a[0], s.b[0]) > 33).map(s => {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], length = Math.hypot(dx, dy), half = thicknessM / 2;
  let points = 0;
  for (let i = 0; i < working.visible.length; i++) {
    if (!working.visible[i]) continue;
    const x = working.positions[i * 3]!, y = working.positions[i * 3 + 1]!;
    if (x <= 33) continue;
    const u = ((x - s.a[0]) * dx + (y - s.a[1]) * dy) / length, d = Math.abs((x - s.a[0]) * dy - (y - s.a[1]) * dx) / length;
    if (u >= 0 && u <= length && d <= half) points++;
  }
  return { a: s.a.map(round) as P, b: s.b.map(round) as P, lengthM: round(distance(s.a, s.b)), support: s.support, pointsEastOfRegionM: points };
});
// 伪影段核对（#8 诊断的缺陷段）：给出清理前后中心落在指定方框内的候选，用于判断清理是否影响该段。
const artifacts: Array<{ id: string; box: [number, number, number, number]; before: Array<{ a: P; b: P; lengthM: number }>; after: Array<{ a: P; b: P; lengthM: number }> }> = [];
const artifactBoxes = JSON.parse(process.env.SURVEY_ARTIFACT_BOXES ?? "[]") as Array<{ id: string; box: [number, number, number, number] }>;
for (const { id, box: b } of artifactBoxes) {
  const inside = (segs: WallSegment[]) => segs.filter(s => (s.a[0] + s.b[0]) / 2 >= b[0] && (s.a[0] + s.b[0]) / 2 <= b[2] && (s.a[1] + s.b[1]) / 2 >= b[1] && (s.a[1] + s.b[1]) / 2 <= b[3]).map(s => ({ a: s.a.map(round) as P, b: s.b.map(round) as P, lengthM: round(distance(s.a, s.b)) }));
  artifacts.push({ id, box: b, before: inside(baseline.segments), after: inside(after.segments) });
}
// ---- 8. 墙厚带内点数（伪影判定口径与 PR #8 诊断一致：墙厚带内点数、0.45 m 带宽内点数）----
const bandMetrics = (working: PointCloudData, segments: WallSegment[]) => segments.map(s => {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], length = Math.hypot(dx, dy), half = thicknessM / 2;
  let inside = 0, near = 0;
  for (let i = 0; i < working.visible.length; i++) {
    if (!working.visible[i]) continue;
    const x = working.positions[i * 3]! - s.a[0], y = working.positions[i * 3 + 1]! - s.a[1], u = (x * dx + y * dy) / length, d = Math.abs(x * dy - y * dx) / length;
    if (u < 0 || u > length) continue;
    if (d <= half) inside++;
    if (d <= .45) near++;
  }
  return { pointsInThickness: inside, pointsNearBand: near };
});
const beforeMetrics = bandMetrics(baseline.working, baseline.segments), afterMetrics = bandMetrics(after.working, after.segments);

// ---- 9. 源件完整性复核 ----
const handle2 = await open(file, "r"), hash2 = createHash("sha256");
for (let offset = 0; offset < stat.size; offset += 64 * 1024 ** 2) { const size = Math.min(64 * 1024 ** 2, stat.size - offset), buffer = Buffer.alloc(size); await handle2.read(buffer, 0, size, offset); hash2.update(buffer); }
const sha256After = hash2.digest("hex"); await handle2.close();

export {};
const lostDetail = lost.map(l => ({ ...l, ...beforeMetrics[l.index], ...(l.nearestAfter ? {} : { axisNeighbour: bestAxisNeighbour({ a: baseline.segments[l.index]!.a, b: baseline.segments[l.index]!.b, support: 0, rmsM: 0 }, after.segments, l.lengthM) }) }));
const addedDetail = added.map(a => ({ ...a, ...(a.nearestBefore ? {} : { axisNeighbour: bestAxisNeighbour({ a: after.segments[a.index]!.a, b: after.segments[a.index]!.b, support: 0, rmsM: 0 }, baseline.segments, a.lengthM) }) }));
const report = {
  source: { name, bytes: stat.size, sha256Before, sha256After, sha256Unchanged: sha256Before === sha256After, pointCount: cloud.visible.length },
  buildingEnvelope: { method: "30cm 栅格 → 1m 窗口 ≥500 点/m²，自种子点取 8 邻接连片包络", minX: round(buildingBox.min[0], 2), maxX: round(buildingBox.max[0], 2), minY: round(buildingBox.min[1], 2), maxY: round(buildingBox.max[1], 2), areaM2: round(w * h, 1), windows: buildingBox.bands.length },
  parameters: { elevationM, heightM, thicknessM },
  timings: { decodeSeconds: round(decodeSeconds), envelopeSeconds: round(envelopeSeconds), baselineFitSeconds: round(baseline.fitSeconds), afterFitSeconds: round(after.fitSeconds) },
  regions: regionStats,
  removalLog,
  baseline: { pointsInBuildingEnvelopeAndBand: baseline.band, evidenceCells: baseline.evidenceCells, fittedSegments: baseline.fittedSegments, wallCandidates: baseline.segments.length, rooms: baseline.rooms, unclosedIssues: baseline.unclosedIssues, closure: baseline.closure },
  after: { pointsInBuildingEnvelopeAndBand: after.band, evidenceCells: after.evidenceCells, fittedSegments: after.fittedSegments, wallCandidates: after.segments.length, rooms: after.rooms, unclosedIssues: after.unclosedIssues, closure: after.closure },
  removedPoints: removed,
  regionPointsInRegister: regionStats.map((r, i) => ({ id: r.id, points: r.points, inHeightBandPoints: r.inHeightBandPoints, removedByRule: removalLog[i]!.removed })),
  retainedAfterCleanup: cleaned.reduce((sum, v) => sum + v, 0),
  matched: mutual,
  added: addedDetail,
  lostSegments: lostDetail,
  eastSupport: { before: eastSupport(baseline.working, baseline.segments), after: eastSupport(after.working, after.segments) },
  artifacts,
  metrics: { before: beforeMetrics, after: afterMetrics, thicknessPairs: mutual.map(m => ({ beforeIndex: m.beforeIndex, afterIndex: m.afterIndex, pointsInThicknessBefore: beforeMetrics[m.beforeIndex]!.pointsInThickness, pointsInThicknessAfter: afterMetrics[m.afterIndex]!.pointsInThickness })) },
};
await writeFile(`${out}/cleanup-case-study.json`, JSON.stringify(report, null, 2));
await writeFile(`${out}/segments-before.json`, JSON.stringify(baseline.segments));
await writeFile(`${out}/segments-after.json`, JSON.stringify(after.segments));
await writeFile(`${out}/figures/manifest.json`, JSON.stringify({ figures: ["before.png", "after.png", "before-after.png", "region-before.png", "region-after.png"], regionFigure: figureBox, buildingEnvelope: report.buildingEnvelope, legend: "left = before cleanup, right = after cleanup; green = building envelope, orange = cleaned region, white = wall candidates" }, null, 2));
console.log(JSON.stringify({ source: report.source, buildingEnvelope: report.buildingEnvelope, regions: report.regions, removalLog, baseline: report.baseline, after: report.after, lostSegments: report.lostSegments.length, timings: report.timings }, null, 2));
