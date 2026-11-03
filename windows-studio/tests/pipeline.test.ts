import { describe, expect, it } from "vitest";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { demoRoom } from "../src/domain/demo";
import { decodeSource, generateDrawing } from "../src/pipeline/analysis";
import { encodeProject, decodeProject } from "../src/domain/project";
import { createCadDelivery } from "../../src/cad/package";
import { applyCadAnnotations } from "../../src/cad/model";
import { validateBuilding, type BuildingModel } from "../src/domain/building";

describe("Windows 测量工程基座", () => {
  it("真实解码→毫米制图纸→标注→DXF包→含源工程往返，并拒绝源数据篡改", async () => {
    const bytes = demoRoom(), cloud = await decodeSource("room.pcd", bytes, "m");
    const drawing = generateDrawing(cloud, "room.pcd", "xy", {});
    expect(drawing.units).toBe("mm");
    expect(drawing.statistics.observedWallEntities).toBeGreaterThan(0);
    expect(drawing.statistics.inferredWallEntities).toBe(0);
    const annotations = [{ id: "room-name", text: "测量房间", x: 4000, y: 3000, coordinateSpace: "drawing-mm" as const, category: "room" as const, projection: "xy" as const }];
    const annotated = applyCadAnnotations(drawing, annotations);
    const delivery = await createCadDelivery(annotated, "工程图");
    const zip = unzipSync(delivery.archive), dxf = strFromU8(Object.entries(zip).find(([name]) => name.endsWith(".dxf"))![1]);
    expect(dxf).toContain("OBSERVED_WALL"); expect(dxf).toContain("\\U+6D4B");
    const archive = await encodeProject({ source: { name: "room.pcd", bytes, units: "m", synthetic: true }, drawing: annotated, annotations, projection: "xy", settings: {} });
    const restored = await decodeProject(archive.slice().buffer as ArrayBuffer);
    expect(restored.source.bytes).toEqual(bytes); expect(restored.drawing?.annotations[0]?.geometry.pointMm).toEqual([4000, 3000]);
    const changed = unzipSync(archive); changed["source.bin"]![0] ^= 1;
    await expect(decodeProject(zipSync(changed).buffer as ArrayBuffer)).rejects.toThrow("校验失败");
    const mmPcd = strToU8(strFromU8(new Uint8Array(bytes)).replace(/DATA ascii\n([\s\S]*)/, (_, rows: string) => "DATA ascii\n" + rows.trim().split("\n").map(row => row.split(" ").map(Number).map(x => x * 1000).join(" ")).join("\n") + "\n"));
    const mmCloud = await decodeSource("room-mm.pcd", mmPcd.buffer as ArrayBuffer, "mm");
    const mmDrawing = generateDrawing(mmCloud, "room-mm.pcd", "xy", {});
    expect(mmDrawing.sourceSummary.width).toBeCloseTo(drawing.sourceSummary.width, 4);
  });
  it("建筑模型拒绝无宿主门窗、越界尺寸和未复核构件", () => {
    const evidence = { kind: "manual" as const, sourceAssetId: "scan", revision: 1, confirmed: true };
    const model: BuildingModel = { schema: "survey-building/1", id: "b", revision: 1, units: "m", up: "Z", levels: [{ id: "l", name: "一层", elevationM: 0 }], walls: [{ id: "w", levelId: "l", axisM: [[0, 0], [4, 0]], heightM: 3, thicknessM: .2, evidence }], rooms: [], openings: [{ id: "d", kind: "door", wallId: "w", offsetM: 1, widthM: .9, heightM: 2.1, sillM: 0, evidence }] };
    expect(validateBuilding(model)).toEqual([]);
    model.openings[0]!.wallId = "missing"; expect(validateBuilding(model).some(i => i.code === "HOST_MISSING")).toBe(true);
    model.openings[0]!.wallId = "w"; model.openings[0]!.widthM = 8; expect(validateBuilding(model).some(i => i.code === "OPENING_BOUNDS")).toBe(true);
    model.walls[0]!.evidence = { ...evidence, confirmed: false }; expect(validateBuilding(model).some(i => i.code === "UNREVIEWED")).toBe(true);
  });
});
