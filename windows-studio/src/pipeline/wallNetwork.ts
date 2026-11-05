/**
 * 墙网级端点连接：把拟合得到的墙候选线段整理成可追溯的墙网（节点 + 边），
 * 取代原先"两条非平行墙的端点都距交点 12 cm 以内就把端点直接相连"的局部拼接。
 *
 * 规则（全部是功能连接参数，不是精度阈值；RD-01 真值未提供，本模块不作精度认证）：
 * - 贴合：端点落在另一墙轴线段范围内、横向偏差 ≤ TIE_TOLERANCE_M 时，把端点投到该墙轴上，
 *   并在这面墙上插入墙网节点（T 形/丁字连接）；被穿过的墙在该节点处分段。
 * - 角接：同一顶点（≤ VERTEX_MERGE_M）汇合 ≥2 条非共线墙的端部对齐到该节点；穿过顶点的共线墙不在此打断。
 * - 延长：缺口 ≤ MAX_EXTENSION_M 且只沿某一方的墙轴延长线（另一端点在对方轴线延长线上 ≤ TIE_TOLERANCE_M）
 *   才把被延长的一方延伸到对方端点上；延长段与原段同轴，不产生斜线。
 * - 洞口：缺口 ≥ OPENING_M 一律视为洞口/门口，绝不补墙；MAX_EXTENSION_M–OPENING_M 之间不连接并列入未闭合清单。
 * - 延伸后不足 MIN_PIECE_M 的延伸回退为悬空端，并计入清单"延伸不足"。
 * 每段墙记录"原墙候选段号 / 第几子段 / 子段总数 / 本次连接位移"，节点与边可追溯到原墙段。
 */

type P = [number, number];

export interface WallPiece {
  a: P; b: P; support: number; rmsM: number; sourceIndex: number; pieceStart: number; pieceCount: number; joinMm: number;
  /** 原始墙候选段号（去重前的拟合编号）：输入段带 sources 时原样带出，供诊断回溯到拟合输出。 */
  sources?: number[];
}
export interface WallNode { id: number; p: P; degree: number; walls: number[] }
/** 未连接项：位置 + 原因，供诊断脚本与告警逐条输出。 */
export type UnclosedReason = "opening" | "gap-too-large" | "no-alignment" | "extension-too-short" | "corner-too-far" | "corner-no-evidence" | "structural-gap";
export interface UnclosedEnd {
  segmentIndex: number; end: "a" | "b"; pointM: P; reason: UnclosedReason;
  gapM?: number; targetSegmentIndex?: number; corner?: CornerSkipReason; note: string;
}
export interface JoinCounts {
  /** 墙网建成后的端点数（切分后）。 */
  endpoints: number;
  /** 不再悬空的端点数。 */
  connected: number;
  /** 因洞口（缺口 ≥ OPENING_M）保留、不连接的悬空端。 */
  opening: number;
  /** 缺口在 (MAX_EXTENSION_M, OPENING_M) 的悬空端：计入未闭合问题。 */
  unclosed: number;
  /** 未连接的悬空端合计（等于 unclosed 清单长度）。 */
  dangling: number;
  /** 贴合 + 角接 + 延长三类连接数。 */
  joined: number;
  /** 沿墙轴延长段数。 */
  extensions: number;
  /** 在既有墙上插入节点的次数（T 形/丁字）。 */
  insertedNodes: number;
  /** 墙段被插入节点切分的次数。 */
  splits: number;
  /** 延伸段不足最小墙长而回退的次数。 */
  revertedExtensions: number;
  /** 收敛到墙角的次数（角部连接）。 */
  corners: number;
  /** 检查过的角部断点数（= corners 清单长度）。 */
  cornerCandidates: number;
}
export interface WallNetwork {
  /** 原墙候选顺序不变；被切分时 a→b 仍沿原方向，pieceStart 按原段局部累计。 */
  segments: WallPiece[];
  nodes: WallNode[];
  edges: number;
  join: JoinCounts;
  unclosed: UnclosedEnd[];
  /** 角部断点清单：每对"延长线可交于墙角、端点却互不共线"的自由端，与处理结果（已收敛/保持断开的原因）。 */
  corners: CornerJoin[];
  /** 回退与其它可复核提示。 */
  notes: string[];
}

/** 贴合横向容差：拟合 RMS 上限 4.5 cm 的 2.5 倍，覆盖端点抖动又不吸收平行墙。 */
export const TIE_TOLERANCE_M = .12;
/** 同一顶点合并半径（与 buildingOps 节点合并的 2 mm 再放大到 2 cm）。 */
export const VERTEX_MERGE_M = .02;
/** 允许沿墙轴延长补缝的最大缺口（Issue 参数）。 */
export const MAX_EXTENSION_M = .5;
/** 视为洞口/门口、一律不连接的最小缺口（Issue 参数）。 */
export const OPENING_M = 1;
/** 延伸段最小墙长：低于拟合器保留下限即判为"延伸不足以成墙"。 */
export const MIN_PIECE_M = .8;
/** 角接对齐上限：缺口超过此值时角接让位于"洞口/未闭合"。 */
const CORNER_ALIGN_M = .15;
/** 共线判定：方向正弦差 ≤ 0.2（约 11.5°）。 */
const CORNERS_COLLINEAR = .2;
/**
 * 角部连接：两段墙的轴线延长线交点距**两端点**都不超过该距离时，把两端点收敛到交点节点。
 * 与沿轴延长上限 MAX_EXTENSION_M 取同一功能参数（Issue 参数），不另立阈值。
 */
export const CORNER_REACH_M = MAX_EXTENSION_M;
/** 角部连接要求两段夹角不小于该值；更小的夹角属于同一墙轴的错位缺口，走沿轴延长，不在角部补斜线。 */
const CORNER_MIN_ANGLE = .35;
/** 角部交点附近的墙体证据：以交点为圆心、该半径内必须有支撑墙段（墙轴穿过软带、或墙段端点在软带内）。 */
export const CORNER_EVIDENCE_M = .3;
/** 角部连接失败的原因，逐条列出供诊断脚本与清单使用。 */
export type CornerSkipReason = "too-far" | "too-short" | "no-evidence";
/** 角部断点：一对延长线可交于墙角、但两端点互不共线的自由端，及其处理结果。 */
export interface CornerJoin {
  /** 待收敛的两个端点所在墙段。 */
  segments: [number, number];
  ends: ["a" | "b", "a" | "b"];
  /** 两端点当前坐标与间距（收敛前）。 */
  points: [P, P];
  gapM: number;
  /** 两段墙夹角（度）。 */
  angleDeg: number;
  /** 轴线延长线交点；平行或重合时为 null。 */
  intersection: P | null;
  /** 交点到两端点的距离。 */
  toA: number;
  toB: number;
  /** 交点附近的墙体证据支撑格（参与墙段的 support 之和）。 */
  evidenceCells: number;
  /** 处理结果：joined = 已收敛到交点；skipped = 保持断开，reason 给出原因。 */
  outcome: "joined" | "skipped";
  reason?: CornerSkipReason;
  /** 原始墙候选段号（去重前的拟合编号，sources）。 */
  sources: [number[] | undefined, number[] | undefined];
}

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pointOn = (p: P): P => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
const endpointOf = (s: WallPiece, end: "a" | "b") => (end === "a" ? s.a : s.b);
/** 返回替换了某个端点的新墙段；注意墙段可能是冻结的，调用方须把返回值写回数组。 */
const withEndpoint = (s: WallPiece, end: "a" | "b", p: P): WallPiece => ({ ...s, a: end === "a" ? p : s.a, b: end === "b" ? p : s.b });

interface Axis { a: P; ux: number; uy: number; length: number }

/** 墙轴：起点、单位方向与长度。 */
function axisOf(s: WallPiece): Axis {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], length = Math.hypot(dx, dy);
  return { a: s.a, ux: dx / length, uy: dy / length, length };
}
const at = (s: WallPiece, t: number): P => pointOn([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
/** 点在墙轴上的投影：t 为段内参数（0–1 落在段内），offset 为有符号横向偏差。 */
const project = (axis: Axis, p: P) => { const v = sub(p, axis.a); return { t: dot(v, [axis.ux, axis.uy]) / axis.length, offset: cross([axis.ux, axis.uy], v) }; };
/** 两条墙的方向是否共线（方向正弦差 ≤ 0.2，约 ±11.5°）。 */
const collinear = (x: WallPiece, y: WallPiece) => Math.abs(Math.sin(endpointsAngle(x) - endpointsAngle(y))) <= CORNERS_COLLINEAR;

/**
 * 沿墙轴延长：把 end 端顺墙轴方向延伸到 target 在墙轴上的投影位置（而不是以当前端点为参照，
 * 否则反复延长会逐轮累加），返回延长后的端点。
 * 朝反方向、或 target 与本方轴线横向偏差超过 TIE_TOLERANCE_M（不共轴）时返回 undefined。
 */
function extendAlong(axis: Axis, end: "a" | "b", target: P): P | undefined {
  const { t, offset } = project(axis, target);
  // 目标必须落在本方轴线的延长方向上（横向偏差 ≤ TIE_TOLERANCE_M），否则就不是同一墙轴。
  if (Math.abs(offset) > TIE_TOLERANCE_M) return undefined;
  const sign = end === "b" ? 1 : -1;
  // 朝缺口方向：b 端要有 t > 1，a 端要有 t < 0。
  if (sign * (t - (end === "b" ? 1 : 0)) <= 1e-9) return undefined;
  if (sign * (t - (end === "b" ? 1 : 0)) > MAX_EXTENSION_M / axis.length + 1e-9) return undefined;
  const p = pointOn([axis.a[0] + axis.ux * t * axis.length, axis.a[1] + axis.uy * t * axis.length]);
  const current = end === "b" ? [axis.a[0] + axis.ux * axis.length, axis.a[1] + axis.uy * axis.length] as P : axis.a;
  return distance(p, current) > 1e-6 ? p : undefined;
}

const endpointsAngle = (s: WallPiece) => Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
const endpointAt = (p: P, axis: Axis): P => { const v = sub(p, axis.a), l = dot(v, [axis.ux, axis.uy]); return pointOn([axis.a[0] + axis.ux * l, axis.a[1] + axis.uy * l]); };
/** 两条墙轴的延长线交点；平行（方向正弦差 ≤ 1e-6）时返回 undefined。 */
function intersectionOf(x: Axis, y: Axis): P | undefined {
  const denominator = cross([x.ux, x.uy], [y.ux, y.uy]);
  if (Math.abs(denominator) < 1e-6) return undefined;
  const v = sub(y.a, x.a), t = cross(v, [y.ux, y.uy]) / denominator;
  return pointOn([x.a[0] + x.ux * t, x.a[1] + x.uy * t]);
}

/**
 * 墙网级端点连接。输入为拟合墙候选，输出墙网（节点 + 边）与未连接清单。
 *
 * 执行顺序（每一步都只作用于"尚未连接的悬空端"）：
 * 1. 贴合：端点落在另一墙段内部、横向偏差 ≤ TIE_TOLERANCE_M → 投到该墙轴，并在该墙插节点分段（T/丁）。
 * 2. 角接：相距 ≤ VERTEX_MERGE_M 的端部聚成顶点，同一点上汇合≥2 条非共线墙时对齐到同一节点。
 * 3. 延长：缺口 ≤ MAX_EXTENSION_M 且只沿某一方的墙轴延长线时，把该方延伸到对方端点上；
 *    对方端点同时对齐到本方轴线，缺口两侧共点的墙端一并移动，因此结果是一个节点而不是两段斜线。
 *    延伸后不足 MIN_PIECE_M 的回退并记录"延伸不足"。
 * 4. 节点合并 + 未连接清单（洞口 ≥ OPENING_M、0.5–1.0 m 未闭合、不同轴、延伸不足）。
 */
export function buildWallNetwork<T extends { a: P; b: P; support: number; rmsM: number }>(input: ReadonlyArray<T>): WallNetwork {
  const segments: WallPiece[] = input.map((s, i) => {
    const piece: WallPiece = { a: pointOn(s.a), b: pointOn(s.b), support: s.support, rmsM: s.rmsM, sourceIndex: i, pieceStart: 0, pieceCount: 1, joinMm: 0 };
    // 输入带去重来源编号（wallDedupe 的 sources）时原样带出，诊断可回溯到拟合原始输出。
    const sources = (s as { sources?: number[] }).sources;
    if (sources) piece.sources = [...sources];
    return piece;
  });
  const notes: string[] = [];
  const revertedKeys = new Set<string>();
  /** 本轮被延长或对齐移动过的端点（原墙段号:端点），避免沿移动后的坐标连锁延长。 */
  const moved = new Set<string>();
  /** 贴合/角接阶段的端点对齐容差：两段墙轴在接头处的横向错位上限。 */
  const SNAP_TOLERANCE_M = TIE_TOLERANCE_M;
  /**
   * 墙段是否已经由别的连接（贴合/角接/延长）动过：动过的墙不再参与"保持另一端点不动"的外延对齐，
   * 否则会牵连已被连接的顶点；只在它正是本次接头的目标端时才允许移动该端。
   */
  const touched = new Set<string>();
  let joined = 0, extensions = 0, insertedNodes = 0, splits = 0, reverted = 0;

  const endpointOf = (s: WallPiece, end: "a" | "b") => (end === "a" ? s.a : s.b);
  const setEndpoint = (s: WallPiece, end: "a" | "b", p: P): WallPiece => ({ ...s, a: end === "a" ? p : s.a, b: end === "b" ? p : s.b });
  /** 所有墙段的 (段号, 端点) 列表。 */
  const allEnds = () => segments.flatMap((_, i) => (["a", "b"] as const).map(end => ({ i, end, p: endpointOf(segments[i]!, end) })));
  /** 该端点是否已被别的墙端接住（同一 2 cm 顶点）；allow 为本次要连接的对方端点，不算占用。 */
  const jointed = (i: number, end: "a" | "b", allow?: { i: number; end: "a" | "b" }) => {
    const p = endpointOf(segments[i]!, end);
    return allEnds().some(e => e.i !== i && !(allow && allow.i === e.i && allow.end === e.end) && distance(e.p, p) <= VERTEX_MERGE_M);
  };
  /** 该点是否落在别的墙身内部（T 形节点只能由贴合插点占用）。 */
  const insideWall = (p: P, skip: readonly number[]) => segments.some((other, k) => !skip.includes(k) && (() => { const { t, offset } = project(axisOf(other), p); return Math.abs(offset) <= TIE_TOLERANCE_M && t > 0 && t < 1; })());

  /** 在既有墙轴上插入节点：按参数 t 切成 a→t 与 t→b 两段，方向不变，子段序号按原段局部从 0 累计。 */
  const splitAt = (index: number, t: number) => {
    const s = segments[index]!, point = at(s, t);
    segments.splice(index, 1, { ...s, b: point }, { ...s, a: point });
    const pieces = segments.filter(piece => piece.sourceIndex === s.sourceIndex);
    pieces.forEach((piece, order) => { piece.pieceStart = order; piece.pieceCount = pieces.length; });
    splits++;
    insertedNodes++;
    joined++;
    return point;
  };

  /** 端点沿墙轴到最近墙段（不含本段）的缺口距离。 */
  const nearestGap = (i: number, source: P) => nearestWall(i, source).gap;
  /** 端点沿墙轴到最近墙段（不含本段）的缺口与其段号。 */
  const nearestWall = (i: number, source: P) => {
    let best = { gap: Infinity, index: -1 };
    segments.forEach((other, k) => {
      if (k === i) return;
      const { t } = project(axisOf(other), source);
      const gap = distance(source, t < 0 ? other.a : t > 1 ? other.b : at(other, t));
      if (gap < best.gap) best = { gap, index: k };
    });
    return best;
  };

  const noteRevert = (piece: WallPiece, end: "a" | "b") => {
    reverted++;
    const key = `${piece.sourceIndex}:${end}`;
    if (revertedKeys.has(key)) return;
    revertedKeys.add(key);
    notes.push(`墙段 #${piece.sourceIndex} 的 ${end} 端延伸后不足 ${MIN_PIECE_M} m，已回退为悬空端（延伸不足）。`);
  };

  // 1) 贴合：端点落在另一墙段内部（横向 ≤ TIE_TOLERANCE_M）→ 投到该墙轴并在该墙插节点。
  for (let guard = 0, changed = true; changed && guard < 16; guard++) {
    changed = false;
    for (let i = 0; i < segments.length && !changed; i++) for (const end of ["a", "b"] as const) {
      // 本方端点已接入某个节点时不再插点，避免把已连接的顶点切开。
      if (jointed(i, end)) continue;
      for (let j = 0; j < segments.length && !changed; j++) {
        if (i === j) continue;
        const axis = axisOf(segments[j]!), { t, offset } = project(axis, endpointOf(segments[i]!, end));
        // 只在对方段内插点；离对方端点 2 cm 以内的由角接或节点合并处理。
        if (Math.abs(offset) > TIE_TOLERANCE_M || t * axis.length < VERTEX_MERGE_M || (1 - t) * axis.length < VERTEX_MERGE_M) continue;
        // 对方墙段在本端点之后已经分成共线子段（去重合并的长墙被前一次贴合切开）时，
        // 端点落在哪个子段内无关紧要：墙轴与该长墙截面的交点才是真正的节点位置。
        const collinearPieces = segments.filter(piece => piece.sourceIndex === segments[j]!.sourceIndex && collinear(piece, segments[j]!));
        const tieT = collinearPieces.length > 1 ? Math.min(1, Math.max(0, project(axis, endpointOf(segments[i]!, end)).t)) : t;
        const point = at(segments[j]!, tieT);
        segments[i] = setEndpoint(segments[i]!, end, point);
        touched.add(`${segments[i]!.sourceIndex}`); touched.add(`${segments[j]!.sourceIndex}`);
        splitAt(j, tieT);
        changed = true;
      }
    }
  }

  // 2) 角接：相距 ≤ VERTEX_MERGE_M 的端部聚成顶点；同一顶点上汇合≥2 条非共线墙时对齐到同一节点。
  for (let guard = 0, again = true; again && guard < 32; guard++) {
    again = false;
    const ends = allEnds(), clusters: typeof ends[] = [];
    for (const e of ends) {
      const cluster = clusters.find(c => distance(c[0]!.p, e.p) <= VERTEX_MERGE_M);
      if (cluster) cluster.push(e); else clusters.push([e]);
    }
    for (const cluster of clusters) {
      const group = cluster.filter(e => !cluster.some(o => o.i !== e.i && collinear(segments[o.i]!, segments[e.i]!)));
      if (new Set(group.map(e => e.i)).size < 2) continue;
      if (group.every(e => distance(e.p, group[0]!.p) <= 1e-9)) continue;
      const node = pointOn([group.reduce((sum, e) => sum + e.p[0], 0) / group.length, group.reduce((sum, e) => sum + e.p[1], 0) / group.length]);
      if (group.some(e => distance(e.p, node) > CORNER_ALIGN_M)) continue;
      for (const e of group) { segments[e.i] = setEndpoint(segments[e.i]!, e.end, node); touched.add(`${segments[e.i]!.sourceIndex}`); }
      joined++;
      again = true;
      break;
    }
  }

  // 3) 延长：缺口 ≤ MAX_EXTENSION_M 且只沿某一方的墙轴延长线成立时，把该方延伸到对方端点上。
  //    先试"对方端点在延长方向上"（A 正对 B），再试"本方端点在对方延长方向上"（B 正对 A），
  //    两种都是同一墙轴上的真实缺口；都不成立就不补（不产生斜线）。
  for (let guard = 0, acted = true; acted && guard < 256; guard++) {
    acted = false;
    for (let i = 0; i < segments.length && !acted; i++) for (const end of ["a", "b"] as const) {
      for (let j = 0; j < segments.length && !acted; j++) {
        if (i === j) continue;
        for (const other of ["a", "b"] as const) {
          const outcome = tryExtend(i, end, j, other);
          if (!outcome) continue;
          if (outcome === "reverted") { noteRevert(segments[i]!, end); continue; }
          extensions++;
          acted = true;
          break;
        }
      }
    }
  }

  /** 尝试 i 的 end 端去接 j 的 other 端：返回是否已延长、是否回退（延伸不足）或 undefined（不成立）。 */
  function tryExtend(i: number, end: "a" | "b", j: number, other: "a" | "b"): "extended" | "reverted" | undefined {
    const own = segments[i]!, source = endpointOf(own, end), target = endpointOf(segments[j]!, other), gap = distance(source, target);
    if (gap <= VERTEX_MERGE_M || gap > MAX_EXTENSION_M) return undefined;
    // 待接的两端都必须仍是悬空端：已被别的墙接住的端点不再延长。
    if (jointed(i, end) || jointed(j, other, { i, end })) return undefined;
    // 对方端点本轮已被移动过：不作为延长目标（已在同一顶点上的不算移动）。
    if (moved.has(`${segments[j]!.sourceIndex}:${other}`) && distance(source, target) > VERTEX_MERGE_M) return undefined;
    // 只补真正的缺口：本方墙轴到所有墙段的最短距离就是与对方的距离，否则说明中间还隔着别的墙
    // （例如同一原墙段被贴合切分出的另一子段，此时应当由那段墙继续接，而不是跨过它）。
    if (nearestGap(i, source) + 1e-6 < gap) return undefined;
    return dirA(i, end, j, other) ?? dirB(i, end, j, other);
  }

  /** 方向一：本方沿自身墙轴延长到对方端点上。 */
  function dirA(i: number, end: "a" | "b", j: number, other: "a" | "b"): "extended" | "reverted" | undefined {
    const own = segments[i]!, source = endpointOf(own, end), target = endpointOf(segments[j]!, other);
    // 方向一要求 0.5 m 以内的真实缺口：缺口本身超过 MAX_EXTENSION_M 时不延长。
    if (distance(source, target) > MAX_EXTENSION_M) return undefined;
    // 对方端点落在本方段内部（投影 t∈(0,1)、横向偏差在贴合容差内）时由贴合处理，不在此补齐；
    // t≥1 表示对方在本方延长线的前方，正是需要补的缺口。
    {
      const { t, offset } = project(axisOf(own), target);
      if (t > 1e-6 && t < 1 - 1e-6 && Math.abs(offset) <= TIE_TOLERANCE_M) return undefined;
    }
    const axis = axisOf(own), p = extendAlong(axis, end, target);
    if (!p) return undefined;
    const targetAxis = axisOf(segments[j]!), aligned = endpointAt(p, targetAxis);
    // 对方端点横向错位须落在贴合容差内；超出说明不是同一墙轴。
    if (distance(aligned, p) > SNAP_TOLERANCE_M || insideWall(p, [i, j]) || distance(p, source) > MAX_EXTENSION_M) return undefined;
    const next = setEndpoint(own, end, p);
    if (distance(next.a, next.b) < MIN_PIECE_M) return "reverted";
    commit(p, aligned, i, end, j, other);
    return "extended";
  }

  /** 方向二：对方端点沿自身墙轴延长到本方端点上（两段之间的缺口从对方一侧补上）。 */
  function dirB(i: number, end: "a" | "b", j: number, other: "a" | "b"): "extended" | undefined {
    const own = segments[i]!, source = endpointOf(own, end), target = endpointOf(segments[j]!, other);
    const otherAxis = axisOf(segments[j]!), q = extendAlong(otherAxis, other, source);
    if (!q) return undefined;
    const aligned = endpointAt(q, axisOf(own));
    if (distance(aligned, source) > SNAP_TOLERANCE_M || insideWall(q, [i, j]) || distance(q, target) > MAX_EXTENSION_M) return undefined;
    // 对方端点伸长到本方端点处：对方墙变长，本方端点对齐到对方轴线。
    segments[j] = { ...setEndpoint(segments[j]!, other, aligned), joinMm: Math.round(distance(target, q) * 1000) };
    segments[i] = setEndpoint(own, end, aligned);
    moved.add(`${segments[j]!.sourceIndex}:${other}`);
    moved.add(`${own.sourceIndex}:${end}`);
    touched.add(`${segments[j]!.sourceIndex}`);
    touched.add(`${own.sourceIndex}`);
    return "extended";
  }

  /** 落实一次延长：移动本方端点、把对方端点对齐到本方轴线，并带上同一顶点上的其它墙端。 */
  function commit(p: P, aligned: P, i: number, end: "a" | "b", j: number, other: "a" | "b") {
    const own = segments[i]!, source = endpointOf(own, end), previousTarget = endpointOf(segments[j]!, other);
    segments[j] = setEndpoint(segments[j]!, other, aligned);
    // 与对方该端共点、且本轮尚未被连接动过的墙端（角点上的另一面墙）随之一并对齐。
    for (let k = 0; k < segments.length; k++) {
      if (k === i || k === j || touched.has(`${segments[k]!.sourceIndex}`)) continue;
      for (const o of ["a", "b"] as const) if (distance(endpointOf(segments[k]!, o), previousTarget) <= VERTEX_MERGE_M) segments[k] = setEndpoint(segments[k]!, o, aligned);
    }
    segments[i] = { ...setEndpoint(own, end, p), joinMm: Math.round(distance(source, p) * 1000) };
    moved.add(`${own.sourceIndex}:${end}`);
    moved.add(`${segments[j]!.sourceIndex}:${other}`);
    touched.add(`${own.sourceIndex}`);
    touched.add(`${segments[j]!.sourceIndex}`);
  }

  // 3b) 角部连接：两段互不共线的墙，各自沿墙轴延长后的交点距两端点都 ≤ CORNER_REACH_M、
  //     交点附近有墙体证据时，把两个端点收敛到交点这一个节点上。不满足的保持断开，逐条进角部断点清单，
  //     不进未闭合清单的其它口径（§4 的悬空端原因沿用同一清单）。
  const corners: CornerJoin[] = [];
  let cornerJoins = 0;
  /** 已判定过的端点组合（含镜像顺序）：收敛会移动端点，重复扫描时不能把同一对再判定一遍，
   *  否则已收敛的一对会以收敛后的坐标被重新记成"交点过远"而覆盖收敛结论。 */
  const cornerSeen = new Set<string>();
  // 一轮扫描逐对记录角部断点；收敛会移动端点，因此重复扫描直到本轮没有新的收敛（上限防死循环）。
  for (let guard = 0; guard < 256; guard++) {
    let acted = false;
    // 每个端点至多属于一处角部断点：本端已经接入节点（贴合/延长/角部）时不再参与，
    // 角部清单因此逐对可读，也不会对同一个断点往返重复记录。
    for (let i = 0; i < segments.length; i++) for (const end of ["a", "b"] as const) {
      if (acted || jointed(i, end)) continue;
      for (let j = 0; j < segments.length && !acted; j++) {
        if (i === j) continue;
        for (const other of ["a", "b"] as const) {
          const key = `${i}:${end}|${j}:${other}`;
          if (cornerSeen.has(key)) continue;
          const candidate = cornerCandidate(i, end, j, other);
          if (!candidate) continue;
          cornerSeen.add(key);
          // 同一对端点从两端都会被走到：镜像组合也标记为已判定，角部清单里一对只出现一次。
          cornerSeen.add(`${j}:${other}|${i}:${end}`);
          corners.push(candidate.record);
          if (candidate.outcome === "joined") { acted = true; cornerJoins++; }
          break;
        }
      }
    }
    if (!acted) break;
  }
  // 收敛会把端点移到交点：同一个角部断点可能以收敛前的坐标被记录多次（例如先记"交点过远"、
  // 收敛后再记相邻的一对）。按"墙段对 + 端点"去重，一对只保留最后一条（收敛后的真实状态）。
  const stillOpen = [...corners.reduce((map, c) => {
    const key = [c.segments[0]!, c.ends[0], c.segments[1]!, c.ends[1]].join(":");
    return map.set(key, c);
  }, new Map<string, CornerJoin>()).values()].map(c => {
    // 收敛条目以最终几何为准：两端点合并到同一节点后间距为 0（节点半径由后续节点合并给出）。
    if (c.outcome !== "joined") return c;
    const a = segments.find(s => s.sourceIndex === c.segments[0]!)?.[c.ends[0]], b = segments.find(s => s.sourceIndex === c.segments[1]!)?.[c.ends[1]];
    return a && b ? { ...c, gapM: Math.round(distance(a, b) * 1000) / 1000 } : c;
  });
  /** 检查一对端点是否构成墙角：返回"已收敛/保持断开"及其清单记录；两者都不是（例如平行墙）时返回 undefined。 */
  function cornerCandidate(i: number, end: "a" | "b", j: number, other: "a" | "b", apply = true): { outcome: "joined" | "skipped"; record: CornerJoin } | undefined {
    const own = segments[i]!, far = segments[j]!, p = endpointOf(own, end), q = endpointOf(far, other);
    // 两端点已经合在同一个节点上（≤ VERTEX_MERGE_M）时是节点合并而不是墙角收敛，由第 4 步一并处理。
    if (distance(p, q) <= VERTEX_MERGE_M) return undefined;
    // 墙体证据的搜索半径：两端点本身相距不能超过两段各自的可达距离之和，否则这对端点之间没有可收敛的墙角，
    // 属于"缺墙或洞口"，连角部断点都不记录。
    if (distance(p, q) > 2 * CORNER_REACH_M) return undefined;
    if (collinear(own, far)) return undefined;
    const hit = intersectionOf(axisOf(own), axisOf(far));
    if (!hit) return undefined;
    const toA = distance(p, hit), toB = distance(q, hit), angle = Math.abs(Math.sin(endpointsAngle(far) - endpointsAngle(own)));
    // 夹角太小（< CORNER_MIN_ANGLE 的正弦）等同于同一墙轴的错位缺口：交给沿轴延长，不在角部补斜线。
    if (angle < Math.sin(CORNER_MIN_ANGLE)) return undefined;
    const reachable = toA > 1e-6 && toB > 1e-6 && toA <= CORNER_REACH_M + 1e-9 && toB <= CORNER_REACH_M + 1e-9;
    const record = (outcome: "joined" | "skipped", reason?: CornerSkipReason): { outcome: "joined" | "skipped"; record: CornerJoin } => ({
      outcome, record: {
        segments: [own.sourceIndex, far.sourceIndex], ends: [end, other],
        points: [pointOn(p), pointOn(q)], gapM: Math.round(distance(p, q) * 1000) / 1000,
        angleDeg: Math.round(Math.asin(Math.min(1, angle)) * 1800 / Math.PI) / 10,
        intersection: pointOn(hit), toA: Math.round(toA * 1000) / 1000, toB: Math.round(toB * 1000) / 1000,
        evidenceCells: own.support + far.support, outcome, reason,
        sources: [own.sources, far.sources],
      },
    });
    if (!reachable) return record("skipped", "too-far");
    // 交点处必须有墙体证据：另一段（不含这一对）的墙轴穿过交点软带，或另一段的端点落在软带内。
    const evidence = segments.some((s, k) => {
      if (k === i || k === j) return false;
      const axis = axisOf(s), { t, offset } = project(axis, hit);
      return Math.abs(offset) <= TIE_TOLERANCE_M && t * axis.length >= -CORNER_EVIDENCE_M && t * axis.length <= axis.length + CORNER_EVIDENCE_M;
    }) || segments.some((s, k) => k !== i && k !== j && (distance(s.a, hit) <= CORNER_EVIDENCE_M || distance(s.b, hit) <= CORNER_EVIDENCE_M));
    if (!evidence) return record("skipped", "no-evidence");
    // 收敛后任一段不足最小墙长时不连（不产生短墙段，与延伸不足同一口径）。
    if (distance(end === "a" ? hit : own.a, end === "a" ? own.b : hit) < MIN_PIECE_M) return record("skipped", "too-short");
    if (distance(other === "a" ? hit : far.a, other === "a" ? far.b : hit) < MIN_PIECE_M) return record("skipped", "too-short");
    const target = pointOn(hit);
    if (distance(p, target) <= 1e-6 && distance(q, target) <= 1e-6) return undefined;
    // 只读判定（未闭合清单）到此为止：给出"可收敛"与否，但不移动任何端点。
    if (!apply) return record("joined");
    // 两端点收敛到同一交点节点：各沿自身墙轴移动，墙轴方向不变，两端之间的连线即为墙角而非斜撑。
    segments[i] = setEndpoint(own, end, target);
    segments[j] = setEndpoint(far, other, target);
    touched.add(`${own.sourceIndex}`); touched.add(`${far.sourceIndex}`);
    moved.add(`${own.sourceIndex}:${end}`); moved.add(`${far.sourceIndex}:${other}`);
    // 与这两个端点共点、且本轮尚未被连接动过的其它墙端随之一并对齐（同一角点上的第三面墙）。
    for (let k = 0; k < segments.length; k++) {
      if (k === i || k === j || touched.has(`${segments[k]!.sourceIndex}`)) continue;
      for (const o of ["a", "b"] as const) if (distance(endpointOf(segments[k]!, o), p) <= VERTEX_MERGE_M) segments[k] = setEndpoint(segments[k]!, o, target);
    }
    return record("joined");
  }

  /**
   * 悬空端与另一墙段的角部判定（只读，不改几何）：对方最近的点必须是它的端点（丁字接头的墙身不算墙角），
   * 且两段不共线；随后按角部规则给出原因（交点过远/无墙体证据/收敛后过短），供未闭合清单沿用。
   */
  function cornerVerdict(own: WallPiece, end: "a" | "b", far: WallPiece, near: P): CornerSkipReason | undefined {
    // 对方最近的点是墙体自身（T 形贴合的目标）而不是它的端点时，这不是墙角断点：交给贴合与未闭合清单的原有原因。
    // 共线缺口本来就走沿轴延长，同样不算角部断点。
    if (distance(far.a, near) > VERTEX_MERGE_M && distance(far.b, near) > VERTEX_MERGE_M) return undefined;
    if (collinear(own, far)) return undefined;
    const other = distance(far.a, near) <= distance(far.b, near) ? "a" : "b";
    // 未闭合清单是只读的再次判定：不受角部扫描"已处理过"的记忆限制，也不改几何。
    return cornerCandidate(segments.indexOf(own), end, segments.indexOf(far), other, false)?.record.reason;
  }

  // 4) 端点合并成墙网节点（半径 VERTEX_MERGE_M），记录每个节点连接的墙。
  const nodes: WallNode[] = [];
  const nodeOf = (p: P) => {
    const found = nodes.findIndex(n => distance(n.p, p) <= VERTEX_MERGE_M);
    if (found >= 0) return found;
    nodes.push({ id: nodes.length, p: pointOn(p), degree: 0, walls: [] });
    return nodes.length - 1;
  };
  const ends = segments.map(s => [nodeOf(s.a), nodeOf(s.b)] as const);
  ends.forEach(([a, b], i) => {
    const source = segments[i]!.sourceIndex;
    for (const n of new Set([a, b])) { nodes[n]!.degree++; if (!nodes[n]!.walls.includes(source)) nodes[n]!.walls.push(source); }
  });

  // 5) 悬空端逐条给出原因。洞口判定优先于"未对齐"，避免把门口说成对齐问题。
  const unclosed: UnclosedEnd[] = [];
  let opening = 0, tooLarge = 0, dangling = 0;
  ends.forEach(([na, nb], i) => {
    for (const [end, node] of [["a", na], ["b", nb]] as const) {
      if (nodes[node]!.degree !== 1) continue;
      dangling++;
      const p = endpointOf(segments[i]!, end), ownAxis = axisOf(segments[i]!);
      let best: { j: number; gap: number; joinable: boolean; corner?: CornerSkipReason } | undefined;
      segments.forEach((other, j) => {
        if (j === i) return;
        const axis = axisOf(other), { t, offset } = project(axis, p);
        const q = t < 0 ? other.a : t > 1 ? other.b : at(other, t), gap = distance(p, q);
        let joinable = t >= 0 && t <= 1 && Math.abs(offset) <= TIE_TOLERANCE_M;
        if (!joinable) joinable = extendAlong(ownAxis, end, q) !== undefined && Math.abs(offset) <= TIE_TOLERANCE_M;
        // 角部口径：两段不共线、延长线可交于墙角但保持断开时，沿用角部清单的原因，不另立口径。
        const corner = !joinable ? cornerVerdict(segments[i]!, end, other, q) : undefined;
        if (!best || gap < best.gap - 1e-9) best = { j, gap, joinable, corner };
      });
      if (!best) { unclosed.push({ segmentIndex: i, end, pointM: p, reason: "structural-gap", note: "没有其它墙段可比对，孤立方阵或单段墙。" }); continue; }
      const gap = best.gap, gapM = Math.round(gap * 1000) / 1000;
      if (gap >= OPENING_M) { opening++; unclosed.push({ segmentIndex: i, end, pointM: p, reason: "opening", targetSegmentIndex: best.j, gapM, note: `缺口 ${gap.toFixed(2)} m ≥ ${OPENING_M} m，按洞口/门口保留，不连接。` }); continue; }
      if (gap > MAX_EXTENSION_M || !best.joinable) {
        const corner = best.corner;
        tooLarge++;
        unclosed.push({ segmentIndex: i, end, pointM: p, targetSegmentIndex: best.j, gapM,
          // 角部口径与未闭合清单同一来源：可达但被角部规则拒绝的悬空端直接记成角部原因，其余保留原原因并附上角部判定。
          reason: corner === "too-far" ? "corner-too-far" : corner === "no-evidence" ? "corner-no-evidence" : gap > MAX_EXTENSION_M ? "gap-too-large" : "no-alignment",
          corner,
          note: gap > MAX_EXTENSION_M ? `缺口 ${gap.toFixed(2)} m 在 ${MAX_EXTENSION_M}–${OPENING_M} m 之间：不连接，计入未闭合问题。`
            : corner === "too-far" ? `缺口 ${gap.toFixed(2)} m 在延长上限内，但两段延长线交点距端点多于 ${CORNER_REACH_M} m：不拉斜线，计入未闭合问题。`
            : corner === "no-evidence" ? `缺口 ${gap.toFixed(2)} m 在墙角可达范围内，但交点附近没有墙体证据：保持断开，计入未闭合问题。`
            : corner === "too-short" ? `缺口 ${gap.toFixed(2)} m 可在墙角收敛，但收敛后不足最小墙长 ${MIN_PIECE_M} m：保持断开。`
            : `缺口 ${gap.toFixed(2)} m 在延长上限内，但两段不在同一墙轴延长线上，不补斜线。` });
        continue;
      }
      unclosed.push({ segmentIndex: i, end, pointM: p, reason: "extension-too-short", targetSegmentIndex: best.j, gapM, note: `缺口 ${gap.toFixed(2)} m 在延长上限内，但延伸后不足最小墙长 ${MIN_PIECE_M} m，保留为悬空端。` });
    }
  });
  if (splits) notes.push(`${insertedNodes} 次在既有墙上插入节点，墙段由 ${input.length} 条切分为 ${segments.length} 条，节点与边保留原墙候选段号。`);

  const join: JoinCounts = {
    endpoints: segments.length * 2, connected: segments.length * 2 - dangling, opening, unclosed: tooLarge, dangling,
    joined, extensions, insertedNodes, splits, revertedExtensions: reverted,
    corners: stillOpen.filter(c => c.outcome === "joined").length, cornerCandidates: stillOpen.length,
  };
  const openCorners = stillOpen.filter(c => c.outcome === "skipped").length;
  if (stillOpen.length) notes.push(`角部断点 ${stillOpen.length} 处：${stillOpen.length - openCorners} 处收敛到延长线交点，${openCorners} 处保持断开（原因见角部清单）。`);
  return { segments, nodes, edges: segments.length, join, unclosed, corners: stillOpen, notes };
}
