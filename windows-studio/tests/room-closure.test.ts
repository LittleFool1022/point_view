import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../../src/domain/types";
import { buildingFromSegments, roomsFromWalls, type BuildingOptions } from "../src/domain/buildingOps";
import { fitWallLines } from "../src/pipeline/wallLines";
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

  it("失败模式 1：端点相距 0.3 m 的同一道墙缺口不再被当作断开（拟合抖动）",()=>{
    const segments = [segment([0,0],[8,0]),segment([8,0],[8,6]),segment([8,6],[0,6]),segment([0,6.3],[0,0])];
    expect(areas(segments)).toHaveLength(1);
    expect(build(segments).rooms[0]!.boundaryM.every(p => Math.abs(p[0]) < 8 && Math.abs(p[1]) < 6.3)).toBe(true);
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
});
