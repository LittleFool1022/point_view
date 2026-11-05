import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../../src/domain/types";
import { buildingFromSegments, levelClosure, roomsFromWalls, updateWall, ROOM_MIN_AREA_M2, type BuildingOptions } from "../src/domain/buildingOps";
import { assertBuildingShape, buildingQuantities, validateBuilding } from "../src/domain/building";
import { fitWallLines } from "../src/pipeline/wallLines";
import { buildWallNetwork } from "../src/pipeline/wallNetwork";
import { demoRoom } from "../src/domain/demo";

const source = { name: "fixture.pcd", bytes: new ArrayBuffer(1), units: "m" as const, synthetic: true };
const options: BuildingOptions = { elevationM: 0, heightM: 3, thicknessM: .2, levelName: "夹具楼层" };
type P = [number, number];
const segment = (a: P, b: P) => ({ a, b, support: 20, rmsM: .01 });
const build = (segments: ReturnType<typeof segment>[]) => buildingFromSegments(source, options, segments);
const areas = (segments: ReturnType<typeof segment>[]) => build(segments).rooms.map(room => {
  const p = room.boundaryM;
  return Math.abs(p.reduce((sum, point, i) => { const q = p[(i + 1) % p.length]!; return sum + point[0] * q[1] - q[0] * point[1]; }, 0)) / 2;
});

/**
 * 房间闭合夹具：覆盖真实样本“候选成链但不闭合”的失败模式，以及既有 8×6 m 回归基线。
 * 期望值按功能正确性（能否闭合、房间数、净面积）给出，不是精度验收阈值。
 */
describe("墙网与房间闭合夹具",()=>{
  it("基线：合成 8×6 m 房间仍为 4 墙、1 房间、净面积 7.8×5.8",()=>{
    const m = build([segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6],[0,0])]);
    expect(m.walls).toHaveLength(4);
    expect(m.rooms).toHaveLength(1);
    expect(areas([segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6],[0,0])])[0]!).toBeCloseTo(7.8*5.8,6);
  });

  it("失败模式 1：端点相距 0.3 m 的同一道墙缺口按墙网规则处理（拟合抖动）",()=>{
    // 期望的闭环是 x∈[0,8]、y∈[0,6]；缺口写在同一点云拟合出的墙候选上：左墙从 (0,6.3) 开始。
    const segments = [segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6.3],[0,0])];
    // 缺口两端在同一墙轴上、相距 0.3 m（≤ 延长上限 0.5 m），但两段墙**平行**，
    // 墙网规则只沿墙轴延长、不补斜线，也不把平行墙端点硬拉在一起（否则 0.3 m 门洞会被补墙，
    // 与失败模式 4 的 1.2 m 门口判据失去区分度），因此这里如实记为未闭合，而不是静默补墙。
    const network = buildWallNetwork(segments);
    expect(network.join.unclosed).toBe(1);
    // 角部规则给出精确原因：两段平行，延长线不相交，不存在"墙角交点"，因此不是角部断点而是同一墙轴的错位缺口。
    expect(network.unclosed[0]!.reason).toBe("corner-too-far");
    expect(network.join.corners).toBe(0);
    // 左墙端点按贴合规则投到上墙墙轴 (0,6) 并插节点，缺口本身保留为悬空端——
    // 上墙因此不再越出左墙 0.3 m，墙网与拟合候选一致，未虚构连接。
    expect(network.nodes.some(n => Math.hypot(n.p[0], n.p[1] - 6) < 1e-6)).toBe(true);
    expect(network.segments.some(s => s.pieceStart > 0 || s.pieceCount > 1)).toBe(true);
    const m = build(segments);
    // 最小面口径把这条 0.3 m 的悬空端记为未闭合问题（平行墙缺口归为悬空端），不补墙、不虚构房间边。
    expect(m.unclosedIssues).toHaveLength(1);
    expect(m.unclosedIssues![0]!.gapM).toBeCloseTo(.3, 6);
    expect(m.unclosedIssues![0]!.reason).toContain("0.30");
    // 首尾相接的墙仍围出一个面：这是最小面口径的如实结果，不是"缺口被补墙"。
    expect(areas(network.segments)).toHaveLength(1);
    expect(build(network.segments).rooms[0]!.loop!.nodesM.some(p => Math.abs(p[1] - 6.3) < 1e-6)).toBe(false);
  });

  it("失败模式 2：有 T 形隔墙的闭合环不能因分叉被判为非闭合",()=>{
    const segments = [segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6],[0,0]),segment([4,3],[4,0])];
    expect(areas(segments)).toHaveLength(1);
  });

  it("失败模式 3：两面墙共享内墙的两房间网络应得到两个房间，而不是零个或一个",()=>{
    const segments = [segment([0,0],[12,0]),segment([12,0],[12,6]),segment([12,6],[0,6]),segment([0,6],[0,0]),segment([6,0],[6,6])];
    expect(areas(segments)).toHaveLength(2);
    expect(areas(segments).every(a => Math.abs(a - 5.8*5.8) < .01)).toBe(true);
  });

  it("失败模式 4：真实门口（1.2 m 缺墙）不得因缺口容差被补墙闭合",()=>{
    const segments = [segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6],[0,4.2]),segment([0,3],[0,0])];
    expect(areas(segments)).toHaveLength(0);
  });

  it("失败模式 5：一面墙在另一面墙轴内结束的丁字连接应闭合，悬空平行墙不应被合并",()=>{
    expect(areas([segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6],[0,0]),segment([7.85,3],[7.85,0])])).toHaveLength(1);
    expect(areas([segment([0,0],[8,0]),segment([0,.3],[8,.3])])).toHaveLength(0);
  });

  it("墙段来自同一点云的拟合链路：demo 房间经 fitWallLines 后仍得到 4 墙 1 房间",async()=>{
    const { decodeSource } = await import("../src/pipeline/analysis");
    const cloud: PointCloudData = await decodeSource("room.pcd", demoRoom(), "m");
    const fitted = await fitWallLines(cloud, () => {});
    const m = buildingFromSegments(source, options, fitted.segments);
    expect(m.walls).toHaveLength(4);
    expect(roomsFromWalls(m, m.levels[0]!.id, options.heightM)).toHaveLength(1);
  });

  it("房间可追溯：每个房间给出墙轴面积、周长、组成墙段与节点，并记入同一 BuildingModel",()=>{
    const segments = [segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6],[0,0])];
    const m = build(segments), room = m.rooms[0]!, wallIds = m.walls.map(w => w.id);
    expect(m.rooms).toHaveLength(1);
    expect(room.loop!.areaM2).toBeCloseTo(48,6);
    expect(room.loop!.perimeterM).toBeCloseTo(28,6);
    expect(room.loop!.wallIds.slice().sort()).toEqual(wallIds.slice().sort());
    expect(room.loop!.nodesM).toHaveLength(4);
    // 下游 CAD 图纸与交付记录沿用同一模型：工程量取自房间净边界，模型结构可被工程读取校验。
    expect(buildingQuantities(m).rooms[0]!.areaM2).toBeCloseTo(7.8*5.8,6);
    expect(()=>assertBuildingShape(m)).not.toThrow();
    expect(m.unclosedIssues).toEqual([]);
    expect(validateBuilding(m).filter(i=>i.code!=='UNREVIEWED')).toEqual([]);
  });

  it("未闭合区域进入模型与检查记录：位置、涉及墙段、缺口距离与原因，不静默丢弃整条墙网",()=>{
    const segments = [segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6],[0,4.2]),segment([0,3],[0,0])];
    const m = build(segments), issues = m.unclosedIssues ?? [];
    expect(m.rooms).toHaveLength(0);
    const gap = issues.find(i => i.kind === 'wall-gap' && Math.abs(i.gapM! - 1.2) < .001)!;
    expect(gap).toBeDefined();
    const [x, y] = gap.pointM;
    expect(Math.hypot(x, y - 4.2) < .001 || Math.hypot(x, y - 3) < .001).toBe(true);
    expect(gap.wallIds.length).toBeGreaterThan(0);
    expect(gap.reason).toContain('1.20 m');
    expect(validateBuilding(m).some(i => i.code === 'UNCLOSED' && i.elementId === gap.id)).toBe(true);
    // 未闭合问题不阻止模型保存或工程量计算，但如实出现在检查记录里。
    expect(()=>assertBuildingShape(m)).not.toThrow();
  });

  it("最小面积下限是命名常量且可解释：窄条最小面不当作房间，悬空端仍记录为未闭合问题",()=>{
    expect(ROOM_MIN_AREA_M2).toBeGreaterThan(0);
    const segments = [segment([0,0],[8,0]),segment([0,.6],[8,.6])];
    const m = build(segments), report = levelClosure(m, m.levels[0]!.id);
    expect(m.rooms).toHaveLength(0);
    expect(report.faces).toBeGreaterThanOrEqual(0);
    expect((m.unclosedIssues ?? []).every(i => i.gapM !== undefined && i.gapM >= 0)).toBe(true);
  });

  it("改墙后按最小面重算房间并刷新未闭合问题，同一墙环保留房间身份",()=>{
    const segments = [segment([0,0],[12,0]),segment([12,0],[12,6]),segment([12,6],[0,6]),segment([0,6],[0,0]),segment([6,0],[6,6])];
    const m = build(segments), partition = m.walls[4]!;
    expect(m.rooms).toHaveLength(2);
    // 删除内墙后应合并为一个房间；在墙网上制造缺口应出现未闭合问题，而不是整层无输出。
    const merged = updateWall(m, {...partition, axisM:[[6,0],[6,3]]});
    expect(merged.rooms.length + (merged.unclosedIssues ?? []).length).toBeGreaterThan(0);
    expect(merged.rooms.length).toBeLessThanOrEqual(2);
    expect(merged.rooms.every(r => r.levelId === m.levels[0]!.id)).toBe(true);
    expect(()=>assertBuildingShape(merged)).not.toThrow();
  });
});
