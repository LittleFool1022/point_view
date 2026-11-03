import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../domain/types";
import { buildDrawingModel, type CadEntity, type DrawingModel } from "./model";
import { createCadLinkIndex, projectSourcePoint, sourcePoint, type CadPreviewSource } from "./linking";

function cloud(points: number[][]): PointCloudData {
  return { id: "link-fixture", frameId: "LOCAL_ENU", stampNs: 0n, positions: new Float32Array(points.flat()), colors: new Uint8Array(points.length * 3), visible: new Uint8Array(points.length).fill(1) };
}
const wall: CadEntity = { id: "wall", type: "line", start: [0, 0], end: [2000, 0], layer: "OBSERVED_WALL", category: "wall", source: "observed", confidence: "measured" };
function model(entities: CadEntity[]): DrawingModel {
  return { drawingId: "link", entities, accuracy: { gridResolutionMm: 20, roundingMm: 1 } } as DrawingModel;
}

describe("CAD source linking", () => {
  it("projects all three views in millimetres with non-origin rotation centres", () => {
    const source: CadPreviewSource = { drawingId: "link", cloud: cloud([[3, 2, 5]]), projection: "xy", planAlignment: { angleRadians: Math.PI / 2, center: [1, 2] } };
    // XY 绕 (1,2) 旋转 +90 度：(3,2,5) -> (1,4,5)。
    expect(projectSourcePoint(source, 0)?.[0]).toBeCloseTo(1000);
    expect(projectSourcePoint(source, 0)?.[1]).toBeCloseTo(4000);
    const front = projectSourcePoint({ ...source, projection: "xz" }, 0)!;
    expect(front[0]).toBeCloseTo(1000); expect(front[1]).toBe(5000);
    const side = projectSourcePoint({ ...source, projection: "yz" }, 0)!;
    expect(side[0]).toBeCloseTo(4000); expect(side[1]).toBe(5000);
    const rotated = projectSourcePoint({ ...source, projectedAlignment: { angleRadians: Math.PI / 2, center: [1, 1] } }, 0)!;
    expect(rotated[0]).toBeCloseTo(-2000); expect(rotated[1]).toBeCloseTo(1000);
  });

  it("keeps multiple depths as neighborhood candidates and never maps inferred walls", () => {
    const source: CadPreviewSource = { drawingId: "link", cloud: cloud([[1, 0, 0], [1, 0, 3], [1, 1, 1]]), projection: "xy" };
    const index = createCadLinkIndex(source, model([wall, { ...wall, id: "inferred", layer: "INFERRED_WALL", source: "inferred" }]));
    expect(index.forEntity("wall")).toMatchObject({ kind: "neighborhood", pointIndices: [0, 1] });
    expect(index.forEntity("inferred")).toMatchObject({ kind: "unmapped", pointIndices: [] });
    expect(index.forPoint(1)?.entityIds).toEqual(["wall"]);
    expect(index.forPoint(2)?.entityIds).toEqual([]);
  });

  it("restricts wall candidates to source evidence and ignores hidden/non-finite points", () => {
    const data = cloud([[1, 0, 0], [1, 0, 1], [NaN, 0, 2], [1, 0, 3]]);
    data.visible[3] = 0;
    const source: CadPreviewSource = { drawingId: "link", cloud: data, indices: [1, 2, 3], projection: "xy" };
    expect(createCadLinkIndex(source, model([wall])).forEntity("wall")?.pointIndices).toEqual([1]);
    for (const index of [-1, .5, 2, 3, 99]) expect(sourcePoint(source, index)).toBeUndefined();
  });

  it("links an exact sample without folding another depth into it", () => {
    const source: CadPreviewSource = { drawingId: "link", cloud: cloud([[1, 0, 0], [1, 0, 3]]), projection: "xy" };
    const point: CadEntity = { id: "point", type: "point", position: [1000, 0], layer: "POINT_CLOUD", category: "point-evidence", source: "observed", confidence: "measured", metadata: { sourcePointIndex: 1 } };
    const index = createCadLinkIndex(source, model([point]));
    expect(index.forEntity("point")).toMatchObject({ kind: "exact", pointIndices: [1] });
    expect(index.forPoint(0)?.entityIds).toEqual([]);
    expect(index.forPoint(1)?.entityIds).toEqual(["point"]);
  });

  it("retains real source indices and the actual projection used by drawing generation", () => {
    const points: number[][] = [];
    for (let z = .3; z < 2; z += .4) for (let step = 0; step <= 40; step++) {
      const x = step * .05;
      points.push([x, 0, z], [x, 1, z], [0, x / 2, z], [2, x / 2, z]);
    }
    let source: CadPreviewSource | undefined;
    const drawing = buildDrawingModel({ cloud: cloud(points), projection: "xz", settings: { includePoints: true, minRegionCells: 1, minCellPoints: 1 }, onPreviewSource: value => { source = value; } });
    expect(source?.drawingId).toBe(drawing.drawingId);
    const samples = drawing.entities.filter(entity => entity.type === "point" && entity.layer === "POINT_CLOUD");
    expect(samples.length).toBeGreaterThan(0);
    for (const entity of samples) {
      const index = entity.metadata!.sourcePointIndex as number;
      const projected = projectSourcePoint(source!, index)!;
      if (entity.type !== "point") continue;
      expect(Math.abs(projected[0] - entity.position[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(projected[1] - entity.position[1])).toBeLessThanOrEqual(1);
      expect(source!.indices).toContain(index);
    }
  });
});
