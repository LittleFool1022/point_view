import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../../src/domain/types";
import { DEDUPE_AXIS_GAP_M, DEDUPE_DIRECTION_DEG, mergeWallSegments } from "../src/pipeline/wallDedupe";
import { fitWallLines, type WallSegment } from "../src/pipeline/wallLines";

type P = [number, number];
const segment = (a: P, b: P, support = 20): WallSegment => ({ a, b, support, rmsM: .005 });
const length = (s: WallSegment) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
/** 点沿墙轴方向与横向偏移。 */
const offset = (s: WallSegment, dx: number, dy: number): WallSegment => ({ ...s, a: [s.a[0] + dx, s.a[1] + dy], b: [s.b[0] + dx, s.b[1] + dy] });
const cloud = (positions: number[]): PointCloudData => ({ id: "dedupe", frameId: "source", stampNs: 0n, positions: Float32Array.from(positions), colors: new Uint8Array(positions.length), visible: new Uint8Array(positions.length / 3).fill(1) });

/**
 * 合并判据是**功能参数**（同一墙轴、同一道墙的尺度），不是精度阈值；
 * 夹具验证"应合并的合为一条、不应合并的保持独立"，不做精度认证。
 */
describe("墙候选去重合并（fitWallLines 输出之后）", () => {
  it("同一墙轴的平行重复段合为一条：范围取投影并集，保留全部来源编号", () => {
    // #0 是整面墙的主线；#1、#2 是拟合在它两侧 0.02–0.08 m 处重新分配证据得到的重复段。
    const segments = [segment([0, 0], [8, .02]), offset(segment([0, 0], [3, .01]), .02, .06), offset(segment([5, 0], [8, .02]), 0, .035)];
    const { segments: merged, groups } = mergeWallSegments(segments);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toEqual([0, 1, 2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sourceIndexes).toEqual([0, 1, 2]);
    // 骨干是最长的 #0；合并后长度覆盖各段投影并集（约 8 m，两端各不超过横向判据的投影偏差）。
    expect(groups[0]!.backboneIndex).toBe(0);
    expect(groups[0]!.coveredFraction).toBeCloseTo(1, 6);
    // 合并范围覆盖各来源端点在骨干轴上的投影并集（约 8.0 m，斜 0.02 m 的段在水平轴上略短）。
    expect(length(merged[0]!)).toBeGreaterThan(8);
    expect(length(merged[0]!)).toBeLessThan(8.02 + DEDUPE_AXIS_GAP_M);
  });

  it("相邻相接的平行碎片（投影首尾相接）合为一条，支撑格与来源相加", () => {
    const segments = [segment([0, 0], [4, 0], 30), offset(segment([4, 0], [8, 0], 12), .02, .04)];
    const { segments: merged, groups } = mergeWallSegments(segments);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.support).toBe(42);
    expect(groups[0]!.coveredFraction).toBeCloseTo(1, 6);
    expect(length(merged[0]!)).toBeGreaterThan(8);
  });

  it("不合并：轴间距超判据的悬空平行墙各自独立输出", () => {
    const { segments: merged, groups } = mergeWallSegments([segment([0, 0], [8, 0]), segment([0, .3], [8, .3])]);
    expect(merged).toHaveLength(2);
    expect(groups).toHaveLength(0);
    expect(merged.map(s => s.sources)).toEqual([[0], [1]]);
  });

  it("不合并：两侧偏移各自在判据内、但累加超过判据的平行墙面不串成一条", () => {
    // 0.08 m 与 -0.08 m 间隔 0.16 m：两端到对方轴的距离都超过 0.15 m 的轴间距判据。
    const { segments: merged } = mergeWallSegments([segment([0, 0], [8, 0]), segment([0, .16], [8, .16])]);
    expect(merged).toHaveLength(2);
  });

  it("不合并：方向差超判据的相交/斜向段", () => {
    const angle = DEDUPE_DIRECTION_DEG * 2 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const tilted: WallSegment = { a: [0, 0], b: [8 * c, 8 * s], support: 20, rmsM: .005 };
    expect(mergeWallSegments([segment([0, 0], [8, 0]), tilted]).segments).toHaveLength(2);
  });

  it("不合并：同轴但投影完全分离的两段（门洞等真实缺口不补墙）", () => {
    const { segments: merged } = mergeWallSegments([segment([0, 0], [3, 0]), segment([5, 0], [8, 0])]);
    expect(merged).toHaveLength(2);
    expect(merged.every(s => s.merge === null)).toBe(true);
  });

  it("不合并：垂直相交的墙各自独立", () => {
    expect(mergeWallSegments([segment([0, 0], [8, 0]), segment([4, -2], [4, 2])]).segments).toHaveLength(2);
  });

  it("合并后范围覆盖各来源段投影并集：任一来源端点都落在合并段投影内、横向偏差在判据内", () => {
    // 来源段落在骨干轴 0.05–0.07 m 的墙厚带内，都在判据内；合并后长度覆盖 0→8 m 的投影并集。
    // 带内两侧的偏移差不超过判据，因此按任务口径归入同一墙轴；累计超过判据的平行墙面见下一个用例。
    const segments = [segment([0, 0], [8, 0], 40), offset(segment([0, 0], [2, 0], 15), .01, .07), offset(segment([3, 0], [8, 0], 10), -.01, -.06)];
    // 两侧偏移差 0.13 m 仍在判据内（判据比较的是端点到轴的垂直距离，不是两侧之和）。
    const { segments: merged } = mergeWallSegments(segments);
    expect(merged).toHaveLength(1);
    const m = merged[0]!, ux = (m.b[0] - m.a[0]) / length(m), uy = (m.b[1] - m.a[1]) / length(m);
    for (const source of segments) for (const p of [source.a, source.b]) {
      const t = (p[0] - m.a[0]) * ux + (p[1] - m.a[1]) * uy, side = Math.abs((p[0] - m.a[0]) * uy - (p[1] - m.a[1]) * ux);
      expect(t).toBeGreaterThanOrEqual(-1e-9);
      expect(t).toBeLessThanOrEqual(length(m) + 1e-9);
      expect(side).toBeLessThan(DEDUPE_AXIS_GAP_M);
    }
  });

  it("输出顺序与原输入一致，未合并段原样保留", () => {
    const segments = [segment([0, 0], [3, .05]), segment([10, 10], [18, 10.05]), offset(segment([0, 0], [3, 0]), 0, .06)];
    const { segments: merged } = mergeWallSegments(segments);
    expect(merged.map(s => s.sources)).toEqual([[0, 2], [1]]);
    expect(merged[1]!.a).toEqual(segments[1]!.a);
    expect(merged[1]!.merge).toBeNull();
  });

  it("fitWallLines 返回合并结果并保留来源编号：每段来源覆盖 [0, fittedSegments) 且不重复", async () => {
    const { decodeSource } = await import("../src/pipeline/analysis");
    const { demoRoom } = await import("../src/domain/demo");
    const fitted = await fitWallLines(await decodeSource("room.pcd", demoRoom(), "m"), () => {});
    expect(fitted.fittedSegments).toBeGreaterThanOrEqual(fitted.dedupedSegments);
    // 集成后墙网连接会按 T 形节点切分墙段，同一去重段可能出现在多个子段里：按段去重后来源应恰好覆盖 [0, fittedSegments)。
    const sources = [...new Set(fitted.segments.flatMap(s => s.sources ?? []))];
    expect([...sources].sort((a, b) => a - b)).toEqual(Array.from({ length: fitted.fittedSegments }, (_, i) => i));
    expect(fitted.mergeGroups.every(g => g.sourceIndexes.length > 1)).toBe(true);
  });

  it("拟合链路：厚墙在证据里形成的第二条平行面被并入主线，不作为第二面墙输出", async () => {
    // 东墙 0.3 m 厚，证据在 x=8 与 x=7.7 各形成一道平行面（真实样本 §4.1 的成因）。
    // 去掉这层残影属于修复范围；0.3 m 本身的墙面厚度不在本次范围（诊断 §3.1 的口径未变）。
    const p: number[] = [];
    const add = (x: number, y: number, z: number) => p.push(x, y, z);
    for (let t = 0; t <= 8; t += .05) for (let z = 0; z < 3; z += .1) { add(t, 0, z); add(t, 6, z); }
    for (let t = 0; t <= 6; t += .05) for (let z = 0; z < 3; z += .1) { add(0, t, z); add(8, t, z); add(8 - .3, t, z); }
    const fitted = await fitWallLines(cloud(p), () => {});
    const sources = [...new Set(fitted.segments.flatMap(s => s.sources ?? []))];
    expect([...sources].sort((a, b) => a - b)).toEqual(Array.from({ length: fitted.fittedSegments }, (_, i) => i));
    // 每面墙只输出一条：同一位置不再出现与主线平行的第二道墙。
    // 集成后墙网连接会在 T 形节点处把同一道墙切成共线的首尾相接子段（同 dedupedIndex，投影相接），
    // 这属于期望的建网结果，不在此判据内；判据只针对"位置平行错开且投影重叠"的重复段。
    const side = (q: WallSegment, a: WallSegment, ua: P) => [Math.abs((q.a[0] - a.a[0]) * ua[1] - (q.a[1] - a.a[1]) * ua[0]), Math.abs((q.b[0] - a.a[0]) * ua[1] - (q.b[1] - a.a[1]) * ua[0])];
    for (const a of fitted.segments) for (const b of fitted.segments) if (a !== b && a.dedupedIndex !== b.dedupedIndex) {
      const la = length(a), lb = length(b), ua: P = [(a.b[0] - a.a[0]) / la, (a.b[1] - a.a[1]) / la];
      const parallel = Math.abs(ua[0] * (b.b[1] - b.a[1]) - ua[1] * (b.b[0] - b.a[0])) / lb < Math.sin(DEDUPE_DIRECTION_DEG * Math.PI / 180);
      const [sideA, sideB] = side(b, a, ua);
      // 投影区间（在 a 的轴上）是否重叠：首尾相接的共线子段允许处于同一位置。
      const projB = [0, 1].map(k => { const p = k ? b.b : b.a; return (p[0] - a.a[0]) * ua[0] + (p[1] - a.a[1]) * ua[1]; });
      const overlap = Math.min(Math.max(...projB), la) - Math.max(Math.min(...projB), 0);
      if (parallel && overlap > 1e-6) expect(Math.max(sideA, sideB)).toBeGreaterThanOrEqual(DEDUPE_AXIS_GAP_M);
    }
  });
});
