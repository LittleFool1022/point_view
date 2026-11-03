import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../domain/types";
import { exportCadDxf } from "./dxf";
import { buildDrawingModel } from "./model";

function cloud(points: number[][]): PointCloudData {
  return {
    id: "fixture", frameId: "LOCAL_ENU", stampNs: 0n,
    positions: new Float32Array(points.flat()), colors: new Uint8Array(points.length * 3),
    visible: new Uint8Array(points.map(() => 1)),
  };
}

describe("CAD DXF exporter", () => {
  it("serializes the confirmed DrawingModel as millimetre UTF-8 R2007 DXF", () => {
    const model = buildDrawingModel({
      cloud: cloud([[0,0,0], [1,0,0], [1,1,0], [0,1,0]]), projection: "xy",
      annotations: [{ text: "门", x: 0.5, y: 0.5 }], drawingId: "cad-test", generatedAt: "2026-09-01T00:00:00.000Z",
    });
    const text = new TextDecoder().decode(exportCadDxf(model));
    expect(text).toContain("$ACADVER\r\n1\r\nAC1021");
    expect(text).toContain("$INSUNITS\r\n70\r\n4");
    expect(text).toContain("OBSERVED_WALL");
    expect(text).toContain("INFERRED_WALL");
    expect(text).toContain("DASHED");
    expect(text).toContain("LWPOLYLINE");
    expect(text).toContain("1001\r\nPOINTVIEW");
    expect(text).toContain("\\U+95E8");
    expect(text).toContain("50\r\n90");
  });

  it("exports point evidence only when it exists in the shared model", () => {
    const fixture = cloud([[0,0,0], [0.1,0,0], [0,0.1,0], [0.1,0.1,0]]);
    const withoutPoints = buildDrawingModel({ cloud: fixture, projection: "xy", settings: { includePoints: false } });
    const withPoints = buildDrawingModel({ cloud: fixture, projection: "xy", settings: { includePoints: true } });
    expect(new TextDecoder().decode(exportCadDxf(withoutPoints))).not.toContain("\r\nPOINT\r\n");
    expect(new TextDecoder().decode(exportCadDxf(withPoints))).toContain("\r\nPOINT\r\n");
  });

  it("keeps optional detail dimensions in the model instead of recalculating in DXF", () => {
    const fixture = cloud([[0,0,0], [1,0,0], [1,1,0], [0,1,0]]);
    const simple = buildDrawingModel({ cloud: fixture, projection: "xy", settings: { detailDimensions: false } });
    const detailed = buildDrawingModel({ cloud: fixture, projection: "xy", settings: { detailDimensions: true } });
    const simpleCount = simple.entities.filter((entity) => entity.layer === "DIM").length;
    const detailedCount = detailed.entities.filter((entity) => entity.layer === "DIM").length;
    expect(detailedCount).toBeGreaterThan(simpleCount);
    expect(new TextDecoder().decode(exportCadDxf(detailed))).toContain("R1");
  });

  it("records explicit principal-axis alignment as a DrawingModel warning", () => {
    const angle = Math.PI / 6;
    const rotate = (x: number, y: number) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), 0];
    const model = buildDrawingModel({
      cloud: cloud([rotate(-2,-.5), rotate(2,-.5), rotate(2,.5), rotate(-2,.5)]),
      projection: "xy", settings: { orthogonalizeWalls: false, alignToPrincipalAxis: true },
    });
    expect(model.warnings.some((warning) => warning.code === "PCA_ALIGNMENT")).toBe(true);
    expect(model.drawingCoordinateSystem).toBe("PCA_ALIGNED_LOCAL");
  });

  it("builds and exports a large sampled cloud without call-stack spreading", () => {
    const count = 500_001;
    const positions = new Float32Array(count * 3);
    const visible = new Uint8Array(count).fill(1);
    const colors = new Uint8Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (index % 1000) * 0.01;
      positions[index * 3 + 1] = Math.floor(index / 1000) * 0.01;
    }
    const fixture: PointCloudData = { id: "large", frameId: "map", stampNs: 0n, positions, colors, visible };
    const model = buildDrawingModel({ cloud: fixture, projection: "xy" });
    expect(() => exportCadDxf(model)).not.toThrow();
  });
});
