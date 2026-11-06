import { expect, it } from 'vitest';
import { buildingFromSegments, type BuildingOptions } from '../src/domain/buildingOps';
import { applyReviewAction, applyUndo, reconcileFit, reviewFitImpact, reviewSummary, openUnclosedIssues, ReviewUndoStack, rehangManual } from '../src/domain/buildingReview';
import { activeWalls, assertBuildingShape, buildingQuantities, validateBuilding, type BuildingModel, type Vec2 } from '../src/domain/building';
import { encodeProject, decodeProject } from '../src/domain/project';
import { assessAccuracy } from '../src/domain/accuracy';
import type { PointCloudData } from '../../src/domain/types';

const source = { name: 'review.pcd', bytes: new ArrayBuffer(1), units: 'm' as const, synthetic: true };
const options: BuildingOptions = { elevationM: 0, heightM: 3, thicknessM: .2, levelName: 'L1' };
const segment = (a: Vec2, b: Vec2) => ({ a, b, support: 20, rmsM: .01 });
const build = (segments: ReturnType<typeof segment>[]) => buildingFromSegments(source, options, segments);
const area = (r: { boundaryM: Vec2[] }) => Math.abs(r.boundaryM.reduce((s, p, i) => { const q = r.boundaryM[(i + 1) % r.boundaryM.length]!; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

/**
 * 8×6 m 房间，东墙留 0.6 m 断口（x=8 上 y∈[2.7,3.3]）。
 * 断口两侧墙段相互平行、距离 0.6 m（> 延长上限），墙网不自动补墙也不吸附，因此未闭合而非“疑似闭合”。
 */
const gapSegments = () => [segment([0,0],[8,0]), segment([8,0],[8,2.7]), segment([8,3.3],[8,6]), segment([8,6],[0,6]), segment([0,6],[0,0])];
/** 东墙留 1.2 m 门口（y∈[2,3.2]）：真实洞口，需人工确认，不得据此造房间。 */
const doorSegments = () => [segment([0,0],[8,0]), segment([8,0],[8,2]), segment([8,3.2],[8,6]), segment([8,6],[0,6]), segment([0,6],[0,0])];
function gapFixture() { return build(gapSegments()); }

it('补墙：0.6 m 缺口补墙后成房、面积正确，墙段与记录带人工来源', () => {
  const m = gapFixture();
  expect(m.rooms).toHaveLength(0);
  const issue = m.unclosedIssues![0]!;
  const step = applyReviewAction(m, { kind: 'add-wall', levelId: m.levels[0]!.id, a: issue.pointM, b: issue.toM!, issueId: issue.id });
  // 补墙段两端正好落在缺口两端，墙网按节点容差直接接上，房间随即重算。
  expect(step.model.rooms).toHaveLength(1);
  expect(openUnclosedIssues(step.model)).toHaveLength(0);
  expect(step.model.rooms).toHaveLength(1);
  const wall = step.model.walls.find(w => w.id === step.action.wallIds[0])!;
  expect(wall.source).toMatchObject({ kind: 'manual', origin: 'manual', issueId: issue.id, actionId: step.action.id });
  expect(buildingQuantities(step.model).rooms[0]!.areaM2).toBeCloseTo(7.8 * 5.8, 6);
  expect(Date.parse(wall.source!.at)).toBeGreaterThan(0);
  expect(step.action).toMatchObject({ action: 'add-wall', operator: 'manual', source: 'review', issueId: issue.id, roomsBefore: 0, roomsAfter: 1, levelId: m.levels[0]!.id });
  expect(validateBuilding(step.model).some(i => i.code === 'MANUAL_WALL' && i.elementId === wall.id)).toBe(true);
  // 撤销补墙：回到未闭合、无房间；处置记录同步移除。
  const back = applyUndo(step.model, step.undo);
  expect(back.rooms).toHaveLength(0);
  expect(back.walls).toHaveLength(m.walls.length);
  expect(back.reviewActions ?? []).toHaveLength(0);

  expect(openUnclosedIssues(back)).toHaveLength(openUnclosedIssues(m).length);
});

it('连接两端：沿缺口生成连接墙轴后成房，两端落到墙网吸附落点，可撤销', () => {
  const m = gapFixture();
  const issue = m.unclosedIssues![0]!;
  const step = applyReviewAction(m, { kind: 'connect', issueId: issue.id });
  expect(step.model.rooms).toHaveLength(1);
  const bridge = step.model.walls.find(w => w.id === step.action.wallIds.at(-1))!;
  expect(Math.hypot(bridge.axisM[1][0] - bridge.axisM[0][0], bridge.axisM[1][1] - bridge.axisM[0][1])).toBeCloseTo(.6, 2);
  expect(bridge.axisM.every(p => Math.abs(p[0] - 8) < 1e-6)).toBe(true);
  // 断口两端相距 0.6 m > 延长上限，墙网无法自己连上；连接只补这一段，不改动两侧已就位的墙段。
  expect(step.model.walls.filter(w => w.source?.kind === 'manual')).toHaveLength(1);
  expect(bridge.source).toMatchObject({ kind: 'manual', issueId: issue.id });
  // 连接后该缺口由墙网几何消解：清单缩为 0，处置记录仍保留原问题编号。
  expect(step.action.issueId).toBe(issue.id);
  expect(openUnclosedIssues(step.model)).toHaveLength(0);
  expect(step.action).toMatchObject({ action: 'connect', roomsBefore: 0, roomsAfter: 1 });
  const back = applyUndo(step.model, step.undo);
  expect(back.rooms).toHaveLength(0);
  expect(back.walls.map(w => w.id).sort()).toEqual(m.walls.map(w => w.id).sort());
  expect(openUnclosedIssues(back)).toHaveLength(openUnclosedIssues(m).length);
  expect((back.unclosedIssues ?? []).some(i => i.closedBy)).toBe(false);
});

it('连接两端：2 cm 内的端点按节点容差合并到既有交点，不新增墙段，房间重算', () => {
  // 西墙比上墙多出 0.03 m：墙网贴合并记一条 0.03 m 未闭合，按节点容差内合并处理。
  const m = build([segment([0,0],[8,0]), segment([8,0],[8,6]), segment([8,6],[0,6]), segment([0,6.03],[0,0])]);
  const issue = m.unclosedIssues![0]!;
  expect(issue.gapM).toBeCloseTo(.03, 6);
  const step = applyReviewAction(m, { kind: 'connect', issueId: issue.id });
  // 缺口小于连接墙轴门限时只做节点合并：两侧墙段截到交点，不新增连接墙轴。
  expect(step.model.walls).toHaveLength(4);
  const manual = step.model.walls.filter(w => w.source?.kind === 'manual');
  expect(manual.map(w => w.axisM)).toEqual([[[0, 6], [0, 0]]]);
  expect(step.action.wallIds).toEqual([manual[0]!.id]);
  expect(step.action.note).toContain('同一墙网交点');
  expect(step.model.rooms).toHaveLength(1);
  expect(openUnclosedIssues(step.model)).toHaveLength(0);
});

it('删伪影：软删除保留被删段来源与原因，不参与墙网与房间；可撤销', () => {
  const m = build([segment([0,0],[8,0]), segment([8,0],[8,6]), segment([8,6],[0,6]), segment([0,6],[0,0]), segment([9.5,2],[9.5,5])]);
  expect(m.rooms).toHaveLength(1);
  const ghost = m.walls.find(w => w.axisM[0][0] === 9.5)!;
  const step = applyReviewAction(m, { kind: 'remove-wall', wallId: ghost.id, reason: '孤立墙面证据低于门槛，判为伪影' });
  expect(activeWalls(step.model).map(w => w.id)).not.toContain(ghost.id);
  expect(step.model.walls).toHaveLength(5); // 留痕保留原数组位置
  const removed = step.model.walls.find(w => w.id === ghost.id)!.removed!;
  expect(removed).toMatchObject({ operator: 'manual', reason: '孤立墙面证据低于门槛，判为伪影', actionId: step.action.id });
  expect(removed.wall.axisM).toEqual(ghost.axisM);
  expect(removed.wall.source).toBeUndefined();
  expect(removed.wall.evidence.kind).toBe('inferred');
  expect(step.model.rooms).toHaveLength(1);
  expect(step.action).toMatchObject({ action: 'remove-wall', roomsBefore: 1, roomsAfter: 1 });
  expect(validateBuilding(step.model).some(i => i.code === 'WALL_REMOVED')).toBe(true);
  const back = applyUndo(step.model, step.undo);
  expect(back.walls.find(w => w.id === ghost.id)!.removed).toBeUndefined();
  expect(activeWalls(back)).toHaveLength(5);
});

it('确认洞口：未闭合数减 1、记录保留并在交付检查可见，不产生房间', () => {
  const m = build(doorSegments());
  expect(m.rooms).toHaveLength(0);
  const issue = m.unclosedIssues![0]!;
  const before = openUnclosedIssues(m).length;
  const step = applyReviewAction(m, { kind: 'resolved-opening', issueId: issue.id });
  expect(openUnclosedIssues(step.model)).toHaveLength(before - 1);
  expect(step.model.rooms).toHaveLength(0);
  expect(step.model.unclosedIssues!.find(i => i.id === issue.id)).toMatchObject({ resolution: 'resolved-opening' });
  expect(validateBuilding(step.model).some(i => i.code === 'RESOLVED_OPENING' && i.elementId === issue.id)).toBe(true);
  // 同一条缝的另一端仍按墙网几何报出，但已确认的这一端不再计入未闭合。
  expect(validateBuilding(step.model).filter(i => i.code === 'UNCLOSED').map(i => i.elementId)).not.toContain(issue.id);
  expect(step.action).toMatchObject({ action: 'resolved-opening', roomsBefore: 0, roomsAfter: 0, issueId: issue.id });
  const back = applyUndo(step.model, step.undo);
  expect(openUnclosedIssues(back)).toHaveLength(before);
});

it('处置后保存重开一致，人工墙段与处置记录都在', async () => {
  const m = gapFixture(), issue = m.unclosedIssues![0]!;
  let step = applyReviewAction(m, { kind: 'add-wall', levelId: m.levels[0]!.id, a: issue.pointM, b: issue.toM!, issueId: issue.id });
  // 删伪影：补墙后房内多出的一小段伪影（孤立、不在房间环上，删除不改变房间）。
  const appended = step.model.walls.at(-1)!.id;
  const ghostStep = applyReviewAction(step.model, { kind: 'add-wall', levelId: m.levels[0]!.id, a: [2, 2], b: [3, 2] });
  const ghost = ghostStep.action.wallIds[0]!;
  expect(appended).not.toBe(ghost);
  expect(ghostStep.model.rooms).toHaveLength(1);
  const removed = applyReviewAction(ghostStep.model, { kind: 'remove-wall', wallId: ghost, reason: '演示' });
  const archive = await encodeProject({ source, building: removed.model, annotations: [], settings: {}, projection: 'xy' });
  const restored = (await decodeProject(archive.slice().buffer as ArrayBuffer)).building!;
  expect(assertBuildingShape(restored)).toBeUndefined();
  expect(restored).toEqual(removed.model);
  expect(restored.reviewActions!.map(a => a.action)).toEqual(['add-wall', 'add-wall', 'remove-wall']);
  expect(restored.walls.find(w => w.id === ghost)!.removed!.reason).toBe('演示');
  expect(restored.reviewPolicy).toBeUndefined();
  // 撤销栈走完两步回到起始状态。
  const stack = new ReviewUndoStack().push(step.undo).push(ghostStep.undo).push(removed.undo);
  const one = stack.undo(restored)!, two = stack.undo(one)!, three = stack.undo(two)!;
  expect(three.walls).toHaveLength(m.walls.length);
  expect(three.reviewActions ?? []).toHaveLength(0);
  expect(three.rooms).toHaveLength(0);
  expect(three.walls.map(w => w.axisM)).toEqual(m.walls.map(w => w.axisM));
});

it('重新拟合：缺省 block-on-fit 在拟合前列出将失效的人工项并阻断；原模型不变', () => {
  const m = gapFixture(), issue = m.unclosedIssues![0]!;
  const step = applyReviewAction(m, { kind: 'add-wall', levelId: m.levels[0]!.id, a: issue.pointM, b: issue.toM!, issueId: issue.id });
  const impact = reviewFitImpact(step.model);
  expect(impact).toMatchObject({ ok: false, wallIds: [step.action.wallIds[0]], actionIds: [step.action.id] });
  expect(impact.reasons.some(r => r.includes('来源=manual'))).toBe(true);
  let called = 0;
  expect(() => reconcileFit(step.model, previous => { called++; return previous; })).toThrow(/已阻断/);
  expect(called).toBe(0);
  expect(step.model.walls).toHaveLength(6);
  expect(openUnclosedIssues(step.model)).toHaveLength(0);
  // 没有人工墙段时不阻断。
  const refit = reconcileFit(m, previous => ({ ...previous, revision: previous.revision + 1 }));
  expect((refit as BuildingModel).revision).toBe(m.revision + 1);
});

it('重新拟合：reviewPolicy=rehang 保留人工墙段与处置记录并重新挂接，新拟合已覆盖的不重复添加', () => {
  const mark = (m: BuildingModel) => ({ ...m, walls: m.walls.map(w => ({ ...w, source: { ...(w.source ?? { kind: 'fit' as const, origin: 'fit' as const, at: new Date(0).toISOString() }), actionId: undefined, issueId: undefined } })) });
  const m = gapFixture(), issue = m.unclosedIssues![0]!;
  const step = applyReviewAction(m, { kind: 'add-wall', levelId: m.levels[0]!.id, a: issue.pointM, b: issue.toM!, issueId: issue.id });
  // 上一版：自动候选墙段标为拟合来源，人工补墙段保持人工来源（未复核，仅测试口径）。
  const manualOf = (m: BuildingModel) => m.walls.filter(w => w.source?.kind === 'manual');
  const previous: BuildingModel = { ...step.model, walls: mark(step.model).walls, reviewPolicy: 'rehang' };
  // 新拟合只给回原始 5 段候选（丢了人工补墙）：人工段必须保留并重新接入墙网，处置记录仍在。
  const refit = (previous: BuildingModel) => ({ ...mark(buildingFromSegments(source, options, gapSegments())), revision: previous.revision + 1 });
  const result = reconcileFit(previous, refit);
  expect('model' in result).toBe(true);
  const { model, rehung, covered } = result as ReturnType<typeof reconcileFit> & { model: BuildingModel; rehung: string[]; covered: string[] };
  expect(rehung).toContain(step.action.wallIds[0]);
  expect(model.reviewActions!.map(a => a.id)).toEqual(previous.reviewActions!.map(a => a.id));
  expect(model.rooms).toHaveLength(1);
  expect(model.reviewPolicy).toBe('rehang');
  // 新拟合已含同等墙段时：不重复添加，记为已覆盖（新拟合楼层编号不同，人工段按楼层名称挂回）。
  const refitted = mark(buildingFromSegments(source, options, gapSegments()));
  // 新拟合另行识别出同等墙段（不同编号、标为拟合来源）：按同轴同长判定为已覆盖，不重复添加、不丢弃处置记录。
  const identified = { ...refitted, walls: [...refitted.walls, ...manualOf(previous).map(w => ({ ...w, id: crypto.randomUUID(), levelId: refitted.levels[0]!.id, source: { kind: 'fit' as const, origin: 'fit' as const, at: new Date(0).toISOString() } }))], revision: previous.revision + 1 };
  const same = rehangManual(identified, previous);
  // 上一版的人工段已改随机编号（模拟新拟合另行识别），按同轴同长判定为已覆盖，不再追加。
  expect(same.covered).toEqual(manualOf(previous).map(w => w.id));
  expect(same.rehung).toEqual([]);
  // 新拟合已带同等墙段时不再追加人工段，墙网计数与处置记录都保留（房间由墙网几何重算，不在本用例断言）。
  expect(same.model.walls).toHaveLength(identified.walls.length);
  expect(same.model.reviewActions!.map(a => a.id)).toEqual(previous.reviewActions!.map(a => a.id));
});

it('人工墙段不参与自动尺寸核验的独立实测口径', () => {
  const m = gapFixture(), issue = m.unclosedIssues![0]!;
  const step = applyReviewAction(m, { kind: 'add-wall', levelId: m.levels[0]!.id, a: issue.pointM, b: issue.toM!, issueId: issue.id });
  const reference = {
    schema: 'survey-accuracy-reference/1' as const, modelId: step.model.id, sourceStamp: step.model.sourceStamp!,
    provenance: { kind: 'independent-survey' as const, method: '钢尺', operator: '复核员', measuredAt: '2026-01-01T00:00:00Z', documentRef: 'RD-01' },
    measurements: [
      { elementId: m.walls[0]!.id, metric: 'lengthM' as const, reference: 8, tolerance: .05, uncertainty: .01 },
      { elementId: step.action.wallIds[0]!, metric: 'lengthM' as const, reference: .6, tolerance: .05, uncertainty: .01 },
    ],
  };
  const report = assessAccuracy({ ...step.model, rooms: step.model.rooms }, reference);
  expect(report.counts.checked).toBe(1);
  expect(report.counts.skippedManual).toBe(1);
  expect(report.results.map(r => r.elementId)).toEqual([m.walls[0]!.id]);
  expect(report.results[0]!.actual).toBeCloseTo(8, 6);
  expect(report.limitations[0]).toContain('人工墙段');
  expect(report.limitations[0]).toContain('独立实测');
});

it('复核摘要给出未闭合、确认洞口、人工/删除墙段与处置记录', () => {
  const m = build(doorSegments());
  const step = applyReviewAction(m, { kind: 'resolved-opening', issueId: m.unclosedIssues![0]!.id });
  const summary = reviewSummary(step.model, m.levels[0]!.id);
  expect(summary.resolvedOpenings).toHaveLength(1);
  expect(summary.unclosed).toBe(openUnclosedIssues(step.model, m.levels[0]!.id).length);
  expect(summary.actions).toHaveLength(1);
  expect(summary.rooms).toHaveLength(0);
  const cloud: PointCloudData = { id: 'x', frameId: 'x', stampNs: 0n, positions: new Float32Array(), colors: new Uint8Array(), visible: new Uint8Array() };
  expect(cloud.positions.length).toBe(0);
});
