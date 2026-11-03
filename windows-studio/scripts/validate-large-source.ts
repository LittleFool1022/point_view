import { open, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { readCloud } from "../src/pipeline/binaryPcd";
import { generateLargeDrawing } from "../src/pipeline/largeDrawing";
import { createCadDelivery } from "../../src/cad/package";
const { SourceStore } = createRequire(import.meta.url)("../electron/source-store.cjs");
const sourceFile = process.env.SURVEY_REAL_FIXTURE;
if (!sourceFile) throw Error("Set SURVEY_REAL_FIXTURE to the original real binary PCD.");
const output = "artifacts/large-data-local"; await mkdir(output, { recursive: true });
const result: any = { mode: "projection-review-only", sourceFile, stages: [], checks: [], peakRssBytes: 0 };
const store = new SourceStore(); let stage = "";
const progress = (s: string) => { result.peakRssBytes = Math.max(result.peakRssBytes, process.memoryUsage().rss); const prefix = s.replace(/\s\d+%$/, ""); if (prefix !== stage) { stage = prefix; console.log(s); } };
try {
  const started = performance.now(), native = await store.register(sourceFile);
  if (native.sha256 !== "6194be9e2bc4ac14f1116bbc206c56dfbec7ded45b2b07bba497904de669293a") throw Error("Fixture hash differs from approved original");
  const decoded = await readCloud({ name: native.name, native }, "m", (offset, size) => store.read(native.token, offset, size), progress);
  result.importSeconds = (performance.now() - started) / 1000; result.points = decoded.cloud.visible.length; result.previewPoints = decoded.preview.visible.length; result.bounds = decoded.bounds;
  if (result.points !== 20000000 || result.previewPoints > 120000 || decoded.cloud.positions.length !== 60000000) throw Error("Full point count mismatch");
  const handle = await open(sourceFile, "r"), tail = Buffer.alloc(40); await handle.read(tail, 0, 40, 584 + 19999999 * 40); await handle.close();
  for (let i = 0; i < 3; i++) if (decoded.cloud.positions[59999997 + i] !== tail.readFloatLE(i * 4)) throw Error("Last source coordinate mismatch");
  const rgb = tail.readUInt32LE(12); if (decoded.cloud.colors[59999997] !== ((rgb >>> 16) & 255)) throw Error("Last source RGB mismatch");
  result.checks.push("完整 2000 万点、12 万点预览和末点原始坐标/RGB");
  for (const projection of ["xy", "xz", "yz"] as const) {
    const start = performance.now();
    try {
      const model = await generateLargeDrawing(decoded, native.name, projection, { orthogonalizeWalls: false }, progress);
      const params: any = model.parameters;
      if (params.contributedPoints !== 20000000 || model.statistics.sourcePointCount !== 20000000) throw Error("Analysis count mismatch");
      const delivery = await createCadDelivery(model, `real-${projection}`); await writeFile(`${output}/real-${projection}.zip`, delivery.archive);
      result.stages.push({ projection, ok: true, seconds: (performance.now() - start) / 1000, entities: model.entities.length, walls: model.statistics.observedWallEntities, parameters: model.parameters });
    } catch (e) { result.stages.push({ projection, ok: false, seconds: (performance.now() - start) / 1000, error: String(e) }); }
  }
  const project = `${output}/真实原件工程.pvplan`, saveStart = performance.now();
  await store.saveProject(native.token, project, { source: { units: "m", synthetic: false }, projection: "xy", settings: {}, annotations: [] });
  const restored = await store.openProject(project);
  if (restored.native.sha256 !== native.sha256 || restored.native.size !== native.size) throw Error("Project roundtrip mismatch");
  result.saveRestoreSeconds = (performance.now() - saveStart) / 1000; result.sourceSha256 = native.sha256; result.checks.push("流式工程原件保存/重开 SHA256 一致");
  if (result.stages.some((s: any) => !s.ok)) { result.geometryIncomplete = true; process.exitCode = 2; }
} catch (e) { result.failure = String(e); console.error(e); process.exitCode = 1; }
finally { result.peakRssBytes = Math.max(result.peakRssBytes, process.memoryUsage().rss); await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2)); await store.close(); console.log(JSON.stringify(result, null, 2)); }
