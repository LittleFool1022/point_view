/**
 * 墙线拟合复现：把 fitWallLines 的阶段（证据格 → RANSAC 内点选取 → 直线范围 → 分段 → 端点拼接）
 * 原样展开并逐步记录计数，用于在**未修改**的算法上定位候选为何无法闭合。
 * 随机种子与 tolerance/参数逐项照抄 fitWallLines，任何时候都应与 fitWallLines 的 segments 一致（脚本自检）。
 */
import type { PointCloudData } from "../../src/domain/types";
import { buildWallNetwork } from "../src/pipeline/wallNetwork";
type P = [number, number];
export interface WallLineTrace {
  retained: number;
  cell: number;
  cells: number;
  cellsOverCap: boolean;
  countsGe8: number;
  spanGe08: number;
  layersGe4: number;
  evidenceCells: number;
  rounds: number;
  linesSelected: number;
  seedPointsBelowBestMin: number;
  inlierCandidates: number;
  failedMinSupport: { count: number; cases: number[] }[];
  failedMinLength: number;
  failedResidual: { cases: { count: number; lengthM: number; rmsMm: number }[]; maxRmsMm: number };
  inliersDiscardedPerLine: number;
  segments: { a: P; b: P; support: number; rmsM: number }[];
}

export function traceWallLines(cloud: PointCloudData) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, retained = 0;
  for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i]) { const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); minZ = Math.min(minZ, cloud.positions[i * 3 + 2]!); maxZ = Math.max(maxZ, cloud.positions[i * 3 + 2]!); retained++; }
  const cell = .06, nx = Math.ceil((maxX - minX) / cell) + 1, ny = Math.ceil((maxY - minY) / cell) + 1, n = nx * ny;
  const counts = new Uint32Array(n), layers = new Uint32Array(n), xsum = new Float64Array(n), ysum = new Float64Array(n), low = new Float32Array(n).fill(Infinity), high = new Float32Array(n).fill(-Infinity);
  for (let i = 0; i < cloud.visible.length; i++) {
    if (!cloud.visible[i]) continue;
    const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!, z = cloud.positions[i * 3 + 2]!;
    const key = Math.floor((y - minY) / cell) * nx + Math.floor((x - minX) / cell);
    counts[key]++; xsum[key] += x; ysum[key] += y; low[key] = Math.min(low[key]!, z); high[key] = Math.max(high[key]!, z);
    layers[key] |= 1 << ((Math.floor(z / .25) % 32 + 32) % 32);
  }
  let points: P[] = [];
  let countsGe8 = 0, spanGe08 = 0, layersGe4 = 0;
  for (let i = 0; i < n; i++) {
    const c = counts[i]! >= 8; if (c) countsGe8++;
    const s = high[i]! - low[i]! >= .8; if (c && s) spanGe08++;
    if (!c || !s) continue;
    let bits = layers[i]!, occupied = 0; while (bits) { bits &= bits - 1; occupied++; }
    if (occupied >= 4) { layersGe4++; points.push([xsum[i]! / counts[i]!, ysum[i]! / counts[i]!]); }
  }
  const evidenceCells = points.length;
  const trace: WallLineTrace = { retained, cell, cells: n, cellsOverCap: n > 8_000_000, countsGe8, spanGe08, layersGe4, evidenceCells, rounds: 0, linesSelected: 0, seedPointsBelowBestMin: 0, inlierCandidates: 0, failedMinSupport: [], failedMinLength: 0, failedResidual: { cases: [], maxRmsMm: 0 }, inliersDiscardedPerLine: 0, segments: [] };
  const segments: { a: P; b: P; support: number; rmsM: number }[] = []; let seed = 1234567;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const tolerance = .045;
  const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (let round = 0; round < 60 && points.length >= 16; round++) {
    trace.rounds++;
    let best: { a: P; ux: number; uy: number; score: number } | undefined;
    let bestMin = 15;
    for (let t = 0; t < 160; t++) {
      const a = points[Math.floor(random() * points.length)]!, b = points[Math.floor(random() * points.length)]!, length = distance(a, b);
      if (length < .8) continue;
      const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length; let score = 0;
      for (const p of points) if (Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) <= tolerance) score++;
      if (score > (best?.score ?? 15)) best = { a, ux, uy, score };
    }
    if (!best) { trace.seedPointsBelowBestMin++; break; }
    trace.linesSelected++;
    const candidates = points.filter(p => Math.abs((p[0] - best!.a[0]) * best!.uy - (p[1] - best!.a[1]) * best!.ux) <= tolerance);
    trace.inlierCandidates += candidates.length;
    trace.inliersDiscardedPerLine += points.length - candidates.length;
    const cx = candidates.reduce((s, p) => s + p[0], 0) / candidates.length, cy = candidates.reduce((s, p) => s + p[1], 0) / candidates.length;
    let xx = 0, yy = 0, xy = 0; for (const p of candidates) { xx += (p[0] - cx) ** 2; yy += (p[1] - cy) ** 2; xy += (p[0] - cx) * (p[1] - cy); }
    const angle = .5 * Math.atan2(2 * xy, xx - yy), ux = Math.cos(angle), uy = Math.sin(angle);
    const projected = candidates.map(p => ({ p, t: (p[0] - cx) * ux + (p[1] - cy) * uy })).sort((a, b) => a.t - b.t);
    let start = 0;
    for (let j = 1; j <= projected.length; j++) if (j === projected.length || projected[j]!.t - projected[j - 1]!.t > .20) {
      const first = projected[start]!.t, last = projected[j - 1]!.t;
      if (j - start >= 10 && last - first >= .8) {
        let residual = 0; for (let k = start; k < j; k++) { const p = projected[k]!.p; residual += ((p[0] - cx) * uy - (p[1] - cy) * ux) ** 2; }
        segments.push({ a: [cx + first * ux, cy + first * uy], b: [cx + last * ux, cy + last * uy], support: j - start, rmsM: Math.sqrt(residual / (j - start)) });
      } else if (j - start < 10) {
        const key = trace.failedMinSupport.find(f => f.count === j - start);
        if (key) key.cases.push(Math.round((last - first) * 100) / 100);
        else trace.failedMinSupport.push({ count: j - start, cases: [Math.round((last - first) * 100) / 100] });
      } else trace.failedMinLength++;
      start = j;
    }
    points = points.filter(p => Math.abs((p[0] - best!.a[0]) * best!.uy - (p[1] - best!.a[1]) * best!.ux) > tolerance);
  }
  trace.segments = segments;
  // 与 fitWallLines 一致：拟合候选直接交给墙网级连接（沿轴延长、T 形插节点、门口不连）。
  const network = buildWallNetwork(segments);
  return { trace, rawSegments: segments, network, segments: network.segments.map(({ a, b, support, rmsM }) => ({ a, b, support, rmsM })), evidenceCells, retained, cell, bounds: { min: [minX, minY, minZ] as [number, number, number], max: [maxX, maxY, maxZ] as [number, number, number] } };
}
