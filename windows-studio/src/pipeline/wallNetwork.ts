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
 * - 最小墙长 MIN_PIECE_M（= 拟合器保留下限 0.8 m）只约束**墙段自身**：角部收敛后任一段是否还成墙、
 *   以及"把短段拉长去够缺口"的反向延长是否回退。连接两段已确认墙体的延长段不受它拦截；
 *   延长段自己的下限是 EXTENSION_MIN_M（= 贴合容差 0.12 m 的独立性下限），只挡住"没量出来却凭空长出一段墙"。
 * - 自由端聚类吸附（Issue #27）：上面各步都判过之后，互为最近邻、距离 ≤ FREE_END_SNAP_M 的两处**度 1 自由端**
 *   吸附成同一个节点；这两点之间必须没有别的墙、也不跨过洞口（距离就是最短缺口）。子 0.3 m 的端点错位
 *   来自拟合角度/端点噪声，用一条统一的吸附阶段处理，不再逐条加规则。
 * 每段墙记录"原墙候选段号 / 第几子段 / 子段总数 / 本次连接位移"，节点与边可追溯到原墙段。
 */

type P = [number, number];

export interface WallPiece {
  a: P; b: P; support: number; rmsM: number; sourceIndex: number; pieceStart: number; pieceCount: number; joinMm: number;
  /** 原始墙候选段号（去重前的拟合编号）：输入段带 sources 时原样带出，供诊断回溯到拟合输出。 */
  sources?: number[];
}
export interface WallNode { id: number; p: P; degree: number; walls: number[] }
/**
 * 未连接项的原因。`extension-too-short` 自 Issue #24（修复 f）起不再产生——连接延长段不再套用最小墙长；
 * 成员保留是为了旧工程读档时已有记录仍有类型。
 */
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
  /** 延伸不足（把不足最小墙长的短段拉长去够缺口）而回退的次数；生产口径下为 0，诊断旧口径对照时非 0。 */
  revertedExtensions: number;
  /** 收敛到墙角的次数（角部连接）。 */
  corners: number;
  /** 检查过的角部断点数（= corners 清单长度）。 */
  cornerCandidates: number;
  /** 自由端聚类吸附（Issue #27）成功的端点数：每成功吸附一对计 2。 */
  snaps: number;
  /** 因吸附后会围出 < SNAP_MIN_FACE_M2 的退化面而回退的吸附次数。 */
  revertedSnaps: number;
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
  /** 自由端聚类吸附清单（Issue #27）：对第一次遇到的自由端逐对给出间距、落点与结果，与角部清单同一口径。 */
  snaps: FreeEndSnap[];
  /** 回退与其它可复核提示。 */
  notes: string[];
  /** 本次判定实际使用的延长口径（诊断复核用；生产运行为常量默认值）。 */
  policies: ExtensionPolicies | null;
}
/** 延长口径：生产中一律用常量默认值，诊断脚本可临时换成旧口径做对照。 */
export interface ExtensionPolicies {
  /** 延长段自身的最小长度（默认 EXTENSION_MIN_M）。 */
  extensionMinM?: number;
  /** true = 延长段也按最小墙长 MIN_PIECE_M 处理（Issue #24 之前的旧口径，仅诊断对照用）。 */
  pieceLengthAppliesToExtension?: boolean;
  /** 诊断对照用：按旧口径整轮跑（延长段先受最小墙长拦截，并写入 `extension-too-short`）。 */
  legacyExtensionLengthGate?: boolean;
  /** 自由端聚类吸附半径（默认 FREE_END_SNAP_M）；0 = 关闭该阶段，只给诊断对照用。 */
  freeEndSnapM?: number;
}

/** 贴合横向容差：拟合 RMS 上限 4.5 cm 的 2.5 倍，覆盖端点抖动又不吸收平行墙。 */
export const TIE_TOLERANCE_M = .12;
/** 同一顶点合并半径（与 buildingOps 节点合并的 2 mm 再放大到 2 cm）。 */
export const VERTEX_MERGE_M = .02;
/** 允许沿墙轴延长补缝的最大缺口（Issue 参数）。 */
export const MAX_EXTENSION_M = .5;
/** 视为洞口/门口、一律不连接的最小缺口（Issue 参数）。 */
export const OPENING_M = 1;
/**
 * 墙段最小墙长：低于拟合器保留下限（`wallLines.ts` 的 0.8 m）即判为"不足以成墙"。
 * 只用于**墙段自身**的判据——角部收敛后任一段是否还成墙、以及"把短段拉长去够缺口"的反向延长是否回退；
 * 不用于拦截连接两段已确认墙体的延长段（见 EXTENSION_MIN_M）。
 */
export const MIN_PIECE_M = .8;
/**
 * 延长段下限：连接两段已确认墙体时，延长段自身只需不是凭空构造的长度。
 * 取代原先套用 MIN_PIECE_M 的口径（Issue #24）：最小墙长是拟合端过滤噪声短段的判据，
 * 套在"两段已确认墙体之间的连接延长段"上会拦掉真实小缺口（PR #22 基线实测 18 条 `extension-too-short`）。
 * 取贴合/端点对齐容差 TIE_TOLERANCE_M：短于它的增量两端无法区分"已确认墙体"与端点抖动，这种增量不延长，
 * 也不计为"延伸不足"回退（延伸不足只留给"把短段拉长去够缺口"这一种情形）。
 */
export const EXTENSION_MIN_M = TIE_TOLERANCE_M;
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

/**
 * 自由端聚类吸附半径（Issue #27，修复 g）：只作用于度 1 自由端。
 *
 * 取值依据真实样本（`tri_true_color_20260911_200108_286`）其余各规则判完后的自由端最近邻距离分布：
 * 0–0.05 m 4 处、0.05–0.12 m 0 处、0.12–0.25 m 0 处、0.25–0.5 m 4 处、>0.5 m 52 处。分布是两段的：
 * 真正的端点错位（拟合角度/端点噪声）全部挤在 0.05 m 以内，而 0.05–0.25 m 这一整段在样本上一个都没有——
 * 也就是说 0.05 m 以上的近邻在样本上都是"缺一段墙"的真缺口，不是端点抖动。
 * 半径取 0.12 m（= 贴合容差 TIE_TOLERANCE_M，0.05–0.12 m 分带的上沿）：短于贴合容差就无法与"已确认墙体"区分，
 * 同时守住 Issue 规定的 0.3 m 上限，并离 0.25 m 处的真缺口留出 0.13 m 余量。
 * 半径不是精度阈值：拟合端另有 4.5 cm RMS 上限，本阶段不改变拟合结果，只移动端点。
 */
export const FREE_END_SNAP_M = TIE_TOLERANCE_M;
/** 退化面下限：吸附后若围出小于该面积的环，说明吸附把一面墙接成窄条，回退这次吸附（与最小面提取同一口径）。 */
export const SNAP_MIN_FACE_M2 = .5;
/** 自由端聚类吸附的跳过原因，逐条给出供诊断脚本与清单使用。 */
export type SnapSkipReason = "not-nearest" | "beyond-radius" | "same-wall" | "another-wall" | "degenerate-face";
/** 一对自由端的吸附记录：两端点、间距、落点与结果（与角部断点同一清单口径）。 */
export interface FreeEndSnap {
  /** 两端点所在墙段与端点；`from` 为吸附前坐标。 */
  segments: [number, number];
  ends: ["a" | "b", "a" | "b"];
  from: [P, P];
  /** 吸附前两端点间距。 */
  distanceM: number;
  /** 落点：两墙轴交点（非平行时），否则两段端点按证据格数加权平均。 */
  landing: P;
  landingSource: "intersection" | "evidence-weighted";
  /** 两段的证据格数（support），加权平均的权重来源。 */
  evidence: [number, number];
  /** 吸附后任一段的长度（墙轴方向未改）。 */
  lengthAfterM: [number, number];
  /** 处理结果：snapped = 已吸附成同一节点；skipped = 保持断开，reason 给出原因。 */
  outcome: "snapped" | "skipped";
  reason?: SnapSkipReason;
  /** 原始墙候选段号（去重前的拟合编号，sources）。 */
  sources: [number[] | undefined, number[] | undefined];
}
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
/**
 * 墙段中不参与本次移动的那一端。角部收敛与吸附只移动墙段的一端，墙轴方向由另一端决定：
 * 轴锚点必须是"离移动端最远的那一端"，否则从 b 端移动 a 端会把墙轴方向一起拖歪。输入段方向随机，
 * 因此不能假设 a 是锚点。
 */
const anchorOf = (s: WallPiece, end: "a" | "b"): P => (end === "a" ? s.b : s.a);
/** 以 anchor 为基点、指向 from 端点的墙轴：吸附时沿这条轴把端点滑动，墙轴方向不变。 */
function axisFrom(anchor: P, from: P): Axis {
  const dx = from[0] - anchor[0], dy = from[1] - anchor[1], length = Math.hypot(dx, dy);
  return { a: anchor, ux: dx / length, uy: dy / length, length };
}
/** 有符号多边形面积（平面图最小面的口径，与 buildingOps 一致）。 */
const signedArea = (poly: readonly P[]) => poly.reduce((sum, p, i) => { const q = poly[(i + 1) % poly.length]!; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
/**
 * 吸附会不会围出退化面：把墙段端点吸附成 2 度节点后，若某条墙段成了两端共点的自环，
 * 或两条墙段在夹角很小的节点上围出 < SNAP_MIN_FACE_M2 的窄条，就是吸附把一面墙接到了自己身上。
 * 这里做一次最小面（平面图内环）判定，只回答"有没有小于下限的面"，不改几何。
 */
function formsDegenerateFace(segments: ReadonlyArray<{ a: P; b: P }>, limit: number): boolean {
  const nodes: P[] = [];
  const nodeAt = (p: P) => { const found = nodes.findIndex(q => distance(q, p) <= VERTEX_MERGE_M); if (found >= 0) return found; nodes.push(p); return nodes.length - 1; };
  const edges: [number, number][] = [];
  for (const s of segments) { const u = nodeAt(s.a), v = nodeAt(s.b); if (u === v) return true; edges.push([u, v]); }
  const outgoing = nodes.map(() => [] as { to: number; angle: number; edge: number }[]);
  edges.forEach(([u, v], index) => {
    const angle = Math.atan2(nodes[v]![1] - nodes[u]![1], nodes[v]![0] - nodes[u]![0]);
    outgoing[u]!.push({ to: v, angle, edge: index });
    outgoing[v]!.push({ to: u, angle: angle > 0 ? angle - Math.PI : angle + Math.PI, edge: index });
  });
  const halfId = (from: number, edge: number) => (edges[edge]![0] === from ? edge * 2 : edge * 2 + 1);
  const seen = new Set<number>();
  for (let index = 0; index < edges.length; index++) for (const from of edges[index]!) {
    if (seen.has(halfId(from, index))) continue;
    const ring: number[] = [];
    let current = from, currentEdge = index;
    for (let guard = 0; guard <= edges.length * 2 + 1; guard++) {
      seen.add(halfId(current, currentEdge));
      ring.push(current);
      const to = edges[currentEdge]![0] === current ? edges[currentEdge]![1] : edges[currentEdge]![0];
      // 转角最小（顺时针最近邻）的半边走法：从 to 出发、相对来向转得最少的那条边是同一个面的下一条边。
      const back = Math.atan2(nodes[current]![1] - nodes[to]![1], nodes[current]![0] - nodes[to]![0]);
      let next: { to: number; angle: number; edge: number } | undefined, bestTurn = Infinity;
      for (const candidate of outgoing[to]!) {
        if (candidate.edge === currentEdge) continue;
        let turn = back - candidate.angle;
        while (turn <= 0) turn += 2 * Math.PI;
        while (turn > 2 * Math.PI) turn -= 2 * Math.PI;
        if (turn < bestTurn - 1e-12) { bestTurn = turn; next = candidate; }
      }
      if (!next) break;
      current = to; currentEdge = next.edge;
      if (current === from && currentEdge === index) {
        if (ring.length >= 3 && Math.abs(signedArea(ring.map(i => nodes[i]!))) < limit) return true;
        break;
      }
    }
  }
  return false;
}

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
 *    连接两段已确认墙体的延长段不受 MIN_PIECE_M 拦截（只有 EXTENSION_MIN_M 的独立性下限）；
 *    把短段拉长去够缺口仍不足 MIN_PIECE_M 时回退并记录"延伸不足"。
 * 4. 节点合并 + 未连接清单（洞口 ≥ OPENING_M、0.5–1.0 m 未闭合、不同轴）。
 *
 * `policies` 只给诊断脚本复核用：返回每一步在判定时实际使用的延长口径，脚本按同一份口径归类。
 */
export function buildWallNetwork<T extends { a: P; b: P; support: number; rmsM: number }>(input: ReadonlyArray<T>, policies: ExtensionPolicies = {}): WallNetwork {
  const build = policies.legacyExtensionLengthGate ? buildWithLegacyExtensionLength : buildNetwork;
  return build(input, policies);
}

/** 旧口径（Issue #24 之前）：延长段自身也按最小墙长 MIN_PIECE_M 拦截。只给诊断脚本对照用。 */
function buildWithLegacyExtensionLength<T extends { a: P; b: P; support: number; rmsM: number }>(input: ReadonlyArray<T>, policies: ExtensionPolicies): WallNetwork {
  return buildNetwork(input, { ...policies, pieceLengthAppliesToExtension: true });
}

function buildNetwork<T extends { a: P; b: P; support: number; rmsM: number }>(input: ReadonlyArray<T>, policies: ExtensionPolicies): WallNetwork {
  // 诊断复核用参数：生产中始终使用常量默认值，不在 UI 或设置里暴露。
  const extensionMin = policies.extensionMinM ?? EXTENSION_MIN_M;
  /** 延长段自身是否受最小墙长约束：诊断复核用的旧口径（Issue #24 之前）为 true，生产运行为 false。 */
  const lengthApplies = policies.pieceLengthAppliesToExtension ?? false;
  const reportPolicies = { ...policies, extensionMinM: extensionMin, pieceLengthAppliesToExtension: lengthApplies };
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
    notes.push(`墙段 #${piece.sourceIndex} 的 ${end} 端把短段拉长后仍不足 ${MIN_PIECE_M} m，已回退为悬空端（延伸不足）。`);
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
    const aligned = endpointAt(p, axisOf(segments[j]!));
    // 对方端点横向错位须落在贴合容差内；超出说明不是同一墙轴。
    if (distance(aligned, p) > SNAP_TOLERANCE_M || insideWall(p, [i, j]) || distance(p, source) > MAX_EXTENSION_M) return undefined;
    // 延长段口径（Issue #24）：连接两段已确认墙体的延长段不受最小墙长 MIN_PIECE_M 拦截，只要求延长段本身
    // 不短于 EXTENSION_MIN_M（短于贴合容差的增量两端无法区分"已确认墙体"与端点抖动）。
    // 旧口径（legacyExtensionLengthGate，仅诊断对照）在此额外要求延长后的整段仍 ≥ MIN_PIECE_M。
    const extended = setEndpoint(own, end, p), extendedShort = distance(extended.a, extended.b) < MIN_PIECE_M;
    if (extendedShort && !lengthApplies && distance(p, source) < extensionMin) return undefined;
    if (extendedShort && lengthApplies) return "reverted";
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

  // 3c) 自由端聚类吸附（Issue #27，修复 g）：上面各步判完之后仍为度 1 的自由端，如果它的最近邻是另一个自由端、
  //     端点直线距离 ≤ FREE_END_SNAP_M、两点之间没有别的墙（距离就是最短缺口，不跨墙也不跨洞口），就把两端吸附成
  //     同一个节点。落点优先取两墙轴的延长线交点（墙轴方向不变、不拉斜线），两轴平行时取两端点按证据格数加权平均。
  //     吸附只改端点坐标，不改墙轴方向的拟合来源记录（sources / rmsM / support 原样保留）。
  //     吸附后若围出 < SNAP_MIN_FACE_M2 的退化面，回退这次吸附并记录。
  const snapRadius = policies.freeEndSnapM ?? FREE_END_SNAP_M;
  const snaps: FreeEndSnap[] = [];
  /** 已成功吸附的条目（`snaps` 里只保留一次判定：跳过项逐对一条，吸附项每对一条）。 */
  const joins: FreeEndSnap[] = [];
  /** 已判定过的自由端，避免同一条在后续扫描里重复出清单。 */
  const snapped = new Set<string>();
  const snapKey = (i: number, end: "a" | "b") => `${i}:${end}`;
  /** 当前的墙网节点（与第 4 步同一口径），只用于判定"谁还是度 1 自由端"。 */
  const nodeOf = (p: P, nodes: WallNode[]) => {
    const found = nodes.findIndex(n => distance(n.p, p) <= VERTEX_MERGE_M);
    if (found >= 0) return found;
    nodes.push({ id: nodes.length, p: pointOn(p), degree: 0, walls: [] });
    return nodes.length - 1;
  };
  /** 墙网节点与每条墙段两端的节点号；`into` 传入时复用同一份节点表（判定用，不改几何）。 */
  const topology = (into?: WallNode[]) => {
    const nodes = into ?? [];
    const pairs = segments.map(s => [nodeOf(s.a, nodes), nodeOf(s.b, nodes)] as const);
    for (const n of nodes) { n.degree = 0; n.walls = []; }
    pairs.forEach(([a, b], i) => {
      const source = segments[i]!.sourceIndex;
      // 度数按墙段计：一段墙接在节点上就是一个度，与第 4 步的节点口径一致。
      nodes[a]!.degree++; nodes[b]!.degree++;
      for (const n of new Set([a, b])) if (!nodes[n]!.walls.includes(source)) nodes[n]!.walls.push(source);
    });
    return { nodes, pairs };
  };
  /**
   * 自由端的最近邻自由端。距离是两端点的直线距离，也是这一对之间的最短缺口：若两点间还隔着别的墙
   * （端点离第三个墙段更近）就不算吸附对象——不跨墙、不跨洞口连接。
   */
  const nearestFreeEnd = (i: number, end: "a" | "b", nodes: ReadonlyArray<WallNode>, pairs: ReadonlyArray<readonly [number, number]>) => {
    const p = endpointOf(segments[i]!, end);
    let best: { j: number; end: "a" | "b"; d: number } | undefined;
    segments.forEach((other, j) => {
      if (j === i) return;
      for (const o of ["a", "b"] as const) {
        if (nodes[pairs[j]![o === "a" ? 0 : 1]]!.degree !== 1) continue;
        const d = distance(p, endpointOf(other, o));
        if (!best || d < best.d - 1e-9) best = { j, end: o, d };
      }
    });
    return best;
  };
  /**
   * 自由端 p 离第三个墙段**自身**的最近距离（丁字接头、子段端点都算）；中间有墙时吸附就不成立。
   * 只量到墙段本身，不量到它的无限延长线：同一条墙轴上更远处的另一段墙不算"中间有墙"，
   * 否则同一道墙上相邻的两处缺口永远无法吸附。
   */
  const nearestOtherWall = (i: number, k: number, p: P) => {
    let gap = Infinity;
    segments.forEach((other, j) => {
      if (j === i || j === k) return;
      const axis = axisOf(other), { t } = project(axis, p);
      const q = t < 0 ? other.a : t > 1 ? other.b : at(other, t);
      gap = Math.min(gap, distance(p, q));
    });
    return gap;
  };
  if (snapRadius > 0) {
    for (let guard = 0; guard < 64; guard++) {
      const { nodes, pairs } = topology([]);
      // 度 1 判定要读节点自身的度数：`pairs` 给的是节点号，不是度数。
      const free = segments.flatMap((_, i) => (["a", "b"] as const).map(end => ({ i, end }))).filter(e => nodes[pairs[e.i]![e.end === "a" ? 0 : 1]]!.degree === 1 && !snapped.has(snapKey(e.i, e.end)));
      let acted = false;
      for (const { i, end } of free) {
        const own = segments[i]!, p = endpointOf(own, end);
        const best = nearestFreeEnd(i, end, nodes, pairs);
        const record = (outcome: "snapped" | "skipped", extra: { reason?: SnapSkipReason; landing?: P; landingSource?: FreeEndSnap["landingSource"]; j?: number; other?: "a" | "b"; q?: P }) => ({
          segments: [own.sourceIndex, extra.j === undefined ? -1 : segments[extra.j]!.sourceIndex] as [number, number],
          ends: [end, extra.other ?? "a"] as ["a" | "b", "a" | "b"], from: [pointOn(p), pointOn(extra.q ?? p)] as [P, P],
          distanceM: Math.round(distance(p, extra.q ?? p) * 1000) / 1000,
          landing: pointOn(extra.landing ?? [(p[0] + (extra.q?.[0] ?? p[0])) / 2, (p[1] + (extra.q?.[1] ?? p[1])) / 2]),
          landingSource: extra.landingSource ?? "evidence-weighted", evidence: [own.support, extra.j === undefined ? 0 : segments[extra.j]!.support] as [number, number],
          lengthAfterM: [0, 0] as [number, number], outcome, reason: extra.reason,
          sources: [own.sources, extra.j === undefined ? undefined : segments[extra.j]!.sources] as [number[] | undefined, number[] | undefined],
        });
        if (!best) { snapped.add(snapKey(i, end)); snaps.push(record("skipped", { reason: "not-nearest" })); continue; }
        const far = segments[best.j]!, q = endpointOf(far, best.end);
        // 互为最近邻才算一对：只单向最近的端点不吸附，避免把第三个端点漏在半径边界上。
        const mirror = nearestFreeEnd(best.j, best.end, nodes, pairs);
        if (!mirror || mirror.j !== i || mirror.end !== end) { snapped.add(snapKey(i, end)); snaps.push(record("skipped", { reason: "not-nearest", j: best.j, other: best.end, q })); continue; }
        // 每个端点只判定一次：同一对的镜像顺序不再重复判定。
        if (snapped.has(snapKey(best.j, best.end))) continue;
        snapped.add(snapKey(i, end)); snapped.add(snapKey(best.j, best.end));
        const base = { j: best.j, other: best.end, q };
        if (best.j === i) { snaps.push(record("skipped", { ...base, reason: "same-wall" })); continue; }
        if (best.d > snapRadius + 1e-9) { snaps.push(record("skipped", { ...base, reason: "beyond-radius", landing: q })); continue; }
        // 中间隔着别的墙（例如同一原墙段被贴合切分出的另一子段）：不跨墙吸附。
        if (nearestOtherWall(i, best.j, p) + 1e-6 < best.d || nearestOtherWall(best.j, i, q) + 1e-6 < best.d) { snaps.push(record("skipped", { ...base, reason: "another-wall", landing: q })); continue; }
        // 落点：两墙轴延长线交点（沿各自墙轴滑动，不拉斜线）；平行时取端点按证据格数加权平均。
        // 近共线的一对（夹角几分之一度）交点会落在几十米外，沿轴滑过去等于把两段墙都拉长几十米，
        // 那不是"吸附端点"而是"重新造墙"：交点距离超出吸附半径时按平行处理。
        const ownAnchor = anchorOf(own, end), farAnchor = anchorOf(far, best.end);
        const ownAxis = axisFrom(ownAnchor, p), farAxis = axisFrom(farAnchor, q);
        const hitAt = intersectionOf(ownAxis, farAxis);
        const hit = hitAt && distance(hitAt, p) <= snapRadius && distance(hitAt, q) <= snapRadius ? hitAt : undefined;
        // 没有可用交点时退到端点按证据格数加权平均，再把这个落点投到证据较多的那一方的墙轴上：
        // 平均点落在两条不平行的轴之间，直接用它会把两段墙的方向各扭一点（等于改了拟合来源），
        // 投轴后只有证据较少的一方沿自身轴线横向对齐，墙轴方向仍来自各自拟合。
        const weighted = pointOn([(p[0] * own.support + q[0] * far.support) / (own.support + far.support), (p[1] * own.support + q[1] * far.support) / (own.support + far.support)]);
        const stronger = own.support >= far.support ? ownAxis : farAxis;
        const landing = hit ?? endpointAt(weighted, stronger);
        const entry = record("snapped", { ...base, landing, landingSource: hit ? "intersection" : "evidence-weighted" });
        // 退化面联动检查：吸附后任一段成了自环或围出 < SNAP_MIN_FACE_M2 的窄条就回退（不改几何）。
        const next = segments.map((s, k) => (k === i ? setEndpoint(s, end, landing) : k === best.j ? setEndpoint(s, best.end, landing) : s));
        if (formsDegenerateFace(next, SNAP_MIN_FACE_M2)) { snaps.push({ ...entry, outcome: "skipped", reason: "degenerate-face" }); reverted++; continue; }
        segments[i] = setEndpoint(own, end, landing);
        segments[best.j] = setEndpoint(far, best.end, landing);
        touched.add(`${own.sourceIndex}`); touched.add(`${segments[best.j]!.sourceIndex}`);
        moved.add(`${own.sourceIndex}:${end}`); moved.add(`${segments[best.j]!.sourceIndex}:${best.end}`);
        // 与这两个端点共点、且本轮尚未被连接动过的其它墙端随之一并对齐（同一顶点上的第三面墙）。
        for (let k = 0; k < segments.length; k++) {
          if (k === i || k === best.j || touched.has(`${segments[k]!.sourceIndex}`)) continue;
          for (const o of ["a", "b"] as const) {
            const atEnd = endpointOf(segments[k]!, o);
            if (distance(atEnd, p) <= VERTEX_MERGE_M || distance(atEnd, q) <= VERTEX_MERGE_M) segments[k] = setEndpoint(segments[k]!, o, landing);
          }
        }
        const done = { ...entry, lengthAfterM: [Math.round(distance(segments[i]!.a, segments[i]!.b) * 1000) / 1000, Math.round(distance(segments[best.j]!.a, segments[best.j]!.b) * 1000) / 1000] as [number, number] };
        joins.push(done); snaps.push(done);
        acted = true;
        break;
      }
      if (!acted) break;
    }
  }

  // 4) 端点合并成墙网节点（半径 VERTEX_MERGE_M），记录每个节点连接的墙。
  const { nodes, pairs: ends } = topology();

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
      // 到这里只剩"缺口在延长上限内、两段同轴、但延长没有成立"。生产口径下（延长段不受最小墙长拦截）
      // 只可能是"延长段短于 EXTENSION_MIN_M"或"端头已被别的墙接住"，都不是"延长段不足最小墙长"，
      // 因此按同一清单的既有原因记 `no-alignment`；旧口径对照时仍按最小墙长口径写 `extension-too-short`。
      unclosed.push(lengthApplies
        ? { segmentIndex: i, end, pointM: p, reason: "extension-too-short", targetSegmentIndex: best.j, gapM, note: `缺口 ${gap.toFixed(2)} m 在延长上限内，但延伸后不足最小墙长 ${MIN_PIECE_M} m，保留为悬空端。` }
        : { segmentIndex: i, end, pointM: p, reason: "no-alignment", targetSegmentIndex: best.j, gapM, note: `缺口 ${gap.toFixed(2)} m 在延长上限内、两段同轴，但延长未成立（延长段须不短于 ${EXTENSION_MIN_M} m，端头未被其它墙接住）：保持断开，计入未闭合问题。` });
    }
  });
  if (splits) notes.push(`${insertedNodes} 次在既有墙上插入节点，墙段由 ${input.length} 条切分为 ${segments.length} 条，节点与边保留原墙候选段号。`);
  if (snaps.length) notes.push(`自由端聚类吸附（半径 ${snapRadius} m）：${joins.length} 对自由端吸附成同一节点，${snaps.length - joins.length} 对判定后保持断开（原因见吸附清单）。`);

  const join: JoinCounts = {
    endpoints: segments.length * 2, connected: segments.length * 2 - dangling, opening, unclosed: tooLarge, dangling,
    joined, extensions, insertedNodes, splits, revertedExtensions: reverted,
    corners: stillOpen.filter(c => c.outcome === "joined").length, cornerCandidates: stillOpen.length,
    snaps: joins.length * 2, revertedSnaps: reverted,
  };
  const openCorners = stillOpen.filter(c => c.outcome === "skipped").length;
  if (stillOpen.length) notes.push(`角部断点 ${stillOpen.length} 处：${stillOpen.length - openCorners} 处收敛到延长线交点，${openCorners} 处保持断开（原因见角部清单）。`);
  return { segments, nodes, edges: segments.length, join, unclosed, corners: stillOpen, snaps, notes, policies: reportPolicies };
}
