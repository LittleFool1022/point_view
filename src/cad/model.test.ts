import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../domain/types";
import { buildDrawingModel, validateDrawingModel } from "./model";

function fixture(): PointCloudData {
  return {
    id: "room-fixture", frameId: "LOCAL_ENU", stampNs: 0n,
    positions: new Float32Array([0,0,0, 2,0,0, 2,1,0, 0,1,0]),
    colors: new Uint8Array(12), visible: new Uint8Array([1,1,1,1]),
  };
}

function wallFixture(): PointCloudData {
  const points: number[][] = [];
  for (let layer = 0; layer < 5; layer += 1) {
    const z = .3 + layer * .4;
    for (let step = 0; step <= 40; step += 1) {
      const x = step * .05;
      if (x <= .8 || x >= 1.2) points.push([x, 0, z]);
      points.push([x, 1, z]);
    }
    for (let step = 0; step <= 20; step += 1) {
      const y = step * .05;
      points.push([0, y, z], [2, y, z]);
    }
  }
  return { id: "wall-fixture", frameId: "LOCAL_ENU", stampNs: 0n, positions: new Float32Array(points.flat()), colors: new Uint8Array(points.length * 3), visible: new Uint8Array(points.map(() => 1)) };
}

function gappedWallFixture(): PointCloudData {
  const points: number[][] = [];
  for (let layer = 0; layer < 6; layer += 1) {
    const z = .3 + layer * .4;
    for (let step = 0; step <= 160; step += 1) {
      const x = step * .05;
      if (x <= 2 || x >= 6) points.push([x, 0, z]);
      points.push([x, 4, z]);
    }
    for (let step = 0; step <= 80; step += 1) {
      const y = step * .05;
      points.push([0, y, z], [8, y, z]);
    }
  }
  return { id: "gapped-wall-fixture", frameId: "LOCAL_ENU", stampNs: 0n, positions: new Float32Array(points.flat()), colors: new Uint8Array(points.length * 3), visible: new Uint8Array(points.map(() => 1)) };
}

describe("CAD DrawingModel", () => {
  it("converts metre geometry to millimetres exactly once and emits straight wall entities", () => {
    const model = buildDrawingModel({ cloud: wallFixture(), projection: "xy", drawingId: "drawing-1", generatedAt: "2026-09-01T00:00:00.000Z" });
    const observed = model.entities.find((entity) => entity.layer === "OBSERVED_WALL" && entity.type === "line");
    expect(model.units).toBe("mm");
    expect(model.sourceSummary.width).toBeCloseTo(2);
    expect(observed?.type === "line" ? Math.max(...observed.start, ...observed.end) : 0).toBeGreaterThan(2);
    expect(model.entities.filter((entity) => entity.category === "wall").every((entity) => entity.type === "line")).toBe(true);
    expect(model.statistics.inferredWallEntities).toBe(0);
    expect(model.parameters.inferWallGaps).toBe(false);
    expect(model.warnings.some((warning) => warning.code === "EVIDENCE_MAP_DRIVEN")).toBe(true);
    expect(model.warnings.some((warning) => warning.code === "ORTHOGONAL_WALL_FIT")).toBe(true);
  });

  it("only emits inferred gap helpers after explicit opt-in", () => {
    const strict = buildDrawingModel({ cloud: gappedWallFixture(), projection: "xy" });
    const assisted = buildDrawingModel({ cloud: gappedWallFixture(), projection: "xy", settings: { inferWallGaps: true } });
    expect(strict.statistics.inferredWallEntities).toBe(0);
    expect(strict.warnings.some((warning) => warning.code === "INFERRED_CONTENT")).toBe(false);
    expect(assisted.statistics.inferredWallEntities).toBeGreaterThan(0);
    expect(assisted.warnings.some((warning) => warning.code === "INFERRED_CONTENT")).toBe(true);
  });

  it("emits regular horizontal/vertical wall lines for front and side views", () => {
    for (const projection of ["xz", "yz"] as const) {
      const model = buildDrawingModel({ cloud: wallFixture(), projection, settings: { minRegionCells: 1, minCellPoints: 1 } });
      const walls = model.entities.filter((entity) => entity.category === "wall");
      expect(walls.length).toBeGreaterThan(0);
      expect(walls.every((entity) => entity.type === "line")).toBe(true);
      expect(walls.every((entity) => entity.type === "line" && (entity.start[0] === entity.end[0] || entity.start[1] === entity.end[1]))).toBe(true);
      expect(model.warnings.some((warning) => warning.code === "ORTHOGONAL_WALL_FIT")).toBe(true);
    }
  });

  it("uses the same lineweight but different line type and color for observed/inferred walls", () => {
    const model = buildDrawingModel({ cloud: fixture(), projection: "xy" });
    const observed = model.layers.find((layer) => layer.name === "OBSERVED_WALL")!;
    const inferred = model.layers.find((layer) => layer.name === "INFERRED_WALL")!;
    expect(observed.lineWidthMm).toBe(inferred.lineWidthMm);
    expect(observed.lineType).toBe("CONTINUOUS");
    expect(inferred.lineType).toBe("DASHED");
    expect(observed.color).not.toBe(inferred.color);
  });

  it("keeps manual annotation identity and complete title/accuracy metadata", () => {
    const model = buildDrawingModel({
      cloud: fixture(), projection: "xy",
      annotations: [{ id: "room-014", category: "room", text: "客厅", x: 1, y: .5 }],
      sourceCoordinateSystem: "LOCAL_ENU", topPlaneToleranceM: .2,
    });
    expect(model.annotations[0]).toMatchObject({ id: "room-014", category: "room", source: "manual", confidence: "confirmed" });
    expect(model.annotations[0]?.geometry.pointMm).toEqual([1_000, 500]);
    expect(model.titleBlock.units).toBe("mm");
    expect(model.titleBlock.evidenceNote).toContain("无证据缺口保持断开");
    expect(model.accuracy.topPlaneToleranceMm).toBe(200);
    expect(model.accuracy.registrationStatus).toBe("not-provided");
  });

  it("rejects non-finite entity coordinates before export", () => {
    const model = buildDrawingModel({ cloud: fixture(), projection: "xy" });
    const line = model.entities.find((entity) => entity.type === "line");
    if (line?.type === "line") line.start[0] = Number.NaN;
    const report = validateDrawingModel(model);
    expect(report.valid).toBe(false);
    expect(report.errors.some((error) => error.code === "NON_FINITE_COORDINATE")).toBe(true);
  });
});
