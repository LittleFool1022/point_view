import {
  activeWalls, polygonArea, validateBuilding, wallLength,
  type BuildingModel, type ClosureReport, type ReviewAction, type ReviewActionKind, type ReviewPolicy, type UnclosedIssue,
  type Vec2, type Wall, type WallRemoval, type WallSource,
} from "./building";
import { levelClosure, levelRoomsAndIssues, manualEvidence, ROOM_NODE_TOLERANCE_M } from "./buildingOps";

/**
 * 墙网人工复核编辑（模型层）：按未闭合清单逐项处置——连接两端、补墙、删伪影、确认洞口。
 * 全部处置带人工来源标记并写入处置记录（未闭合项、动作、操作者=人工、时间、前后房间数）；
 * 人工结果永不回写为自动拟合结果，房间始终由墙网几何重算，不从处置结论直接“造”房间。
 *
 * 重新拟合策略（`reviewPolicy` = `rehang` | `block-on-fit`；缺省按 `block-on-fit`）：
 * - `block-on-fit`：拟合前逐条列出会失效的人工墙段与处置记录并阻断，不静默丢弃。
 * - `rehang`：保留人工墙段与处置记录，按墙网节点容差重新挂接到新墙网。
 */

export type ReviewActionRequest =
  | { kind: "connect"; issueId: string }
  | { kind: "add-wall"; levelId: string; a: Vec2; b: Vec2; issueId?: string; name?: string }
  | { kind: "remove-wall"; wallId: string; reason: string; issueId?: string }
  | { kind: "resolved-opening"; issueId: string };

/** 单步撤销帧：只保存撤销所需的前值，不整份拷贝模型。 */
export type UndoFrame =
  | { kind: "remove-wall"; wallId: string }
  | { kind: "resolved-opening"; issueId: string }
  | { kind: "connect"; issueId: string; walls: Array<[string, Wall]> }
  | { kind: "add-wall"; wallId: string };

export interface ReviewStep { model: BuildingModel; action: ReviewAction; undo: UndoFrame }

/** 单步撤销栈：每种处置都可回退（房间随墙网几何重算回原状）。 */
export class ReviewUndoStack {
  private frames: UndoFrame[] = [];
  get depth() { return this.frames.length; }
  push(frame: UndoFrame) { this.frames.push(frame); return this; }
  clear() { this.frames = []; }
  undo(m: BuildingModel): BuildingModel | undefined { const frame = this.frames.pop(); return frame ? applyUndo(m, frame) : undefined; }
}

export interface ReviewPlan { ok: boolean; wallIds: string[]; levelIds: string[]; actionIds: string[]; reasons: string[] }
export interface RehangResult {
  model: BuildingModel;
  /** 新拟合没有同等墙段、重新挂接保留下来的人工墙段。 */
  rehung: string[];
  /** 新拟合已产生同等墙段（不重复添加）的人工墙段。 */
  covered: string[];
  notes: string[];
}

/** 挂接容差：同一墙段的端点空间差异上限（不依赖端点顺序）。 */
export const REHANG_TOLERANCE_M = .25;
export const REVIEW_POLICY_DEFAULT: ReviewPolicy = "block-on-fit";
/** 人工连接/补墙的端点吸附距离：落在墙网既有交点/吸附落点口径（节点合并容差之外 0.25 m 内视为落到该墙轴）。 */
export const SNAP_REACH_M = .25;

const now = () => new Date().toISOString();
export const levelOf = (m: BuildingModel, levelId: string) => m.levels.find(l => l.id === levelId);
export const activeIssue = (m: BuildingModel, issueId: string) =>
  (m.unclosedIssues ?? []).find(i => i.id === issueId && !i.resolution && !i.closedBy);
/** 未闭合清单：人工确认为洞口或已由人工连接闭合的项不再计入。 */
export const openUnclosedIssues = (m: BuildingModel, levelId?: string) =>
  (m.unclosedIssues ?? []).filter(i => !i.resolution && !i.closedBy && (levelId === undefined || i.levelId === levelId));
export const roomCount = (m: BuildingModel, levelId?: string) => m.rooms.filter(r => levelId === undefined || r.levelId === levelId).length;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sameAxis = (a: [Vec2, Vec2], b: [Vec2, Vec2]) => (dist(a[0], b[0]) <= REHANG_TOLERANCE_M && dist(a[1], b[1]) <= REHANG_TOLERANCE_M)
  || (dist(a[0], b[1]) <= REHANG_TOLERANCE_M && dist(a[1], b[0]) <= REHANG_TOLERANCE_M);

/**
 * 处置后重算本层墙网结果：房间与未闭合清单都按更新后的墙网几何重算，并保留人工标记
 * （确认洞口、已连接）与问题编号，使处置前后的差量可追溯；其它楼层的结果保持不变。
 */
function recompute(m: BuildingModel, levelId: string): BuildingModel {
  const closure = levelRoomsAndIssues(m, levelId), previous = (m.unclosedIssues ?? []).filter(i => i.levelId === levelId);
  const used = new Set<string>();
  const kept = closure.unclosedIssues.map(issue => {
    const old = previous.find(p => !used.has(p.id) && (Math.hypot(p.pointM[0] - issue.pointM[0], p.pointM[1] - issue.pointM[1]) <= GAP_PAIR_M || p.wallIds.some(id => issue.wallIds.includes(id))));
    if (old) used.add(old.id);
    // 重算出的同一处未闭合项沿用原编号与人工标记；其余按新问题编号保留。
    return { ...issue, id: old?.id ?? issue.id, ...(old?.resolution ? { resolution: old.resolution } : {}), ...(old?.closedBy ? { closedBy: old.closedBy } : {}) };
  });
  return { ...m, rooms: [...m.rooms.filter(r => r.levelId !== levelId), ...closure.rooms], unclosedIssues: [...(m.unclosedIssues ?? []).filter(i => i.levelId !== levelId), ...kept] };
}

/** 重算后把本次处置产生的墙段（新建/修改/删除）编号回填到处置记录，使撤销可按处置精确定位。 */
function wallsOfAction(walls: Wall[], actionId: string): string[] {
  return walls.filter(w => w.source?.actionId === actionId || w.removed?.actionId === actionId).map(w => w.id);
}

/**
 * 同一条缝会在两端各报一条：墙段对相同、缺口两端互为端点（按墙段 ID 判定，补墙后同一墙段对仍然成立）。
 * 处置其中一条时另一条按同一条缝一并处置；两端相距超过一个墙厚时按两条独立缺口对待。
 */
const GAP_PAIR_M = .5;
const endpointOf = (m: BuildingModel, wallId: string, p: Vec2) => m.walls.find(w => w.id === wallId)?.axisM.some(e => Math.hypot(e[0] - p[0], e[1] - p[1]) <= GAP_PAIR_M) ?? false;
function isSameGap(m: BuildingModel, a: UnclosedIssue, b: UnclosedIssue) {
  if (a.levelId !== b.levelId || a === b || b.resolution || b.closedBy) return false;
  if (a.wallIds.slice().sort().join() !== b.wallIds.slice().sort().join() || !b.toM) return false;
  const shared = a.wallIds.some(id => endpointOf(m, id, a.pointM) && endpointOf(m, id, b.pointM));
  const mirrored = a.wallIds.some(id => endpointOf(m, id, a.pointM) && endpointOf(m, id, b.toM!));
  const close = Math.hypot(a.pointM[0] - b.pointM[0], a.pointM[1] - b.pointM[1]) <= GAP_PAIR_M;
  return close && (shared || mirrored);
}
/** 墙段被人工删除后，其相关未闭合项按留痕折叠：涉及墙段全部删除的项不再计入未闭合。 */
function dropIssues(m: BuildingModel, wallId: string, actionId: string): UnclosedIssue[] {
  const active = (issue: UnclosedIssue, exclude: string) => activeWalls(m).some(w => w.id !== exclude && issue.wallIds.includes(w.id));
  return (m.unclosedIssues ?? []).map(i => i.wallIds.includes(wallId) && !active(i, wallId) && !i.resolution ? { ...i, closedBy: i.closedBy ?? { actionId, at: now() } } : i);
}

/** 处置后模型必须通过同一套核验（未复核/未闭合/人工来源类提示除外）。 */
const NON_FATAL = ["UNREVIEWED", "UNCLOSED", "UNCLOSED_TRACE", "RESOLVED_OPENING", "CLOSED_BY_REVIEW", "MANUAL_WALL", "WALL_REMOVED"];
function assertValid(m: BuildingModel) {
  const fatal = validateBuilding(m).find(i => !NON_FATAL.includes(i.code));
  if (fatal) throw Error(fatal.message);
}

function action(kind: ReviewActionKind, m: BuildingModel, before: BuildingModel, levelId: string, wallIds: string[], note: string, issueId?: string): ReviewAction {
  return { id: crypto.randomUUID(), ...(issueId ? { issueId } : {}), action: kind, operator: "manual", at: now(), source: "review", levelId, roomsBefore: roomCount(before, levelId), roomsAfter: roomCount(m, levelId), wallIds, note };
}
/** 人工来源标记：人工新增与人工修改的墙段都与自动拟合来源可区分。 */
const manualSource = (actionId: string, issueId?: string, origin: "manual" | "fit" = "manual"): WallSource => ({ kind: "manual", origin, at: now(), ...(issueId ? { issueId } : {}), actionId });

/** 点到墙轴所在直线的有符号垂距。 */
function perp(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
  return ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length;
}
function project(p: Vec2, axis: [Vec2, Vec2]): Vec2 {
  const [a, b] = axis, dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  if (length < 1e-9) return a;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (length * length)));
  return [a[0] + dx * t, a[1] + dy * t];
}
/**
 * 连接落点：取距离 ≤0.25 m 的其它墙段投影点（墙网既有交点/吸附落点口径）；
 * 节点容差内且更近时取该墙段端点（同一交点合并）。缺口另一侧就在自身墙段延长线上，自身不参与吸附。
 */
function snapPoint(p: Vec2, walls: Wall[], own: string[]): Vec2 | undefined {
  let best: { point: Vec2; gap: number } | undefined;
  const consider = (point: Vec2, gap: number) => { if (gap <= SNAP_REACH_M && (!best || gap < best.gap - 1e-12)) best = { point, gap }; };
  for (const w of walls) {
    if (own.includes(w.id)) continue;
    for (const end of w.axisM) consider(end, dist(p, end));
    consider(project(p, w.axisM), dist(p, project(p, w.axisM)));
  }
  // 容差内的既有节点与更远的墙轴投影点都取同一落点；容差只作记录口径，不做第二种几何。
  const chosen = best as { point: Vec2; gap: number } | undefined;
  return chosen ? chosen.point : undefined;
}

/**
 * 处置 1：连接两端。把未闭合项两端落到墙网既有交点/吸附落点口径，更新涉及墙段几何，房间随即重算：
 * 1. 缺口另一端就在宿主墙段自身端点上，且该端点贴着同一墙轴（3 cm 级贴合缺口）：按节点合并，
 *    把相邻墙段端点对齐到缺口位置，不生成连接墙轴；
 * 2. 缺口另一端落在墙网吸附范围内（墙轴投影点/既有节点）：只把问题端所在墙段的端点吸附过去；
 * 3. 已有覆盖该缺口的人工墙段（补墙后再连接）：两端取该人工墙段端点，只吸附其两侧墙段；
 * 4. 其余情况：问题端所在墙段吸附到落点，沿缺口生成一段 `source=manual` 的连接墙轴。
 */
function connectEnds(m: BuildingModel, issue: UnclosedIssue): { model: BuildingModel; actionRecord: ReviewAction } {
  if (!issue.toM) throw Error("该未闭合项缺少目标落点，请改用补墙处置。");
  const hosts = activeWalls(m, issue.levelId).filter(w => issue.wallIds.includes(w.id));
  if (!hosts.length) throw Error("未闭合项涉及的墙段已不存在，无法连接。");
  const owning = hosts[0]!, from = issue.pointM, aim = issue.toM!, actionId = crypto.randomUUID();
  const snapped = snapPoint(aim, hosts, []);
  const ending = hosts.flatMap(w => w.axisM.map(end => ({ w, end })));
  // 缺口另一端落在某宿主墙段端点附近，且该端点在缺口方向上（不是问题端自身）：
  // 同一墙段的另一端、或同一条墙轴上的相邻墙段端点（3 cm 级贴合缺口）都按节点合并处理。
  const aligned = (end: Vec2) => Math.abs(perp(end, owning.axisM[0], owning.axisM[1])) <= owning.thicknessM * 4;
  const butt = ending.filter(({ end }) => dist(end, aim) <= SNAP_REACH_M && dist(end, from) > ROOM_NODE_TOLERANCE_M && aligned(end))
    .sort((a, b) => dist(a.end, aim) - dist(b.end, aim))[0];
  const spanning = activeWalls(m, issue.levelId).find(w => w.source?.kind === "manual" && w.source.issueId === issue.id && !issue.wallIds.includes(w.id));
  // 贴合缺口（两端相距不超过一个墙厚）按节点合并；更宽的缺口按吸附落点连接或补连接墙轴。
  const merge = !!butt && dist(from, butt.end) <= owning.thicknessM;
  const node: Vec2 = snapped ?? from;
  const to = spanning ? [...spanning.axisM].sort((a, b) => dist(a, from) - dist(b, from))[0]! : node;
  if (!butt && dist(from, to) < 1e-6) throw Error("连接两端距离为零，无需连接。");
  const bridge = !merge && dist(from, to) > ROOM_NODE_TOLERANCE_M;
  let walls = m.walls.map(w => ({ ...w }));
  const touched = new Map<string, Wall>();
  const move = (w: Wall, edit: (axis: [Vec2, Vec2]) => [Vec2, Vec2]) => {
    const next = edit(w.axisM);
    if (dist(next[0], w.axisM[0]) < 1e-9 && dist(next[1], w.axisM[1]) < 1e-9) return;
    if (dist(next[0], next[1]) < .001) throw Error("连接会让墙段长度归零，请改用补墙处置。");
    touched.set(w.id, { ...w, axisM: next, evidence: { ...w.evidence, kind: "manual", confirmed: false }, source: manualSource(actionId, issue.id) });
  };
  if (merge) {
    // 节点合并：缺口两侧墙段的端点合并到同一节点（垂直相接取交点，同轴相接取缺口位置），不留接缝。
    const targets = hosts.filter(w => w.axisM.some(end => dist(end, from) <= SNAP_REACH_M || dist(end, butt!.end) <= SNAP_REACH_M));
    for (const w of targets) move(w, axis => axis.map((p, i) => {
      if (dist(p, from) <= SNAP_REACH_M) return node;
      if (dist(p, butt!.end) <= SNAP_REACH_M) return node;
      return axis[i]!;
    }) as [Vec2, Vec2]);
  } else {
    const targets = spanning ? hosts.filter(w => w.axisM.some(e => dist(e, from) <= SNAP_REACH_M || dist(e, to) <= SNAP_REACH_M)) : [owning];
    for (const w of targets) move(w, axis => {
      const near = [0, 1].filter(i => dist(axis[i]!, to) <= SNAP_REACH_M).sort((a, b) => dist(axis[a]!, to) - dist(axis[b]!, to))[0];
      return near === undefined ? axis : near === 0 ? [to, axis[1]] : [axis[0], to];
    });
  }
  if (merge && !touched.size) throw Error("缺口端点已对齐，无需连接。");
  walls = walls.map(w => touched.get(w.id) ?? w);
  const wallIds = [...touched.keys()];
  if (bridge) {
    const existing = spanning ?? activeWalls(m, issue.levelId).find(w => w.source?.kind === "manual" && sameAxis(w.axisM, [from, to]));
    if (existing) wallIds.push(existing.id);
    else {
      const id = crypto.randomUUID();
      walls = [...walls, { id, name: "连接墙 · 人工", levelId: issue.levelId, axisM: [from, to], heightM: owning.heightM, thicknessM: owning.thicknessM, evidence: manualEvidence(m), source: manualSource(actionId, issue.id) }];
      wallIds.push(id);
    }
  }
  // 连接后该缺口由墙网几何消解，未闭合清单按重算结果缩小；处置记录保留原问题编号供追溯。
  const next = recompute({ ...m, walls }, issue.levelId);
  const note = bridge
    ? `按墙网吸附落点连接两端，补足缺口 ${dist(from, to).toFixed(3)} m 的连接墙轴；人工连接不作自动结果。`
    : `两端落在同一墙网交点（缺口 ${(issue.gapM ?? 0).toFixed(3)} m），端点吸附到既有节点；人工修改墙段不作自动结果。`;
  const record: ReviewAction = { ...action("connect", next, m, issue.levelId, wallIds, note, issue.id), id: actionId, wallIds: wallsOfAction(next.walls, actionId) };
  return { model: { ...next, reviewActions: [...(m.reviewActions ?? []), record] }, actionRecord: record };
}

/** 处置 2：补墙——两点新增一段 `source=manual` 墙（含处置时间与关联未闭合项），进入墙网与房间重算。 */
function addWall(m: BuildingModel, request: Extract<ReviewActionRequest, { kind: "add-wall" }>): { model: BuildingModel; actionRecord: ReviewAction } {
  const level = levelOf(m, request.levelId);
  if (!level) throw Error("补墙楼层不存在。");
  if (![...request.a, ...request.b].every(Number.isFinite) || dist(request.a, request.b) < .001) throw Error("补墙两点必须有效且不重合。");
  if (request.issueId && !activeIssue(m, request.issueId)) throw Error("未闭合项不存在或已处置。");
  const actionId = crypto.randomUUID(), levelWalls = activeWalls(m, request.levelId);
  const a = snapPoint(request.a, levelWalls, []) ?? request.a, b = snapPoint(request.b, levelWalls, []) ?? request.b;
  const wall: Wall = {
    id: crypto.randomUUID(), name: request.name ?? `补墙 · 人工 ${levelWalls.length + 1}`, levelId: request.levelId, axisM: [a, b],
    heightM: levelWalls[0]?.heightM ?? 3, thicknessM: levelWalls[0]?.thicknessM ?? .2, evidence: manualEvidence(m), source: manualSource(actionId, request.issueId, "manual"),
  };
  // 补墙不改变未闭合项的几何判定：是否闭合由后续连接两端/确认洞口处置决定，不静默关闭清单项。
  const covered = m.unclosedIssues ?? [];
  const recalculated = recompute({ ...m, walls: [...m.walls, wall], unclosedIssues: covered }, request.levelId);
  const next = recalculated;
  const record: ReviewAction = { ...action("add-wall", next, m, request.levelId, [wall.id], `人工补墙 ${wallLength(wall).toFixed(3)} m，来源=manual，不参与自动拟合与自动尺寸核验。`, request.issueId), id: actionId };
  return { model: { ...next, reviewActions: [...(m.reviewActions ?? []), record] }, actionRecord: record };
}

/** 处置 3：删伪影——指定墙段软删除（保留被删段来源与删除原因），不参与墙网与房间；可撤销恢复。 */
function removeWall(m: BuildingModel, request: Extract<ReviewActionRequest, { kind: "remove-wall" }>): { model: BuildingModel; actionRecord: ReviewAction } {
  const wall = m.walls.find(w => w.id === request.wallId);
  if (!wall || wall.removed) throw Error("待删除墙段不存在或已删除。");
  const reason = request.reason.trim();
  if (!reason) throw Error("删除墙段须填写原因。");
  const actionId = crypto.randomUUID(), at = now();
  const removal: WallRemoval = { at, operator: "manual", reason, actionId, ...(request.issueId ? { issueId: request.issueId } : {}), wall: structuredClone(wall) };
  const recalculated = recompute({ ...m, walls: m.walls.map(w => w.id === wall.id ? { ...w, removed: removal } : w), unclosedIssues: dropIssues(m, wall.id, actionId) }, wall.levelId);
  const next = recalculated;
  const record: ReviewAction = { ...action("remove-wall", next, m, wall.levelId, [wall.id], `人工删除（伪影）：${reason}；被删段来源 ${wall.source?.kind ?? wall.evidence.kind}，留痕保留可撤销。`, request.issueId), id: actionId };
  return { model: { ...next, reviewActions: [...(m.reviewActions ?? []), record] }, actionRecord: record };
}

/** 处置 4：确认洞口——标记 `resolved-opening`，不再计入未闭合数，记录保留并在交付检查中可见，不据此生成房间。 */
function resolveOpening(m: BuildingModel, issueId: string): { model: BuildingModel; actionRecord: ReviewAction } {
  const issue = activeIssue(m, issueId);
  if (!issue) throw Error("未闭合项不存在或已处置。");
  const actionId = crypto.randomUUID();
  // 先按墙网几何重算，再把同一处未闭合项标记为已确认洞口：记录保留，不再计入未闭合，不据此生成房间。
  const recalculated = recompute(m, issue.levelId);
  const next: BuildingModel = { ...recalculated, unclosedIssues: (recalculated.unclosedIssues ?? []).map(i => isSameGap(m, i, issue) || i.id === issueId ? { ...i, resolution: "resolved-opening" as const } : i) };
  if (!(next.unclosedIssues ?? []).some(i => i.resolution === "resolved-opening")) throw Error("未闭合项不在当前墙网清单中，请先重新生成候选。");
  const record: ReviewAction = { ...action("resolved-opening", next, m, issue.levelId, issue.wallIds, `人工确认洞口：${issue.reason}；不计入未闭合，记录保留，不据此生成房间。`, issueId), id: actionId };
  return { model: { ...next, reviewActions: [...(m.reviewActions ?? []), record] }, actionRecord: record };
}

/** 执行一项人工处置；返回新模型、处置记录与单步撤销帧（原模型不变）。 */
export function applyReviewAction(m: BuildingModel, request: ReviewActionRequest): ReviewStep {
  if (request.kind === "connect") {
    const issue = activeIssue(m, request.issueId);
    if (!issue) throw Error("未闭合项不存在或已处置。");
    // 撤销帧覆盖该未闭合项涉及的墙段（含补墙后同轴的人工段），连接改动可完整回退。
    const related = (w: Wall) => issue.wallIds.includes(w.id) || (w.levelId === issue.levelId && w.source?.issueId === issue.id);
    const before = activeWalls(m, issue.levelId).filter(related).map(w => [w.id, structuredClone(w)] as [string, Wall]);
    const { model, actionRecord } = connectEnds(m, issue);
    return { model, action: actionRecord, undo: { kind: "connect", issueId: issue.id, walls: before } };
  }
  if (request.kind === "resolved-opening") {
    const { model, actionRecord } = resolveOpening(m, request.issueId);
    return { model, action: actionRecord, undo: { kind: "resolved-opening", issueId: request.issueId } };
  }
  if (request.kind === "add-wall") {
    const { model, actionRecord } = addWall(m, request);
    return { model, action: actionRecord, undo: { kind: "add-wall", wallId: actionRecord.wallIds[0]! } };
  }
  const { model, actionRecord } = removeWall(m, request);
  return { model, action: actionRecord, undo: { kind: "remove-wall", wallId: request.wallId } };
}

/** 单步撤销：恢复处置前的墙段几何、存留状态与未闭合项状态，移除该处置记录；房间随墙网几何重算回原状。 */
export function applyUndo(m: BuildingModel, frame: UndoFrame): BuildingModel {
  const actions = m.reviewActions ?? [];
  const without = (id?: string) => actions.filter(a => a.id !== id);
  let next: BuildingModel;
  if (frame.kind === "add-wall") {
    const wall = m.walls.find(w => w.id === frame.wallId);
    if (!wall) throw Error("撤销目标墙段不存在。");
    next = { ...m, walls: m.walls.filter(w => w.id !== frame.wallId), reviewActions: without(wall.source?.actionId) };
  } else if (frame.kind === "remove-wall") {
    const wall = m.walls.find(w => w.id === frame.wallId);
    if (!wall?.removed) throw Error("撤销目标墙段未被删除。");
    next = { ...m, walls: m.walls.map(w => w.id === frame.wallId ? drop(w, "removed") : w), reviewActions: without(wall.removed.actionId) };
  } else if (frame.kind === "resolved-opening") {
    const issue = (m.unclosedIssues ?? []).find(i => i.id === frame.issueId);
    if (!issue?.resolution) throw Error("撤销目标未闭合项未被确认洞口。");
    const id = [...actions].reverse().find(a => a.issueId === frame.issueId && a.action === "resolved-opening")?.id;
    next = { ...m, unclosedIssues: m.unclosedIssues!.map(i => i.id === frame.issueId ? drop(i, "resolution") : i), reviewActions: without(id) };
  } else {
    const id = [...actions].reverse().find(a => a.issueId === frame.issueId && a.action === "connect")?.id;
    const kept = new Set(frame.walls.map(([wallId]) => wallId));
    next = {
      ...m,
      walls: m.walls.filter(w => !(w.source?.actionId === id && !kept.has(w.id))).map(w => { const old = frame.walls.find(([wallId]) => wallId === w.id); return old ? old[1] : w; }),
      unclosedIssues: (m.unclosedIssues ?? []).map(i => i.id === frame.issueId ? drop(i, "closedBy") : i),
      reviewActions: without(id),
    };
  }
  // 撤销后房间与未闭合清单同样按墙网几何重算，避免沿用处置结果里的派生数据。
  const levelId = m.levels.some(l => l.id === (frameLevel(m, frame))) ? (frameLevel(m, frame) as string) : m.levels[0]?.id;
  assertValid(next);
  return levelId ? recompute(next, levelId) : next;
}

/** 撤销帧对应的楼层（取自被撤销处置记录或墙段）。 */
function frameLevel(m: BuildingModel, frame: UndoFrame): string | undefined {
  if (frame.kind === "add-wall" || frame.kind === "remove-wall") return m.walls.find(w => w.id === frame.wallId)?.levelId;
  return [...(m.reviewActions ?? [])].reverse().find(a => a.issueId === frame.issueId)?.levelId;
}

function drop<T extends object>(value: T, key: string): T {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[key];
  return copy as T;
}

/** 拟合前影响面：列出会被自动结果覆盖的人工墙段与处置记录。 */
export function reviewFitImpact(m: BuildingModel): ReviewPlan {
  const manual = activeWalls(m).filter(w => w.source?.kind === "manual"), ids = new Set(manual.map(w => w.id)), issues = new Set(manual.map(w => w.source?.issueId));
  const lost = (m.reviewActions ?? []).filter(a => a.action !== "remove-wall" && (a.wallIds.some(id => ids.has(id)) || (a.issueId !== undefined && issues.has(a.issueId))));
  return {
    ok: !manual.length, wallIds: manual.map(w => w.id), levelIds: [...new Set(manual.map(w => w.levelId))], actionIds: lost.map(a => a.id),
    reasons: manual.map(w => `人工墙段 ${w.name ?? w.id}（来源=manual）会被自动拟合结果覆盖，其处置记录随之失效`),
  };
}

/**
 * 重新拟合入口：自动候选生成后调用。`block-on-fit`（缺省）在拟合前列出将失效的人工项并阻断；
 * `rehang` 保留人工墙段并重新挂接。原模型不变。
 */
export function reconcileFit(m: BuildingModel, refit: (previous: BuildingModel) => BuildingModel): BuildingModel | RehangResult {
  const policy = m.reviewPolicy ?? REVIEW_POLICY_DEFAULT;
  if (policy === "block-on-fit") {
    const impact = reviewFitImpact(m);
    if (!impact.ok) throw Error(`重新拟合会覆盖 ${impact.wallIds.length} 个人工墙段与 ${impact.actionIds.length} 条复核处置记录，已阻断（reviewPolicy=block-on-fit）。\n${impact.reasons.join("\n")}`);
    return refit(m);
  }
  return rehangManual(refit(m), m);
}

/** `rehang` 重新挂接：新拟合已有同等墙段的不重复添加；否则保留人工墙段，按墙网节点容差吸附到新墙网。 */
export function rehangManual(fitted: BuildingModel, previous: BuildingModel): RehangResult {
  const manual = activeWalls(previous).filter(w => w.source?.kind === "manual");
  // 自动候选墙段：重拟合结果里除人工来源以外的墙段（未标来源的旧工程墙段同样按自动结果对待）。
  const auto = fitted.walls.filter(w => w.source?.kind !== "manual" && !w.removed);
  // 人工墙段按上一版所在楼层（楼层名称相同）挂回新模型，避免重拟合后楼层编号不同而失去归属。
  const levelOfPrev = (id: string) => {
    const name = previous.levels.find(l => l.id === id)?.name;
    return (fitted.levels.find(l => l.id === id) ?? fitted.levels.find(l => l.name === name) ?? fitted.levels[0])?.id ?? id;
  };
  const kept: Wall[] = [], rehung: string[] = [], covered: string[] = [];
  for (const w of manual) {
    // 新拟合已有同轴同长的墙段（人工补/连接后又由自动拟合识别出）：不重复添加，记为已覆盖。
    if (auto.some(f => sameAxis(f.axisM, w.axisM) && Math.abs(wallLength(f) - wallLength(w)) <= REHANG_TOLERANCE_M)) { covered.push(w.id); continue; }
    // 其余人工墙段保留，端点按墙网节点容差吸附到新墙网；吸附会把墙段压成过短残段时按原几何保留。
    const snapped = w.axisM.map(p => snapPoint(p, auto, []) ?? p) as [Vec2, Vec2];
    kept.push({ ...w, levelId: levelOfPrev(w.levelId), axisM: dist(snapped[0], snapped[1]) > .05 ? snapped : w.axisM, source: { ...(w.source as WallSource) } });
    rehung.push(w.id);
  }
  const actions = [...(fitted.reviewActions ?? []), ...(previous.reviewActions ?? [])]
    .filter((a, i, all) => all.findIndex(x => x.id === a.id) === i).map(a => ({ ...a, levelId: levelOfPrev(a.levelId) }));
  // 重拟合的自动墙段重新以自动来源登记（`origin: fit`），与人工墙段可区分，也不再与旧人工标记编号混用。
  const walls = [...fitted.walls.map(w => ({ ...w, source: { kind: "fit" as const, origin: "fit" as const, at: new Date().toISOString() } })), ...kept];
  const model: BuildingModel = { ...fitted, walls, reviewActions: actions, reviewPolicy: "rehang" };
  // 人工墙段重新挂接后墙网几何已变：房间与未闭合清单按墙网几何重算，人工确认洞口/已连接标记按位置与墙段对应保留。
  for (const level of new Set(kept.map(w => w.levelId))) if (fitted.levels.some(l => l.id === level)) Object.assign(model, recompute(model, level));
  model.unclosedIssues = carryResolutions(model, previous);
  assertValid(model);
  return { model, rehung, covered, notes: [`reviewPolicy=rehang：重新挂接 ${rehung.length} 个人工墙段，${covered.length} 个已由新拟合覆盖，未丢弃处置记录。`] };
}

/** 未闭合是墙网几何算出的：重拟合后同一位置的未闭合项保留人工确认洞口/已连接标记。 */
function carryResolutions(model: BuildingModel, previous: BuildingModel) {
  const carried = (previous.unclosedIssues ?? []).filter(i => i.resolution || i.closedBy);
  return (model.unclosedIssues ?? []).map(issue => {
    const match = carried.find(c => Math.hypot(c.pointM[0] - issue.pointM[0], c.pointM[1] - issue.pointM[1]) <= .3 && issue.wallIds.some(id => c.wallIds.includes(id)));
    return match ? { ...issue, ...(match.resolution ? { resolution: match.resolution } : {}), ...(match.closedBy ? { closedBy: match.closedBy } : {}) } : issue;
  });
}

/** 交付检查视角：未闭合条数、确认洞口、人工/删除墙段与处置记录（不改变核验规则，供复核者与报告读取）。 */
export function reviewSummary(m: BuildingModel, levelId: string) {
  const closure: ClosureReport = levelClosure(m, levelId);
  return {
    closure, unclosed: openUnclosedIssues(m, levelId).length,
    resolvedOpenings: (m.unclosedIssues ?? []).filter(i => i.levelId === levelId && i.resolution === "resolved-opening"),
    manualWalls: activeWalls(m, levelId).filter(w => w.source?.kind === "manual").length,
    removedWalls: m.walls.filter(w => w.removed && w.levelId === levelId),
    rooms: m.rooms.filter(r => r.levelId === levelId).map(r => ({ id: r.id, name: r.name, areaM2: polygonArea(r.boundaryM) })),
    actions: (m.reviewActions ?? []).filter(a => a.levelId === levelId),
  };
}
