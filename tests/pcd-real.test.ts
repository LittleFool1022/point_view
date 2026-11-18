import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePcd } from "../src/domain/pcd";
import { buildDrawingModel } from "../src/cad/model";

function load(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pointsInHeader(path: string): number {
  const header = readFileSync(path).subarray(0, 32_768).toString("ascii");
  const match = /^POINTS\s+(\d+)/m.exec(header);
  if (!match) throw new Error(`PCD 缺少 POINTS：${path}`);
  return Number(match[1]);
}

describe("真实 PCD 回归", () => {
  it.skipIf(!process.env.PCD_REAL_FIXTURE)("移动端预算加载 Point View binary PCD", () => {
    const cloud = parsePcd(load(process.env.PCD_REAL_FIXTURE!), "real-binary", { maxPoints: 1_000_000 });
    expect(cloud.sourcePointCount).toBe(3_994_088);
    expect(cloud.positions.length / 3).toBe(1_000_000);
    expect(cloud.positions.every(Number.isFinite)).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.PCD_COMPRESSED_FIXTURE)("采样加载 PCL binary_compressed PCD", () => {
    const path = process.env.PCD_COMPRESSED_FIXTURE!;
    const cloud = parsePcd(load(path), "real-compressed", { maxPoints: 10_000 });
    expect(cloud.sourcePointCount).toBe(pointsInHeader(path));
    expect(cloud.positions.length / 3).toBe(10_000);
    expect(cloud.positions.every(Number.isFinite)).toBe(true);
    expect(cloud.colors.length).toBe(30_000);
  }, 60_000);

  it.skipIf(!process.env.CAD_REAL_FIXTURE)("真实室内点云的三视图均生成无锯齿正交 CAD 墙线", () => {
    const path = process.env.CAD_REAL_FIXTURE!;
    const cloud = parsePcd(load(path), "cad-real", { maxPoints: 1_000_000 });
    expect(cloud.sourcePointCount).toBe(pointsInHeader(path));
    for (const projection of ["xy", "xz", "yz"] as const) {
      const model = buildDrawingModel({ cloud, projection, sourceName: path });
      const walls = model.entities.filter((entity) => entity.category === "wall");
      expect(walls.length).toBeGreaterThan(3);
      expect(walls.every((entity) => entity.type === "line")).toBe(true);
      expect(walls.every((entity) => entity.type === "line" && (entity.start[0] === entity.end[0] || entity.start[1] === entity.end[1]))).toBe(true);
      expect(walls.some((entity) => entity.layer === "OBSERVED_WALL")).toBe(true);
      expect(walls.some((entity) => entity.layer === "INFERRED_WALL")).toBe(false);
      expect(model.statistics.inferredWallEntities).toBe(0);
      expect(model.parameters.evidenceMapMethod).toBe("vertical-persistence");
      expect(model.parameters.evidencePointCount).toBeGreaterThan(0);
      expect(model.warnings.some((warning) => warning.code === "EVIDENCE_MAP_DRIVEN")).toBe(true);
      expect(model.warnings.some((warning) => warning.code === "ORTHOGONAL_WALL_FIT")).toBe(true);
      expect(model.warnings.some((warning) => warning.code === "ORTHOGONAL_ALIGNMENT")).toBe(true);
    }
  }, 60_000);
});
