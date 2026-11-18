import { expect, it } from "vitest";
import { decodeProject, encodeProject } from "../src/domain/project";
import { decodeSource, generateDrawing } from "../src/pipeline/analysis";
import { demoRoom } from "../src/domain/demo";

it("工程恢复拒绝投影错配和图纸混源，允许缺少来源绑定的旧图待更新", async () => {
  const bytes = demoRoom(), cloud = await decodeSource("room.pcd", bytes, "m"), source = { name: "room.pcd", bytes, units: "m" as const, synthetic: true };
  const sourceSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  const drawing = generateDrawing(cloud, "room.pcd", "xy", {}); drawing.sourceSha256 = sourceSha256;
  const wrongProjection = await encodeProject({ source, drawing, projection: "xz", annotations: [], settings: {} });
  await expect(decodeProject(wrongProjection.slice().buffer as ArrayBuffer)).rejects.toThrow("活动投影与图纸投影不一致");

  const foreign = structuredClone(drawing); foreign.sourceSha256 = "0".repeat(64);
  const mixedSource = await encodeProject({ source, drawing: foreign, projection: "xy", annotations: [], settings: {} });
  await expect(decodeProject(mixedSource.slice().buffer as ArrayBuffer)).rejects.toThrow("图纸与源点云 SHA-256 不一致");

  const legacy = structuredClone(drawing); delete legacy.sourceSha256;
  const archive = await encodeProject({ source, drawing: legacy, projection: "xy", annotations: [], settings: {} });
  const restored = await decodeProject(archive.slice().buffer as ArrayBuffer);
  expect(restored.drawing?.sourceSha256).toBeUndefined();
  expect(restored.source.sha256).toBe(sourceSha256);
});
