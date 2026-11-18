import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../domain/types";
import { buildDrawingModel } from "./model";
import { createCadDelivery } from "./package";

const cloud: PointCloudData = {
  id: "delivery-fixture", frameId: "LOCAL_ENU", stampNs: 0n,
  positions: new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]),
  colors: new Uint8Array(12), visible: new Uint8Array([1,1,1,1]),
};

describe("CAD delivery package", () => {
  it("contains DXF, annotations JSON and hash manifest sourced from one DrawingModel", async () => {
    const model = buildDrawingModel({ cloud, projection: "xy", drawingId: "delivery-001", generatedAt: "2026-09-01T00:00:00.000Z" });
    const delivery = await createCadDelivery(model, "示例 CAD");
    const archive = unzipSync(delivery.archive);
    const names = Object.keys(archive);
    expect(names.some((name) => name.endsWith(".dxf"))).toBe(true);
    expect(names.some((name) => name.endsWith(".annotations.json"))).toBe(true);
    expect(names.some((name) => name.endsWith(".manifest.json"))).toBe(true);
    const dxf = strFromU8(archive[names.find((name) => name.endsWith(".dxf"))!]!);
    const annotations = JSON.parse(strFromU8(archive[names.find((name) => name.endsWith(".annotations.json"))!]!));
    const manifest = JSON.parse(strFromU8(archive[names.find((name) => name.endsWith(".manifest.json"))!]!));
    expect(dxf).toContain(model.entities[0]!.id);
    expect(annotations.drawingId).toBe(model.drawingId);
    expect(annotations.entities[0].id).toBe(model.entities[0]!.id);
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files.every((file: { sha256: string }) => file.sha256?.length === 64)).toBe(true);
  });
});

