import type { WallSegment } from "./wallLines";

/**
 * 墙候选去重合并：`fitWallLines` 输出之后的后处理。
 *
 * 成因：RANSAC 每接受一条直线，就把落在该直线 ±4.5 cm 内的证据格从待拟合集合中删除；
 * 一面 0.3–0.5 m 厚的墙在下一轮仍留下与已选直线平行的残余证据，于是同一道墙被输出成
 * 2–12 条平行重复段（诊断 `docs/room-closure-diagnosis.md` §4.1）。本模块只把同一墙轴上的
 * 重复段合并回一条，不改抽样、内点删除、端点连接与房间判定。
 *
 * 判据沿用诊断的分类口径（`scripts/diagnose-room-closure.ts` 的共线聚类），写成命名常量；
 * 它们是**功能参数**（多大间距仍算同一道墙），不是精度阈值，也没有 RD-01 真值据以认证。
 */
type P = [number, number];
/** 方向差判据（度）。 */
export const DEDUPE_DIRECTION_DEG = 1.5;
/** 轴间距判据（m）：来源段两端到组内每段轴的最大垂直距离。 */
export const DEDUPE_AXIS_GAP_M = 0.15;
/**
 * 投影相接判据（m）：诊断口径允许投影间最多 0.5 m 空隙仍归同一组（`gap < .5`），
 * 本次合并按任务口径只接受"投影重叠或相接"，故取 2 cm 作为等价于相接的浮点容差。
 */
export const DEDUPE_PROJECTION_GAP_M = 0.02;

const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const direction = (s: WallSegment): P => { const length = distance(s.a, s.b); return [(s.b[0] - s.a[0]) / length, (s.b[1] - s.a[1]) / length]; };
/** 无向夹角（度），0–90°。 */
const angleBetween = (u: P, v: P) => { const delta = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI; return delta > 90 ? 180 - delta : delta; };
const project = (p: P, origin: P, axis: P) => (p[0] - origin[0]) * axis[0] + (p[1] - origin[1]) * axis[1];
const sideOffset = (p: P, origin: P, axis: P) => (p[0] - origin[0]) * axis[1] - (p[1] - origin[1]) * axis[0];
const endpoints = (s: WallSegment): P[] => [s.a, s.b];
const span = (s: WallSegment, origin: P, axis: P): [number, number] => { const t = endpoints(s).map(p => project(p, origin, axis)); return [Math.min(...t), Math.max(...t)]; };

export interface WallMergeGroup {
  /** 参与合并的原段编号（升序），即 `fitWallLines` 原始输出下标，可回溯 diagnosis.json 的 segments[].index。 */
  sourceIndexes: number[];
  /** 骨干段编号（组内最长段，等长取编号小者）。 */
  backboneIndex: number;
  /** 各来源段端点投影到合并轴后的范围并集，以合并后首端为原点。 */
  projectionUnionM: [number, number];
  /** 投影并集被连续覆盖的比例；1 表示合并后轴严格覆盖整段投影并集，<1 说明组内存在空隙。 */
  coveredFraction: number;
  /** 合并后轴长度 m。 */
  lengthM: number;
}

export interface WallSegmentWithSources extends WallSegment {
  /** 合并来源段编号；未参与合并的段为 [自身编号]。 */
  sources: number[];
  /** 合并代表轴信息；未合并时为 null。 */
  merge: Omit<WallMergeGroup, "lengthM"> | null;
}

/**
 * 合并同一墙轴上的重复/平行段。返回结果按原输入顺序（首个来源段编号）排列，
 * 便于与 `fitWallLines` 输出逐段对照。
 *
 * 判据（全部满足才并入同一组，且与组内**每一段**两两满足，避免链式传递）：
 * 1. 方向差 < DEDUPE_DIRECTION_DEG；
 * 2. 来源段两端到该段的轴间距都 < DEDUPE_AXIS_GAP_M（两端对称判据）：
 *    分居轴两侧、各距约 0.15 m 的两道平行墙面必然超判据，因此保持独立；
 * 3. 投影区间与组内某一段重叠，或间隙 ≤ DEDUPE_PROJECTION_GAP_M（相接）；整组投影并集必须连续，
 *    有门洞等真实空隙的链按空隙拆开。
 *
 * 不足：方向差判据是相对**骨干**的 1.5°。真实样本里一组内碎片的方向差达到 0.9–1.2° 时，
 * 各碎片虽都在骨干 1.5° 内，但彼此相差可超过 1.5°（样本 #13/#14、#15/#16 均为 0.90°，中间空 0.30 m），
 * 本口径保持独立、不合并；按诊断的 0.5 m 投影链口径，这两处会各自再合 1 条。
 *
 * 代表轴取法：**组内最长段为骨干**，骨干方向即合并方向；轴位置由全部来源端点相对骨干轴的
 * 横向偏移按来源段长度加权平均得到（长段更能代表这面墙的轴线，短碎片只做微调）；
 * 范围取全部来源端点投影的并集。支撑格为来源之和，RMS 按支撑格加权。
 */
export function mergeWallSegments(segments: WallSegment[]): { segments: WallSegmentWithSources[]; groups: WallMergeGroup[] } {
  const order = segments.map((_, index) => index).sort((a, b) => distance(segments[b]!.a, segments[b]!.b) - distance(segments[a]!.a, segments[a]!.b) || a - b);
  const axes = segments.map(s => direction(s));
  // 轴间距：来源段两端到该段轴的垂直距离都小于判据。两端对称判据：分居轴两侧、各距约 0.15 m 的
  // 两道平行墙面会同时超过判据，因此不会串成一条；同侧 0.02–0.14 m 的重复残影仍可合并。
  const compatible = (i: number, j: number) => {
    if (angleBetween(axes[i]!, axes[j]!) >= DEDUPE_DIRECTION_DEG) return false;
    const sides = endpoints(segments[j]!).map(p => sideOffset(p, segments[i]!.a, axes[i]!));
    return Math.max(...sides.map(Math.abs)) < DEDUPE_AXIS_GAP_M;
  };
  // 两段都投影到 i 的轴上比较投影区间：仅当方向几乎一致时两者等价，不能用 j 自己的轴。
  const touching = (i: number, j: number) => {
    const origin = segments[i]!.a, axis = axes[i]!;
    const [lo, hi] = span(segments[i]!, origin, axis), [jlo, jhi] = span(segments[j]!, origin, axis);
    return Math.max(0, Math.max(lo, jlo) - Math.min(hi, jhi)) <= DEDUPE_PROJECTION_GAP_M;
  };
  const pending: number[][] = [];
  for (const index of order) {
    // 方向、轴间距与组内每段都一致；投影只需与组内**某一段**重叠或相接（同轴碎片链），
    // 分组后再按投影并集检查整组是否连续，有空隙的链会被拆开。
    const target = pending.find(members => members.every(other => compatible(index, other)) && members.some(other => touching(index, other)));
    if (target) target.push(index); else pending.push([index]);
  }
  // 投影并集连续：按投影区间合并后只允许一段连续覆盖；2 cm 内的相接视为连续。
  const contiguous = (members: number[], origin: P, axis: P) => {
    const sorted = members.map(index => span(segments[index]!, origin, axis)).sort((x, y) => x[0] - y[0]);
    let reach = sorted[0]![1];
    for (const [lo, hi] of sorted.slice(1)) { if (lo > reach + DEDUPE_PROJECTION_GAP_M) return false; reach = Math.max(reach, hi); }
    return true;
  };
  const continuous = pending.flatMap(members => {
    if (members.length < 2) return [members];
    const origin = segments[members[0]!]!.a, axis = axes[members[0]!]!;
    if (contiguous(members, origin, axis)) return [members];
    // 链上有空隙：按投影排序后切成若干连续片，各自独立合并。
    const sorted = [...members].sort((a, b) => span(segments[a]!, origin, axis)[0] - span(segments[b]!, origin, axis)[0]);
    const pieces: number[][] = [];
    for (const index of sorted) { const piece = pieces.at(-1); if (piece && touching(index, piece.at(-1)!)) piece.push(index); else pieces.push([index]); }
    return pieces;
  });
  const groups: WallMergeGroup[] = [];
  const merged = new Map<number, WallSegmentWithSources>();
  for (const members of continuous) {
    const sorted = [...members].sort((a, b) => a - b);
    if (members.length === 1) { const only = segments[sorted[0]!]!; merged.set(sorted[0]!, { ...only, a: [...only.a] as P, b: [...only.b] as P, sources: sorted, merge: null }); continue; }
    const backboneIndex = order.find(index => members.includes(index))!;
    const origin = segments[backboneIndex]!.a, axis = axes[backboneIndex]!;
    let weighted = 0, total = 0;
    for (const index of members) { const s = segments[index]!, length = distance(s.a, s.b); weighted += (sideOffset(s.a, origin, axis) + sideOffset(s.b, origin, axis)) * length; total += length; }
    const shift = weighted / (2 * total);
    const at = (t: number): P => [origin[0] + axis[0] * t + axis[1] * shift, origin[1] + axis[1] * t - axis[0] * shift];
    const intervals = members.map(index => span(segments[index]!, origin, axis)).sort((x, y) => x[0] - y[0]);
    const union: Array<[number, number]> = [];
    for (const interval of intervals) { const last = union.at(-1); if (last && interval[0] <= last[1] + DEDUPE_PROJECTION_GAP_M) last[1] = Math.max(last[1], interval[1]); else union.push([...interval]); }
    // 覆盖比例：各段投影区间先并集（2 cm 内相接视为连续），再扣除超过判据的空隙；
    // 1 表示合并后的轴连续覆盖整段投影并集，<1 说明组内存在门洞级空隙。
    const lo = union[0]![0], hi = union.at(-1)![1];
    const unionLength = union.reduce((sum, [s, e]) => sum + e - s, 0);
    const hole = union.slice(1).reduce((sum, [s], k) => sum + Math.max(0, s - union[k]![1]), 0);
    const covered = unionLength - hole;
    const support = members.reduce((sum, index) => sum + segments[index]!.support, 0);
    const rmsM = members.reduce((sum, index) => sum + segments[index]!.rmsM * segments[index]!.support, 0) / Math.max(1, support);
    const report: WallMergeGroup = {
      sourceIndexes: sorted, backboneIndex,
      projectionUnionM: [0, Number((hi - lo).toFixed(6))],
      coveredFraction: Number((covered / Math.max(1e-9, hi - lo)).toFixed(6)),
      lengthM: Number((hi - lo).toFixed(6)),
    };
    groups.push(report);
    merged.set(sorted[0]!, { a: at(lo), b: at(hi), support, rmsM, sources: sorted, merge: { sourceIndexes: sorted, backboneIndex, projectionUnionM: report.projectionUnionM, coveredFraction: report.coveredFraction } });
  }
  const result: WallSegmentWithSources[] = [];
  for (let index = 0; index < segments.length; index++) { const item = merged.get(index); if (item) result.push(item); }
  return { segments: result, groups };
}
