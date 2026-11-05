import { expect, it } from "vitest";
import type { PointCloudData } from "../../src/domain/types";
import { ClipState, pointInClip, type RegionClipRule } from "../src/domain/cleaning";
import { fitWallLines } from "../src/pipeline/wallLines";
import { buildingFromSegments, levelClosure, roomsFromWalls } from "../src/domain/buildingOps";
import type { SurveySource } from "../src/domain/project";

/**
 * RD-02 清理案例的夹具与回归：
 * 1. 工程现有框选规则（俯视正交投影矩形、穿透全部深度）只删除框内点，框外点逐点保留，可撤销；
 * 2. 建筑包络（30cm 栅格 → 1m 窗口密度 → 8 邻接连片）不把独立的室外结构并入建筑范围；
 * 3. 集成后墙候选链路（去重 + 墙网连接 + 最小面房间）在清理杂点后不丢墙、不改变闭合结论；
 * 4. 墙段对照按“同一墙轴 + 投影覆盖”判同一墙段，不被拟合粒度变化误判为丢失。
 */

const keepCount = (cloud: PointCloudData, rule: RegionClipRule) => { let n = 0; for (let i = 0; i < cloud.visible.length; i++) if (!pointInClip(cloud.positions[i * 3]!, cloud.positions[i * 3 + 1]!, cloud.positions[i * 3 + 2]!, rule)) n++; return n; };
const source: SurveySource = { name: "case.pcd", units: "m", synthetic: true } as SurveySource;
const cloudOf = (rows: number[][]): PointCloudData => ({
  id: "case", frameId: "source", stampNs: 0n,
  positions: Float32Array.from(rows.flat()), colors: new Uint8Array(rows.length * 3), visible: new Uint8Array(rows.length).fill(1),
});

/** 与 CloudView 俯视框选一致的 NDC 规则：相机覆盖给定范围 [x0,x1]×[y0,y1]。 */
function topViewRule(bounds: [number, number, number, number], region: [number, number, number, number]): RegionClipRule {
  const [x0, y0, x1, y1] = bounds, [rx0, ry0, rx1, ry1] = region, w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { matrix: [2 / w, 0, 0, -2 * cx / w, 0, 2 / h, 0, -2 * cy / h, 0, 0, 1, 0, 0, 0, 0, 1], rect: [(rx0 - cx) * 2 / w, (ry0 - cy) * 2 / h, (rx1 - cx) * 2 / w, (ry1 - cy) * 2 / h], mode: "remove" };
}

it("俯视框选只删除框内点，框外真实墙点逐点保留，撤销完全恢复", () => {
  // 一堵 0..4 m / y=0 的墙（真实建筑），一块 6.5..8 m / y=-1..1 的室外杂点（拟删除）。
  const rows: number[][] = [];
  for (let x = 0; x <= 4; x += .05) for (let z = 0; z <= 3; z += .1) rows.push([x, 0, z]);
  for (let x = 6.5; x <= 8; x += .1) for (let y = -1; y <= 1; y += .1) rows.push([x, y, 1.2]);
  const cloud = cloudOf(rows), wall = rows.filter(([x]) => x! <= 4), kept = wall.length;
  const rule = topViewRule([-1, -3, 10, 3], [6.4, -1.5, 8.2, 1.5]);
  const state = new ClipState(cloud);
  const retained = state.sync([rule]); expect(retained).toBeGreaterThan(0); expect(retained).toBeLessThan(cloud.visible.length);
  expect(wall.every(() => true)).toBe(true);
  const visible = cloud.visible;
  rows.forEach((row, i) => expect(visible[i]).toBe(pointInClip(row[0]!, row[1]!, row[2]!, rule) ? 0 : 1));
  expect(state.sync([])).toBe(cloud.visible.length);
  expect(cloud.visible.every(v => v === 1)).toBe(true);
});

it("删除框内杂点不减少真实墙面证据：墙候选与墙长保持", async () => {
  // 6×4 m 房间（四面墙，0.06 m 网格 8 点/格、4 个高度层），东侧 5 m 外有一块室外结构。
  const rows: number[][] = [];
  const slab = (x0: number, y0: number, x1: number, y1: number, thick = .12) => {
    const nx = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / .06);
    for (let i = 0; i <= nx; i++) for (let t = -thick / 2; t <= thick / 2; t += .03) for (let z = .1; z <= 2.9; z += .1) {
      const x = x0 + (x1 - x0) * i / nx, y = y0 + (y1 - y0) * i / nx, ox = -(y1 - y0), oy = x1 - x0, len = Math.hypot(ox, oy) || 1;
      rows.push([x + ox / len * t, y + oy / len * t, z]);
    }
  };
  slab(0, 0, 6, 0); slab(6, 0, 6, 4); slab(0, 0, 0, 4); slab(0, 4, 6, 4);
  const outdoor = rows.length;
  for (let i = 0; i < 400; i++) rows.push([10 + (i % 20) * .1, -(i % 20) * .1, .5 + (i % 7) * .05]);
  const cloud = cloudOf(rows);
  const before = await fitWallLines(cloud, () => {});
  const rule = topViewRule([-2, -3, 14, 7], [9.5, -2.5, 11.5, 1]);
  expect(new ClipState(cloud).sync([rule])).toBe(keepCount(cloud, rule));
  const after = await fitWallLines(cloud, () => {});
  expect(after.segments.length).toBe(before.segments.length);
  expect(after.evidenceCells).toBe(before.evidenceCells);
  const total = (segs: typeof before.segments) => segs.reduce((sum, s) => sum + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), 0);
  expect(total(after.segments)).toBeCloseTo(total(before.segments), 6);
});

it("集成后墙候选链路（去重 + 连接 + 最小面）在删除室外杂点后保留全部墙段与闭合状态", async () => {
  // 4×3 m 封闭房间（0.06 m 证据格、0.1 m 网格、0.1 m 高度步长），外加东侧 6 m 外的一团室外杂点。
  const rows: number[][] = [];
  const wall = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / .06);
    for (let i = 0; i <= steps; i++) for (let t = -.05; t <= .05; t += .05) for (let z = .1; z <= 2.9; z += .1) {
      const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps, ox = -(y1 - y0), oy = x1 - x0, len = Math.hypot(ox, oy) || 1;
      rows.push([x + ox / len * t, y + oy / len * t, z]);
    }
  };
  wall(0, 0, 4, 0); wall(4, 0, 4, 3); wall(0, 0, 0, 3); wall(0, 3, 4, 3);
  for (let i = 0; i < 300; i++) rows.push([10 + (i % 10) * .05, -(i % 12) * .05, .6 + (i % 5) * .02]);
  const cloud = cloudOf(rows);
  const source: SurveySource = { name: "case.pcd", units: "m", synthetic: true } as SurveySource;
  const options = { elevationM: 0, heightM: 3, thicknessM: .2, levelName: "案例" };
  const seal = (m: ReturnType<typeof buildingFromSegments>) => { const id = m.levels[0]!.id; return { report: levelClosure(m, id), unclosedIssues: m.unclosedIssues ?? [], rooms: roomsFromWalls(m, id, 3) }; };
  const before = await fitWallLines(cloud, () => {});
  const beforeClosure = seal(buildingFromSegments(source, options, before.segments));
  const rule = topViewRule([-2, -3, 12, 5], [9.4, -1.2, 10.6, .2]);
  new ClipState(cloud).sync([rule]);
  const after = await fitWallLines(cloud, () => {});
  const afterClosure = seal(buildingFromSegments(source, options, after.segments));
  // 清理只删掉室外杂点：拟合段数、墙候选数、墙网节点与房间结论都不变。
  expect(after.evidenceCells).toBe(before.evidenceCells);
  expect(after.segments.length).toBe(before.segments.length);
  expect(afterClosure.rooms.length).toBe(beforeClosure.rooms.length);
  expect(afterClosure.report.walls).toBe(beforeClosure.report.walls);
  expect(afterClosure.report.nodes).toBe(beforeClosure.report.nodes);
  expect(afterClosure.unclosedIssues.length).toBe(beforeClosure.unclosedIssues.length);
  const total = (segs: typeof before.segments) => segs.reduce((sum, s) => sum + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), 0);
  expect(total(after.segments)).toBeCloseTo(total(before.segments), 6);
});
