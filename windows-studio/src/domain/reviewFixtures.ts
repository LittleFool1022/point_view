import {
  activeWalls, type BuildingModel, type UnclosedIssue, type Vec2, type Wall,
} from './building';
import { buildingFromSegments, levelClosure, type BuildingOptions } from './buildingOps';
import { applyReviewAction, openUnclosedIssues, roomCount, reviewSummary, type ReviewStep } from './buildingReview';
import { snapToWalls } from '../BuildingPlan';
import { disposalOf, issueGroup, reviewActions } from '../WallReviewPanel';

/** 界面复核夹具的几何：8×6 m 房间，东墙 y∈[2.7,3.3] 留 0.6 m 缺口，室外 1 m 孤立墙段（伪影）。 */
export const REVIEW_FIXTURE_WALLS: Array<[number, number, number, number]> = [
  [0, 0, 8, 0], [8, 0, 8, 2.7], [8, 3.3, 8, 6], [8, 6, 0, 6], [0, 6, 0, 0], [14, 1, 15, 1],
];
export const REVIEW_FIXTURE_HEIGHTS = [.2, .5, .8, 1.1, 1.4, 1.7, 2, 2.3, 2.6, 2.9];
export const REVIEW_FIXTURE_GAP_M = .6;
export function reviewFixtureSegments() {
  return REVIEW_FIXTURE_WALLS.map(([x0, y0, x1, y1]) => ({ a: [x0, y0] as Vec2, b: [x1, y1] as Vec2, support: 20, rmsM: .01 }));
}
/** 与 .pcd 夹具同源的合成点云（脚本 scripts/wall-review-fixture.ts 写盘供浏览器用例导入）。 */
export function reviewFixturePcd(): string {
  const rows: string[] = [];
  for (const [x0, y0, x1, y1] of REVIEW_FIXTURE_WALLS) {
    const length = Math.hypot(x1 - x0, y1 - y0);
    for (let t = 0; t <= length + 1e-9; t += .03) {
      const x = x0 + (x1 - x0) * t / length, y = y0 + (y1 - y0) * t / length;
      for (const z of REVIEW_FIXTURE_HEIGHTS) rows.push(`${x.toFixed(3)} ${y.toFixed(3)} ${z}`);
    }
  }
  return `VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\nPOINTS ${rows.length}\nDATA ascii\n${rows.join("\n")}\n`;
}
export const reviewFixtureOptions: BuildingOptions = { elevationM: 0, heightM: 3, thicknessM: .2, levelName: '一层' };
export function reviewFixture() {
  return buildingFromSegments({ name: '复核合成示例.pcd', bytes: new ArrayBuffer(1), units: 'm', synthetic: true }, reviewFixtureOptions, reviewFixtureSegments());
}

/** 缺口项：只在清单里找“两端相距 >0 且不在同一端点”的大缺口，不按样本坐标或编号取。 */
export function gapIssue(m: BuildingModel): UnclosedIssue | undefined {
  return openUnclosedIssues(m).filter(i => i.kind === 'wall-gap' && (i.gapM ?? 0) >= REVIEW_FIXTURE_GAP_M - 1e-6)[0];
}
/** 伪影墙段：既不在房间环上、也不属于任何未闭合项的墙段（按几何关系判定，不按编号）。 */
export function artifactWall(m: BuildingModel): Wall | undefined {
  const rooms = new Set(m.rooms.flatMap(r => r.loop?.wallIds ?? [])), issues = new Set((m.unclosedIssues ?? []).flatMap(i => i.wallIds));
  return activeWalls(m).find(w => !rooms.has(w.id) && !issues.has(w.id));
}

/** 画布两点补墙：取缺口两端，经画布吸附后提交（与界面点击同一路径：吸附 → 模型层补墙处置）。 */
export function patchGap(model: BuildingModel, issue: UnclosedIssue): ReviewStep {
  const walls = activeWalls(model, issue.levelId);
  const a = snapToWalls(issue.pointM, walls), b = snapToWalls(issue.toM ?? issue.pointM, walls);
  return applyReviewAction(model, { kind: 'add-wall', levelId: issue.levelId, a, b, issueId: issue.id });
}

/** 处置来源：记录、墙段来源标记与清单状态同时成立才算已处置。 */
export function disposalSource(m: BuildingModel, issueId: string) {
  const record = disposalOf(m, issueId), patch = activeWalls(m).filter(w => w.source?.kind === 'manual' && w.source.issueId === issueId);
  const issue = (m.unclosedIssues ?? []).find(i => i.id === issueId);
  return { record, patch, state: issue?.resolution ?? (issue?.closedBy ? 'closed-by-review' : record ? `review:${record.action}` : undefined) };
}

/** 面板分组与入口：对任意模型的未闭合项都成立，不依赖计数器或墙段编号。 */
export function panelModel(m: BuildingModel, issueId?: string) {
  const issue = (issueId ? openUnclosedIssues(m).find(i => i.id === issueId) : undefined) ?? gapIssue(m)!;
  return {
    groups: [...new Set([...openUnclosedIssues(m), ...(m.unclosedIssues ?? []).filter(i => i.resolution || i.closedBy)].map(issueGroup))],
    issueGroup: issueGroup(issue),
    actions: reviewActions(issue).map(a => a.id),
    noConnect: reviewActions({ ...issue, kind: 'dangling-end', toM: undefined }).map(a => a.id),
    summary: reviewSummary(m, issue.levelId),
    rooms: roomCount(m, issue.levelId),
    closure: levelClosure(m, issue.levelId),
  };
}

/** 保存重开后由模型本身恢复的面板视角（未闭合、已处置、剩余、房间、记录）。 */
export function panelState(m: BuildingModel, levelId: string) {
  const open = openUnclosedIssues(m, levelId), done = (m.unclosedIssues ?? []).filter(i => i.levelId === levelId && (i.resolution || i.closedBy));
  return {
    total: open.length + done.length, disposed: done.length, remaining: open.length, rooms: roomCount(m, levelId),
    actions: (m.reviewActions ?? []).filter(a => a.levelId === levelId).map(a => a.action),
  };
}
/** 伪影墙段删除后仍以留痕存在于模型中，但不参与墙网。 */
export const artifactRemoved = (m: BuildingModel, wallId: string) => !!m.walls.find(w => w.id === wallId)?.removed;
