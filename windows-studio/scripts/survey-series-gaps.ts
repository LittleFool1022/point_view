/**
 * 同轴串联候选对全表（Issue #29，修复 h 的前置调查）。
 *
 * 「同轴串联」= 两段墙方向差 ≤ SERIES_DIRECTION_DEG、两轴横向相距 ≤ SERIES_AXIS_GAP_M、沿轴向的投影**不重叠**
 * （首尾之间有正向空隙）。它与「平行重复」（投影重叠、同一道墙的残影）是两种形态：前者是同一道墙上缺了一段，
 * 后者是同一道墙被拟合了两遍。本脚本只做只读统计与判定，不改任何判据、不移动任何端点。
 *
 * 输入用与 `diagnose-room-closure.ts` 相同的链路：高度剖切 → `fitWallLines` → 分别取
 * 「去重后（wallDedupe 输出，即墙网连接的输入）」与「连接后（buildWallNetwork 输出）」两组墙段，
 * 逐对给出段号/来源、轴向断口、横向错位、断口带内的点云证据、是否有第三方墙段穿过断口轴，以及逐对判定。
 *
 * 用法：SURVEY_REAL_FIXTURE=/path/to/file.pcd npm run survey:series-gaps
 * 只读源件；输出 JSON 至 artifacts/series-gaps/<样本名>/。没有 RD-01 独立真值，判定是功能判定，不是精度验收。
 */
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { readCloud } from "../src/pipeline/binaryPcd";
import { fitWallLines } from "../src/pipeline/wallLines";
import { MAX_EXTENSION_M, OPENING_M, TIE_TOLERANCE_M, buildWallNetwork } from "../src/pipeline/wallNetwork";
import type { PointCloudData } from "../../src/domain/types";

type P = [number, number];
/** 串联候选对的形态判据（Issue #29 给定）：方向差、轴间距上限；投影是否重叠由判据本身区分形态。 */
const SERIES_DIRECTION_DEG = 1.5;
const SERIES_AXIS_GAP_M = .15;
/** 断口带内的点云证据：沿轴、以两端点连线的中点为圆心、半径 EVIDENCE_RADIUS_M 的圆柱带。 */
const EVIDENCE_RADIUS_M = .25;
/**
 * 横向错位口径（Issue #29 续行）：两条**有限墙段**之间的最短距离，与段朝向、哪一端叫 a/b 都无关。
 *
 * 为什么不用更省事的写法：同一道墙常被拟合成两段方向相反（或同向错身）的片段，这时"某个端点投影到
 * 对方轴上的偏差"会被 1/轴向距离放大，或因为端点恰好落在对方轴线上而塌成 0；"两块端点的偏差相减"
 * 也会随 a/b 次序翻转。两段之间的距离是这套几何里唯一不依赖任何端点选取方式的量。
 *
 * 本表同时给出旧口径（两个端点各自到对方轴的最大垂距，pairs[].axisGapM）作对照。
 * 真实样本上两种口径的差别：#16↔#17 旧 0.019 / 新 0.232（这是缺口长度，旧口径把两端点各自"贴轴"
 * 当成了贴合），#37↔#17 旧 0.146 / 新 0.322。
 */
function seriesGapM(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const A0: P = [a[0]!, a[1]!], A1: P = [a[2]!, a[3]!], B0: P = [b[0]!, b[1]!], B1: P = [b[2]!, b[3]!];
  const dist = (p: P, q: P) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  /** 点到线段距离（端点与垂足两种情形）。 */
  const pointToSegment = (p: P, s0: P, s1: P) => {
    const vx = s1[0] - s0[0], vy = s1[1] - s0[1], l2 = vx * vx + vy * vy;
    if (l2 <= 1e-18) return dist(p, s0);
    const t = Math.max(0, Math.min(1, ((p[0] - s0[0]) * vx + (p[1] - s0[1]) * vy) / l2));
    return dist(p, [s0[0] + t * vx, s0[1] + t * vy]);
  };
  /** 两线段是否相交（跨立试验）。 */
  const crosses = (p1: P, p2: P, q1: P, q2: P) => {
    const orient = (o: P, p: P, q: P) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const d1 = orient(q1, q2, p1), d2 = orient(q1, q2, p2), d3 = orient(p1, p2, q1), d4 = orient(p1, p2, q2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  if (crosses(A0, A1, B0, B1)) return 0;
  // 两线段不相交时，最短距离必在某个端点到另一线段的垂足处。
  return Math.min(
    pointToSegment(A0, B0, B1), pointToSegment(A1, B0, B1),
    pointToSegment(B0, A0, A1), pointToSegment(B1, A0, A1),
  );
}

const file = process.env.SURVEY_REAL_FIXTURE;
if (!file) throw Error("Set SURVEY_REAL_FIXTURE to the original binary PCD.");
const elevationM = Number(process.env.ELEVATION_M ?? 0), heightM = Number(process.env.HEIGHT_M ?? 3);
const name = basename(file), out = `artifacts/series-gaps/${name.replace(/\.pcd$/i, "")}`;
await mkdir(out, { recursive: true });
const round = (v: number) => Number(v.toFixed(3)), distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const handle = await open(file, "r"), stat = await handle.stat(), hash = createHash("sha256");
for (let offset = 0; offset < stat.size; offset += 64 * 1024 ** 2) { const size = Math.min(64 * 1024 ** 2, stat.size - offset), buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, offset); hash.update(buffer); }
const sha256 = hash.digest("hex");
const decoded = await readCloud({ name, native: { token: "series", name, size: stat.size, sha256 } }, "m", async (offset, size) => { const b = Buffer.alloc(size); await handle.read(b, 0, size, offset); return b.buffer; }, () => {});
await handle.close();
const cloud = decoded.cloud, working: PointCloudData = { ...cloud, visible: cloud.visible.slice() };
for (let i = 0; i < working.visible.length; i++) { const z = working.positions[i * 3 + 2]!; if (z < elevationM || z > elevationM + heightM) working.visible[i] = 0; }
const fitted = await fitWallLines(working, () => {});

interface Seg { a: P; b: P; support: number; rmsM: number; sources?: number[] }
/** 同一墙段的共线子段（贴合插点多切出来的那一半）不构成串联对：它们由同一面墙继续接。 */
const pieceIdentity = (s: Seg, index: number) => (s.sources ? s.sources.join(",") : `#${index}`);

/** 断口带内点云证据：以断口中心为圆心、半径 EVIDENCE_RADIUS_M 的圆柱带，按墙厚 0.2 m 与 0.45 m 软带分别计数。 */
const BUCKET_M = .5;
const buckets = new Map<string, number[]>();
for (let i = 0; i < working.visible.length; i++) {
  if (!working.visible[i]) continue;
  const key = `${Math.floor(working.positions[i * 3]! / BUCKET_M)}:${Math.floor(working.positions[i * 3 + 1]! / BUCKET_M)}`;
  const bucket = buckets.get(key);
  if (bucket) bucket.push(i); else buckets.set(key, [i]);
}
/** 圆内点（只读已建的分桶索引，避免逐对全量扫点）。 */
function pointsNear(center: P, radius: number): number[] {
  const found: number[] = [];
  const reach = Math.ceil(radius / BUCKET_M);
  const cx = Math.floor(center[0] / BUCKET_M), cy = Math.floor(center[1] / BUCKET_M);
  for (let bx = cx - reach; bx <= cx + reach; bx++) for (let by = cy - reach; by <= cy + reach; by++) for (const i of buckets.get(`${bx}:${by}`) ?? []) {
    if (Math.hypot(working.positions[i * 3]! - center[0], working.positions[i * 3 + 1]! - center[1]) <= radius) found.push(i);
  }
  return found;
}
function gapEvidence(p: P, q: P) {
  const mid: P = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy) || 1e-9, cell = .06;
  let pointsInThickness = 0, pointsInSoftBand = 0;
  const cells = new Set<string>();
  for (const i of pointsNear(mid, EVIDENCE_RADIUS_M)) {
    const x = working.positions[i * 3]!, y = working.positions[i * 3 + 1]!;
    const vx = x - p[0], vy = y - p[1], along = (vx * dx + vy * dy) / length, lateral = Math.abs(vx * dy - vy * dx) / length;
    if (along < -EVIDENCE_RADIUS_M || along > length + EVIDENCE_RADIUS_M) continue;
    if (lateral <= .1) pointsInThickness++;
    if (lateral <= .45) pointsInSoftBand++;
    cells.add(`${Math.floor(x / cell)}:${Math.floor(y / cell)}`);
  }
  return { radiusM: EVIDENCE_RADIUS_M, pointsInThickness, pointsInSoftBand, evidenceCells: cells.size };
}

interface Pair {
  left: number; right: number;
  leftSources: number[]; rightSources: number[];
  directionDeg: number; axisGapM: number; projectionGapM: number; lateralEndM: number;
  /** 两段之间的最短距离（横向错位口径）；容差判据用这一列。 */
  seriesGapM: number;
  gapM: number; gapBand: "<=0.5" | "0.5-1.0" | ">1.0";
  ends: { left: P; right: P };
  evidence: ReturnType<typeof gapEvidence>;
  crossedBy: number[];
  verdict: string;
  note: string;
}

/** 逐对枚举同轴串联候选。 */
function survey(list: ReadonlyArray<Seg>): { pairs: Pair[]; groups: Array<{ members: number[]; gaps: number[] }> } {
  const axes = list.map(s => { const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l = Math.hypot(dx, dy); return { ux: dx / l, uy: dy / l, length: l }; });
  const angle = (i: number, j: number) => { const u = axes[i]!, v = axes[j]!, d = Math.abs(Math.atan2(u.ux * v.uy - u.uy * v.ux, u.ux * v.ux + u.uy * v.uy)) * 180 / Math.PI; return d > 90 ? 180 - d : d; };
  const spanOn = (s: Seg, o: P, ux: number, uy: number) => { const t = [s.a, s.b].map(p => (p[0] - o[0]) * ux + (p[1] - o[1]) * uy); return [Math.min(...t), Math.max(...t)] as [number, number]; };
  const sideOf = (p: P, o: P, ux: number, uy: number) => Math.abs((p[0] - o[0]) * uy - (p[1] - o[1]) * ux);
  const pairs: Pair[] = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    if (pieceIdentity(list[i]!, i) === pieceIdentity(list[j]!, j)) continue;
    const direction = angle(i, j);
    if (direction > SERIES_DIRECTION_DEG) continue;
    const u = axes[i]!, o = list[i]!.a;
    const lateral = Math.max(sideOf(list[j]!.a, o, u.ux, u.uy), sideOf(list[j]!.b, o, u.ux, u.uy));
    if (lateral > SERIES_AXIS_GAP_M) continue;
    const [lo1, hi1] = spanOn(list[i]!, o, u.ux, u.uy), [lo2, hi2] = spanOn(list[j]!, o, u.ux, u.uy);
    const overlap = Math.min(hi1, hi2) - Math.max(lo1, lo2);
    if (overlap > 0) continue; // 投影重叠 = 平行重复形态，不在本表（PR #25 的口径不动）
    const projectionGap = -overlap;
    const near = (k: number, towardLarger: boolean) => {
      const tk = [list[k]!.a, list[k]!.b].map(p => (p[0] - o[0]) * u.ux + (p[1] - o[1]) * u.uy);
      const pick = towardLarger ? (tk[0] > tk[1] ? 0 : 1) : (tk[0] < tk[1] ? 0 : 1);
      return pick === 0 ? list[k]!.a : list[k]!.b;
    };
    // 投影区间在前的一方的 +∞ 端，与在后的一方的 −∞ 端，是缺口两侧的端点。
    const front = lo1 <= lo2 ? i : j, back = front === i ? j : i;
    const p = near(front, true), q = near(back, false);
    const evidence = gapEvidence(p, q);
    const gap = distance(p, q);
    // 两套横向错位口径并列：axisGapM 是"两个端点各自到对方轴的最大垂距"（旧的粗口径），
    // seriesGapM 是按同向/相向分情形的口径（容差判据用它）。
    // 两轴错位口径：两条有限墙段之间的最短距离（seriesGapM），与段朝向、a/b 次序都无关。
    const coords = (k: number) => [list[k]!.a[0], list[k]!.a[1], list[k]!.b[0], list[k]!.b[1]] as ReadonlyArray<number>;
    const bySeries = seriesGapM(coords(i), coords(j));
    const crossedBy: number[] = [];
    for (let k = 0; k < list.length; k++) {
      if (k === i || k === j) continue;
      const other = list[k]!, { ux, uy } = axes[k]!;
      // 第三方墙段与该轴的夹角明显（>10°）且中点落在断口两侧端点之间（轴向 ±0.05 m）、横向 ≤0.1 m 时算"穿过断口"。
      if (Math.abs(Math.atan2(ux * u.uy - uy * u.ux, ux * u.ux + uy * u.uy)) * 180 / Math.PI < 10) continue;
      const check = (pt: P) => { const vx = pt[0] - p[0], vy = pt[1] - p[1]; const along = (vx * u.ux + vy * u.uy), lateralToAxis = Math.abs(vx * u.uy - vy * u.ux); return along >= -1e-6 && along <= gap + 1e-6 && lateralToAxis <= .1; };
      const segmentsOfOther = [other.a, other.b] as P[];
      if (segmentsOfOther.some(check)) crossedBy.push(k);
    }
    const band = gap <= MAX_EXTENSION_M + 1e-9 ? "<=0.5" : gap < OPENING_M ? "0.5-1.0" : ">1.0";
    let verdict: string, note: string;
    if (gap >= OPENING_M) { verdict = "疑似洞口"; note = `轴向断口 ${gap.toFixed(3)} m ≥ ${OPENING_M} m：按洞口，不桥接。`; }
    else if (crossedBy.length) { verdict = "有第三方墙穿越"; note = `断口轴被 #${crossedBy.join("/#")} 穿过：不得跨越。`; }
    else if (evidence.pointsInThickness < 50) { verdict = "断口无证据"; note = `断口带内墙厚范围内仅 ${evidence.pointsInThickness} 点：不是"缺连接"而是缺墙。`; }
    else if (gap > MAX_EXTENSION_M) { verdict = "0.5–1.0 m 未闭合"; note = `轴向断口 ${gap.toFixed(3)} m 在 ${MAX_EXTENSION_M}–${OPENING_M} m：进未闭合清单，不桥接。`; }
    else if (bySeries > SERIES_AXIS_GAP_M) verdict = "横向超串联容差", note = `轴向断口 ${gap.toFixed(3)} m ≤ ${MAX_EXTENSION_M} m，但两段相距 ${bySeries.toFixed(3)} m > ${SERIES_AXIS_GAP_M} m：不桥接、进未闭合清单。`;
    else verdict = "可桥接", note = `轴向断口 ${gap.toFixed(3)} m ≤ ${MAX_EXTENSION_M} m，两段相距 ${bySeries.toFixed(3)} m ≤ ${SERIES_AXIS_GAP_M} m，断口带内 ${evidence.pointsInThickness} 点。`;
    pairs.push({
      left: front, right: back,
      leftSources: list[front]!.sources ?? [front], rightSources: list[back]!.sources ?? [back],
      directionDeg: round(direction), axisGapM: round(lateral), projectionGapM: round(projectionGap), lateralEndM: round(lateral),
      seriesGapM: round(bySeries),
      gapM: round(gap), gapBand: band, ends: { left: p.map(round) as P, right: q.map(round) as P },
      evidence, crossedBy, verdict, note,
    });
  }
  // 链：把候选对按共用的段连成一串，给出每串的段号顺序与各断口宽度（用于看"同一条墙带上有几处断口"）。
  const adjacency = new Map<number, number[]>();
  for (const pair of pairs) { adjacency.set(pair.left, [...(adjacency.get(pair.left) ?? []), pair.right]); adjacency.set(pair.right, [...(adjacency.get(pair.right) ?? []), pair.left]); }
  const seen = new Set<number>(), groups: Array<{ members: number[]; gaps: number[] }> = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const members: number[] = [], queue = [start];
    while (queue.length) { const k = queue.pop()!; if (seen.has(k)) continue; seen.add(k); members.push(k); for (const n of adjacency.get(k) ?? []) if (!seen.has(n)) queue.push(n); }
    groups.push({ members: members.sort((x, y) => x - y), gaps: pairs.filter(pair => members.includes(pair.left) && members.includes(pair.right)).map(pair => pair.gapM) });
  }
  return { pairs: pairs.sort((x, y) => x.gapM - y.gapM || x.left - y.left), groups: groups.filter(g => g.members.length > 1) };
}

// 去重后的墙候选：`fitWallLines` 不直接返回去重结果，用与诊断脚本相同的 `traceWallLines` 重放取出（自检见下）。
const { traceWallLines } = await import("./replay-wall-lines");
const replayed = traceWallLines(working);
if (replayed.deduped.segments.length !== fitted.dedupedSegments) throw Error("重放去重段数与 fitWallLines 不一致。");
if (replayed.segments.length !== fitted.segments.length) throw Error("重放连接段数与 fitWallLines 不一致。");
const dedupedSurvey = survey(replayed.deduped.segments);
const joinedSurvey = survey(fitted.segments);
const report = {
  source: { name, bytes: stat.size, sha256, elevationM, heightM },
  criteria: { directionDeg: SERIES_DIRECTION_DEG, axisGapM: SERIES_AXIS_GAP_M, evidenceRadiusM: EVIDENCE_RADIUS_M, maxExtensionM: MAX_EXTENSION_M, openingM: OPENING_M, tieToleranceM: TIE_TOLERANCE_M },
  counts: { fittedSegments: fitted.fittedSegments, dedupedSegments: fitted.dedupedSegments, joinedSegments: fitted.segments.length, dedupedPairs: dedupedSurvey.pairs.length, joinedPairs: joinedSurvey.pairs.length },
  // 每对判定计数（同一对只按最严重的一条判定归类，顺序见 verdict）。
  verdicts: {
    deduped: dedupedSurvey.pairs.reduce((acc: Record<string, number>, pair) => ({ ...acc, [pair.verdict]: (acc[pair.verdict] ?? 0) + 1 }), {}),
    joined: joinedSurvey.pairs.reduce((acc: Record<string, number>, pair) => ({ ...acc, [pair.verdict]: (acc[pair.verdict] ?? 0) + 1 }), {}),
  },
  // 横向错位分布（只统计投影不重叠的串联候选对）：桥接容差取值用。
  lateralBands: {
    deduped: [[0, .04], [.04, .08], [.08, .12], [.12, .15]].map(([lo, hi]) => ({ band: `${lo}-${hi}`, count: dedupedSurvey.pairs.filter(pair => pair.axisGapM >= lo! && pair.axisGapM < hi!).length })),
    joined: [[0, .04], [.04, .08], [.08, .12], [.12, .15]].map(([lo, hi]) => ({ band: `${lo}-${hi}`, count: joinedSurvey.pairs.filter(pair => pair.axisGapM >= lo! && pair.axisGapM < hi!).length })),
  },
  deduped: { pairs: dedupedSurvey.pairs, chains: dedupedSurvey.groups },
  joined: { pairs: joinedSurvey.pairs, chains: joinedSurvey.groups },
  // 墙网连接后的跨度（供报告引用）：连接结果由 fitWallLines 给出。
  network: { join: fitted.network.join, unclosedByReason: fitted.network.unclosed.reduce((acc: Record<string, number>, u) => ({ ...acc, [u.reason]: (acc[u.reason] ?? 0) + 1 }), {}) },
};
await writeFile(`${out}/series-gaps.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ source: report.source, counts: report.counts, verdicts: report.verdicts, lateralBands: report.lateralBands, network: report.network }, null, 2));
