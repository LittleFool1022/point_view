import { describe, expect, it } from "vitest";
import { demoRoom } from "../src/domain/demo";
import {
  assessImportExtents, MAX_HEIGHT_M, MAX_HORIZONTAL_EXTENT_M, MIN_HORIZONTAL_EXTENT_M,
} from "../src/domain/importCheck";
import { readCloud } from "../src/pipeline/binaryPcd";

const room = { min: [0, 0, .2] as [number, number, number], max: [8, 6, 2.6] as [number, number, number] };
const mmRoom = { min: [0, 0, 200] as [number, number, number], max: [8000, 6000, 2800] as [number, number, number] };

describe("导入单位与范围核对", () => {
  it("正常米制房间不告警，并给出完整 X×Y×Z 范围与点数", () => {
    const check = assessImportExtents(room, 7_332);
    expect(check).toMatchObject({ valid: true, suspicious: false, pointCount: 7_332 });
    expect(check.sizeM[0]).toBeCloseTo(8, 6);
    expect(check.sizeM[1]).toBeCloseTo(6, 6);
    expect(check.sizeM[2]).toBeCloseTo(2.4, 6);
    expect(check.reasons).toEqual([]);
  });

  it("毫米坐标误按米解码时告警，但不自动换算", () => {
    const check = assessImportExtents(mmRoom, 7_896);
    expect(check).toMatchObject({ valid: true, suspicious: true, pointCount: 7_896 });
    expect(check.sizeM).toEqual([8000, 6000, 2600]);
    expect(check.reasons.some(reason => reason.includes("水平范围 8000.00 m"))).toBe(true);
    expect(check.reasons.some(reason => reason.includes("高度 2600.00 m"))).toBe(true);
  });

  it("水平超长、超高与过小范围分别提示，阈值边界保持宽松", () => {
    expect(assessImportExtents({ min: [0, 0, 0], max: [MAX_HORIZONTAL_EXTENT_M + .01, 10, 3] }, 100).suspicious).toBe(true);
    expect(assessImportExtents({ min: [0, 0, 0], max: [MAX_HORIZONTAL_EXTENT_M, 10, 3] }, 100).suspicious).toBe(false);
    expect(assessImportExtents({ min: [0, 0, 0], max: [10, 10, MAX_HEIGHT_M + .01] }, 100).suspicious).toBe(true);
    expect(assessImportExtents({ min: [0, 0, 0], max: [10, 10, MAX_HEIGHT_M] }, 100).suspicious).toBe(false);
    expect(assessImportExtents({ min: [0, 0, 0], max: [MIN_HORIZONTAL_EXTENT_M - .01, MIN_HORIZONTAL_EXTENT_M - .01, 1] }, 100).suspicious).toBe(true);
    expect(assessImportExtents({ min: [0, 0, 0], max: [MIN_HORIZONTAL_EXTENT_M, MIN_HORIZONTAL_EXTENT_M, 1] }, 100).suspicious).toBe(false);
  });

  it("空、缺失、非有限或颠倒的范围判为无效并要求核对", () => {
    for (const bounds of [undefined, { min: [0, 0, 0], max: [NaN, 1, 1] } as any,
      { min: [5, 0, 0], max: [1, 1, 1] } as any]) {
      const check = assessImportExtents(bounds, 10);
      expect(check.valid).toBe(false);
      expect(check.suspicious).toBe(true);
      expect(check.reasons.length).toBeGreaterThan(0);
      expect(check.sizeM).toEqual([0, 0, 0]);
    }
    const empty = assessImportExtents(room, 0);
    expect(empty.valid).toBe(false);
    expect(empty.suspicious).toBe(true);
    expect(empty.reasons.some(reason => reason.includes("源点数"))).toBe(true);
  });

  it("完整源文件解码回传的米制范围可直接用于核对", async () => {
    const bytes = demoRoom();
    const decoded = await readCloud(
      { name: "room.pcd", bytes }, "m",
      async (offset, size) => bytes.slice(offset, offset + size),
      () => {},
    );
    expect(decoded.cloud.sourcePointCount).toBe(7_332);
    for (let i = 0; i < 3; i++) expect(decoded.bounds.min[i]).toBeCloseTo(room.min[i]!, 6);
    expect(decoded.bounds.max[0]).toBeCloseTo(room.max[0], 6);
    expect(decoded.bounds.max[1]).toBeCloseTo(room.max[1], 6);
    expect(decoded.bounds.max[2]).toBeCloseTo(room.max[2], 6);
    expect(assessImportExtents(decoded.bounds, decoded.cloud.sourcePointCount!).suspicious).toBe(false);
  });
});
