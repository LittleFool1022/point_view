import { expect, it } from 'vitest';
import { activeWalls, validateBuilding, type BuildingModel, type Wall } from '../src/domain/building';
import { buildingFromSegments } from '../src/domain/buildingOps';
import { applyReviewAction, applyUndo, openUnclosedIssues, roomCount } from '../src/domain/buildingReview';
import { decodeProject, encodeProject, validateProjectState, type SurveyProject } from '../src/domain/project';
import { snapToWalls } from '../src/BuildingPlan';
import {
  artifactRemoved, artifactWall, disposalSource, gapIssue, panelModel, panelState, patchGap, reviewFixture, reviewFixtureOptions, reviewFixturePcd,
} from '../src/domain/reviewFixtures';
import { fitWallLines } from '../src/pipeline/wallLines';

it('合成夹具起点：缺口与伪影都在，未闭合且无房间', () => {
  const m = reviewFixture(), issue = gapIssue(m)!;
  expect(m.rooms).toHaveLength(0);
  expect(Math.hypot(issue.toM![0] - issue.pointM[0], issue.toM![1] - issue.pointM[1])).toBeCloseTo(.6, 6);
  expect(artifactWall(m)).toBeDefined();
  // 夹具与面板不写死墙段编号：缺口项与伪影都按几何关系从清单里取出。
  expect(issue.wallIds.length).toBeGreaterThanOrEqual(2);
});

it('清单定位 → 补墙 → 房间出现并计数更新：吸附落点落在缺口两端', () => {
  const m = reviewFixture(), issue = gapIssue(m)!, before = panelState(m, issue.levelId), walls = activeWalls(m, issue.levelId);
  expect(snapToWalls(issue.pointM, walls)).toEqual(issue.pointM);
  expect(snapToWalls(issue.toM!, walls)).toEqual(issue.toM);
  // 点击位置离墙网 5 cm 时吸附到缺口端点，与模型层同一 0.25 m 口径。
  const off: [number, number] = [issue.pointM[0] + .05, issue.pointM[1] + .05];
  expect(snapToWalls(off, walls)).toEqual(issue.pointM);
  const step = patchGap(m, issue);
  expect(roomCount(step.model, issue.levelId)).toBe(before.rooms + 1);
  const after = panelState(step.model, issue.levelId);
  expect(after.rooms).toBe(1);
  // 补墙沿缺口补齐后，缺口两端都不是未闭合项了；其余清单项（伪影两端）照常保留。
  expect(openUnclosedIssues(step.model).some(i => i.wallIds.includes(issue.wallIds[0]!) && i.kind === 'wall-gap')).toBe(false);
  expect(after.remaining).toBeLessThan(before.remaining);
  expect(after.actions).toEqual(['add-wall']);
  const source = disposalSource(step.model, issue.id);
  expect(source.record).toMatchObject({ action: 'add-wall', operator: 'manual', issueId: issue.id });
  expect(source.patch.map(w => w.source?.kind)).toEqual(['manual']);
  expect(source.patch[0]!.source!.issueId).toBe(issue.id);
  expect(Date.parse(source.patch[0]!.source!.at)).toBeGreaterThan(0);
});

it('确认洞口后清单减少且不据此成房；同一条缝只处置一次', () => {
  const m = reviewFixture(), issue = gapIssue(m)!, before = openUnclosedIssues(m).length;
  const step = applyReviewAction(m, { kind: 'resolved-opening', issueId: issue.id });
  expect(openUnclosedIssues(step.model).length).toBeLessThan(before);
  expect(step.model.rooms).toHaveLength(0);
  expect(disposalSource(step.model, issue.id).state).toBe('resolved-opening');
  expect(panelState(step.model, issue.levelId)).toMatchObject({ rooms: 0, actions: ['resolved-opening'] });
  // 已处置项不再出现在可处置入口里。
  expect(openUnclosedIssues(step.model).some(i => i.id === issue.id)).toBe(false);
});

it('撤销一次处置：补墙或确认洞口都回到处置前状态', () => {
  const m = reviewFixture(), issue = gapIssue(m)!;
  const patched = patchGap(m, issue), back = applyUndo(patched.model, patched.undo);
  expect(back.rooms).toHaveLength(0);
  expect(back.walls.map(w => w.id)).toEqual(m.walls.map(w => w.id));
  expect(back.reviewActions ?? []).toHaveLength(0);
  expect(openUnclosedIssues(back).length).toBe(openUnclosedIssues(m).length);

  const resolved = applyReviewAction(m, { kind: 'resolved-opening', issueId: issue.id });
  const reopened = applyUndo(resolved.model, resolved.undo);
  // 撤销后该缺口重新计入未闭合；同一位置的未闭合项沿用原编号。
  expect(openUnclosedIssues(reopened).map(i => i.id)).toContain(issue.id);
  expect((reopened.unclosedIssues ?? []).some(i => i.resolution)).toBe(false);
  expect(reopened.reviewActions ?? []).toHaveLength(0);
});

it('连接两端可直接处置缺口并成房', () => {
  const m = reviewFixture(), issue = gapIssue(m)!;
  const step = applyReviewAction(m, { kind: 'connect', issueId: issue.id });
  expect(roomCount(step.model, issue.levelId)).toBe(1);
  expect(step.action).toMatchObject({ action: 'connect', roomsBefore: 0, roomsAfter: 1 });
  expect(panelModel(m).actions.some(a => a === 'connect')).toBe(true);
});

it('删伪影留痕：墙段不参与墙网但仍可撤销，单元格记录为人工', () => {
  const m = reviewFixture(), ghost = artifactWall(m)!, rooms = m.rooms.length;
  const step = applyReviewAction(m, { kind: 'remove-wall', wallId: ghost.id, reason: '孤立墙面证据，判为伪影' });
  expect(artifactRemoved(step.model, ghost.id)).toBe(true);
  expect(activeWalls(step.model).map(w => w.id)).not.toContain(ghost.id);
  expect(step.model.rooms).toHaveLength(rooms);
  expect(step.model.reviewActions!.at(-1)).toMatchObject({ action: 'remove-wall', operator: 'manual' });
  const back = applyUndo(step.model, step.undo);
  expect(artifactRemoved(back, ghost.id)).toBe(false);
});

it('保存重开后处置仍在，面板状态与处置后一致', async () => {
  const m = reviewFixture(), issue = gapIssue(m)!, ghost = artifactWall(m)!;
  let model = patchGap(m, issue).model;
  model = applyReviewAction(model, { kind: 'remove-wall', wallId: ghost.id, reason: '伪影' }).model;
  const before = panelState(model, issue.levelId);
  const archive = await encodeProject({ source: { name: '复核合成示例.pcd', bytes: new ArrayBuffer(1), units: 'm', synthetic: true }, building: model, annotations: [], settings: {}, projection: 'xy' });
  const restored = (await decodeProject(archive.slice().buffer as ArrayBuffer)).building!;
  expect(validateBuilding(restored).filter(i => !['UNREVIEWED', 'UNCLOSED', 'RESOLVED_OPENING', 'CLOSED_BY_REVIEW', 'MANUAL_WALL', 'WALL_REMOVED', 'UNCLOSED_TRACE'].includes(i.code))).toEqual([]);
  expect(restored.rooms.map(r => r.id)).toEqual(model.rooms.map(r => r.id));
  expect(panelState(restored, issue.levelId)).toEqual(before);
  expect(disposalSource(restored, issue.id).record?.action).toBe('add-wall');
  // 人工墙段与记录都来自模型字段，恢复后仍是 manual。
  expect(activeWalls(restored).filter(w => w.source?.kind === 'manual').length).toBe(1);
});

it('面板分组与处置入口对任意未闭合项成立，不依赖具体样本', () => {
  const m = reviewFixture();
  const panel = panelModel(m);
  expect(panel.groups.length).toBeGreaterThan(0);
  expect(panel.actions).toEqual(['connect', 'patch', 'remove', 'opening']);
  // 悬空端没有目标落点：不提供“连接两端”，其余处置照常可用。
  expect(panel.noConnect).toEqual(['patch', 'remove', 'opening']);
  expect(panel.closure.rooms).toBe(0);
  const walls: Wall[] = activeWalls(m, m.levels[0]!.id);
  expect(walls.length).toBeGreaterThan(0);
});

it('合成点云经真实墙线拟合后与清单夹具一致：6 段墙、无房间、一处 0.6 m 缺口', async () => {
  const text = reviewFixturePcd(), body = text.split("DATA ascii\n")[1]!.trim().split("\n").map(line => line.split(" ").map(Number));
  const positions = new Float32Array(body.length * 3);
  body.forEach((p, i) => { positions[i * 3] = p[0]!; positions[i * 3 + 1] = p[1]!; positions[i * 3 + 2] = p[2]!; });
  const cloud = { id: "fixture", frameId: "map", stampNs: 0n, positions, colors: new Uint8Array(positions.length), visible: new Uint8Array(body.length).fill(1) };
  const fit = await fitWallLines(cloud as never, () => {});
  const model = buildingFromSegments({ name: "复核合成示例.pcd", bytes: new ArrayBuffer(1), units: "m", synthetic: true }, reviewFixtureOptions, fit.segments);
  expect(model.walls).toHaveLength(6);
  expect(model.rooms).toHaveLength(0);
  expect(gapIssue(model)?.gapM).toBeCloseTo(.6, 2);
  expect(openUnclosedIssues(model)).toHaveLength(2);
  expect(gapIssue(model)!.gapM).toBeCloseTo(gapIssue(reviewFixture())!.gapM!, 2);
});

/**
 * 工程打开语义（负责人决定）：点云不可用（文件缺失或无法读取）时，含建筑模型的工程仍可打开，
 * 保留建筑模型、复核记录与处置历史；点云恢复后重开即恢复对照，不迁移工程文件。
 * 打开与否只看工程清单里有没有建筑模型，与点云能否读取无关。
 */
const projectSource = () => ({ name: 'review-room-gap.pcd', bytes: new ArrayBuffer(1), units: 'm' as const, synthetic: true });
// 工程清单与 encodeProject 写出的结构一致（schema + source.sha256），只缺可读取的点云字节。
const manifestOf = (building?: BuildingModel): SurveyProject => ({ schema: 'survey-project/1', source: { ...projectSource(), sha256: '0'.repeat(64) }, building, annotations: [], settings: {}, projection: 'xy' } as unknown as SurveyProject);
const opens = (project: SurveyProject) => {
  try { validateProjectState(JSON.parse(JSON.stringify(project))); return { ok: true as const, rooms: project.building?.rooms.length ?? 0, actions: project.building?.reviewActions?.length ?? 0 }; }
  catch (error) { return { ok: false as const, reason: error instanceof Error ? error.message : String(error) }; }
};

it('点云不可用时：含建筑模型的工程仍可打开，模型、复核记录与处置历史都在、房间数不变', async () => {
  const m = reviewFixture(), issue = gapIssue(m)!;
  // 两次处置：先确认一个洞口（清单仍有余项），再补墙成房；打开工程时两者都要在。
  const resolvedStep = applyReviewAction(m, { kind: "resolved-opening", issueId: issue.id });
  const reviewed = patchGap(resolvedStep.model, gapIssue(resolvedStep.model) ?? issue).model;
  const opened = opens(manifestOf(reviewed));
  expect(opened).toMatchObject({ ok: true, rooms: 1, actions: 2 });
  expect(reviewed.reviewActions!.map(a => a.action).sort()).toEqual(["add-wall", "resolved-opening"]);
  // 不含建筑模型的工程不因本规则放宽：坏文件仍拒绝打开。
  await expect(decodeProject(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)).rejects.toThrow();
});

it('点云恢复后重开：同一工程文件不迁移即可恢复对照，模型与记录一致', async () => {
  const m = reviewFixture(), issue = gapIssue(m)!;
  const reviewed = patchGap(m, issue).model;
  const archive = await encodeProject({ source: { name: '复核合成示例.pcd', bytes: new ArrayBuffer(1), units: 'm', synthetic: true }, building: reviewed, annotations: [], settings: {}, projection: 'xy' });
  const restored = (await decodeProject(archive.slice().buffer as ArrayBuffer)).building!;
  expect(restored.rooms).toHaveLength(roomCount(reviewed, issue.levelId));
  expect(restored.reviewActions!.map(a => a.action)).toEqual(['add-wall']);
  expect(activeWalls(restored).filter(w => w.source?.kind === 'manual')).toHaveLength(1);
});
