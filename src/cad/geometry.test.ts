import { describe, expect, it } from "vitest";
import { buildCadWallEvidenceMap, computeCadAlignment, computeCadSummary, computeOrthogonalCadAlignment, extractCadRegions, filterCadPointIndices, findTopPlaneIndices, fitOrthogonalWallPlan, projectCadPoint, type CadRegionResult } from "./geometry";
import type { PointCloudData } from "../domain/types";

function cloud(points: number[][]): PointCloudData {
  return { id: "test", frameId: "map", stampNs: 0n, positions: new Float32Array(points.flat()), colors: new Uint8Array(points.length * 3), visible: new Uint8Array(points.map(() => 1)) };
}

describe("CAD geometry", () => {
  it("calculates projected convex-hull area and bounds volume", () => {
    const result = computeCadSummary(cloud([[0,0,0], [2,0,0], [2,1,3], [0,1,3]]));
    expect(result?.projectedAreaM2).toBeCloseTo(2);
    expect(result?.volumeM3).toBeCloseTo(6);
  });
  it("finds a top Z band that can be hidden as an edit", () => {
    const source = cloud([[0,0,0], [1,0,0], [0,1,2], [1,1,2]]);
    const positionsBefore = [...source.positions];
    const visibleBefore = [...source.visible];
    const result = findTopPlaneIndices(source, 0.01);
    expect(result?.indices).toEqual([2, 3]);
    expect([...source.positions]).toEqual(positionsBefore);
    expect([...source.visible]).toEqual(visibleBefore);
  });
  it("keeps a dense connected block and discards an isolated cell", () => {
    const result = extractCadRegions(cloud([
      [0, 0, 0], [0.2, 0, 0], [0.4, 0, 0],
      [0, 0.2, 0], [0.2, 0.2, 0], [0.4, 0.2, 0],
      [0, 0.4, 0], [0.2, 0.4, 0], [0.4, 0.4, 0],
      [2, 2, 0],
    ]), "xy", { gridSize: 8, minRegionCells: 2 });
    expect(result?.regions).toHaveLength(1);
    expect(result?.discardedCells).toBeGreaterThan(0);
    expect(result?.regions[0]?.polygon.length).toBeGreaterThanOrEqual(4);
  });
  it("returns only points belonging to a dense CAD component", () => {
    const dense = Array.from({ length: 25 }, (_, index) => [index % 5, Math.floor(index / 5), 0]);
    const result = filterCadPointIndices(cloud([...dense, [20, 20, 0]]), "xy", {
      gridSize: 16,
      minRegionCells: 2,
      minCellPoints: 1,
    });
    expect(result).toHaveLength(25);
    expect(result).not.toContain(25);
  });
  it("finds a principal axis so a rotated office plan can be straightened", () => {
    const angle = Math.PI / 6;
    const rotate = (x: number, y: number): [number, number, number] => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), 0];
    const result = computeCadAlignment(cloud([
      rotate(-2, -0.5), rotate(2, -0.5), rotate(2, 0.5), rotate(-2, 0.5),
    ]));
    expect(result?.angleRadians).toBeCloseTo(-angle, 1);
  });
  it("finds the orthogonal wall direction despite interior noise", () => {
    const angle = Math.PI / 12;
    const rotate = (x: number, y: number, z: number): [number, number, number] => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
    const points: number[][] = [];
    for (let layer = 0; layer < 5; layer += 1) {
      const z = .4 + layer * .4;
      for (let step = 0; step <= 80; step += 1) {
        const x = -4 + step * .1;
        points.push(rotate(x, -2, z), rotate(x, 2, z));
      }
      for (let step = 0; step <= 40; step += 1) {
        const y = -2 + step * .1;
        points.push(rotate(-4, y, z), rotate(4, y, z));
      }
    }
    for (let index = 0; index < 300; index += 1) points.push(rotate((index % 20) * .08 - .8, Math.floor(index / 20) * .08 - .6, 1));
    const result = computeOrthogonalCadAlignment(cloud(points));
    expect(result?.method).toBe("wall-histogram");
    expect(result?.angleRadians).toBeCloseTo(-angle, 1);
    expect(result?.confidence).toBeGreaterThan(1.2);
  });
  it("applies one XY building alignment before all three projections", () => {
    const alignment = { angleRadians: -Math.PI / 2, center: [0, 0] as [number, number], method: "wall-histogram" as const };
    const point: [number, number, number] = [2, 1, 3];
    expect(projectCadPoint(point, "xy", alignment)).toEqual([1.0000000000000002, -2]);
    expect(projectCadPoint(point, "xz", alignment)).toEqual([1.0000000000000002, 3]);
    expect(projectCadPoint(point, "yz", alignment)).toEqual([-2, 3]);
  });
  it("builds a multi-height XY evidence map and excludes central furniture points", () => {
    const points: number[][] = [];
    for (let layer = 0; layer < 6; layer += 1) {
      const z = .2 + layer * .35;
      for (let step = 0; step <= 40; step += 1) {
        const x = step * .1;
        points.push([x, 0, z], [x, 3, z]);
      }
      for (let step = 0; step <= 30; step += 1) {
        const y = step * .1;
        points.push([0, y, z], [4, y, z]);
      }
    }
    const firstFurnitureIndex = points.length;
    for (let index = 0; index < 200; index += 1) points.push([1.8 + (index % 10) * .04, 1.3 + Math.floor(index / 10) * .02, .7 + (index % 2) * .2]);
    const result = buildCadWallEvidenceMap(cloud(points), { gridSize: 128, minRegionCells: 4, minCellPoints: 1 });
    expect(result?.method).toBe("vertical-persistence");
    expect(result?.occupiedCells).toBeGreaterThan(40);
    expect(result?.indices.length).toBeGreaterThan(0);
    expect(result?.indices.every((index) => index < firstFurnitureIndex)).toBe(true);
  });
  it("turns fragmented wall evidence into straight observed segments and inferred gaps", () => {
    const result: CadRegionResult = {
      gridSize: 100, cellSize: .05, occupiedCells: 200, discardedCells: 0, method: "vertical-persistence",
      regions: [
        { id: 0, cells: 40, areaM2: .1, bounds: { min: [0, 0], max: [1.8, .1] }, polygon: [[0,0],[1.8,0],[1.8,.1],[0,.1]], contours: [[[0,0],[1.8,0],[1.8,.1],[0,.1]]] },
        { id: 1, cells: 40, areaM2: .1, bounds: { min: [2.2, 0], max: [4, .1] }, polygon: [[2.2,0],[4,0],[4,.1],[2.2,.1]], contours: [[[2.2,0],[4,0],[4,.1],[2.2,.1]]] },
        { id: 2, cells: 60, areaM2: .15, bounds: { min: [0, 2.9], max: [4, 3] }, polygon: [[0,2.9],[4,2.9],[4,3],[0,3]], contours: [[[0,2.9],[4,2.9],[4,3],[0,3]]] },
        { id: 3, cells: 50, areaM2: .12, bounds: { min: [0, 0], max: [.1, 3] }, polygon: [[0,0],[.1,0],[.1,3],[0,3]], contours: [[[0,0],[.1,0],[.1,3],[0,3]]] },
        { id: 4, cells: 50, areaM2: .12, bounds: { min: [3.9, 0], max: [4, 3] }, polygon: [[3.9,0],[4,0],[4,3],[3.9,3]], contours: [[[3.9,0],[4,0],[4,3],[3.9,3]]] },
      ],
    };
    const plan = fitOrthogonalWallPlan(result);
    expect(plan?.observed.every((segment) => segment.end > segment.start)).toBe(true);
    expect(plan?.inferred.some((segment) => segment.side === "bottom" && segment.start < 2 && segment.end > 2)).toBe(true);
    expect(plan?.observedCoverage).toBeGreaterThan(.7);
    expect(fitOrthogonalWallPlan(result, { inferGaps: false })?.inferred).toEqual([]);
  });
});
