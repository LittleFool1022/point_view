import { open, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { readCloud } from "../src/pipeline/binaryPcd";
import { generateLargeDrawing } from "../src/pipeline/largeDrawing";
import { createCadDelivery } from "../../src/cad/package";
import { readRealFixture } from "./real-fixture";
const { SourceStore } = createRequire(import.meta.url)("../electron/source-store.cjs");
type ValidationStage={projection:string;ok:boolean;seconds:number;entities?:number;walls?:number;parameters?:unknown;error?:string};
interface ValidationResult {mode:string;sourceFile:string;fixture:string;runtime:{node:string;platform:string;arch:string};stages:ValidationStage[];checks:string[];peakRssBytes:number;constructionAccepted:false;independentDimensions:string;importSeconds?:number;points?:number;previewPoints?:number;bounds?:unknown;saveRestoreSeconds?:number;sourceSha256?:string;geometryIncomplete?:boolean;failure?:string}
const fixture=await readRealFixture();
const sourceFile = process.env.SURVEY_REAL_FIXTURE ?? fixture.source;
const output = process.env.SURVEY_VALIDATION_OUTPUT ?? "artifacts/large-data-local"; await mkdir(output, { recursive: true });
const result: ValidationResult = { mode: "projection-review-only", sourceFile, fixture: fixture.filename, runtime: { node: process.version, platform: process.platform, arch: process.arch }, stages: [], checks: [], peakRssBytes: 0, constructionAccepted: false, independentDimensions: "not-provided" };
const store = new SourceStore(); let stage = "";
const progress = (s: string) => { result.peakRssBytes = Math.max(result.peakRssBytes, process.memoryUsage().rss); const prefix = s.replace(/\s\d+%$/, ""); if (prefix !== stage) { stage = prefix; console.log(s); } };
try {
  const started = performance.now(), native = await store.register(sourceFile);
  if (native.size!==fixture.bytes||native.sha256 !== fixture.sha256) throw Error("Fixture size or hash differs from approved original");
  const decoded = await readCloud({ name: native.name, native }, "m", (offset, size) => store.read(native.token, offset, size), progress);
  result.importSeconds = (performance.now() - started) / 1000; result.points = decoded.cloud.visible.length; result.previewPoints = decoded.preview.visible.length; result.bounds = decoded.bounds;
  if (result.points !== fixture.points || result.previewPoints > 120000 || decoded.cloud.positions.length !== fixture.points*3) throw Error("Full point count mismatch");
  const handle = await open(sourceFile, "r"), tail = Buffer.alloc(fixture.pointStrideBytes); await handle.read(tail, 0, fixture.pointStrideBytes, fixture.headerBytes + (fixture.points-1) * fixture.pointStrideBytes); await handle.close();
  for (let i = 0; i < 3; i++) if (decoded.cloud.positions[(fixture.points-1)*3 + i] !== tail.readFloatLE(i * 4)) throw Error("Last source coordinate mismatch");
  const rgb = tail.readUInt32LE(12); if (decoded.cloud.colors[(fixture.points-1)*3] !== ((rgb >>> 16) & 255)) throw Error("Last source RGB mismatch");
  result.checks.push(`完整 ${fixture.points.toLocaleString()} 点、12 万点预览和末点原始坐标/RGB`);
  for (const projection of ["xy", "xz", "yz"] as const) {
    const start = performance.now();
    try {
      const model = await generateLargeDrawing(decoded, native.name, projection, { orthogonalizeWalls: false }, progress);
      const params = model.parameters as {contributedPoints?:number};
      if (params.contributedPoints !== fixture.points || model.statistics.sourcePointCount !== fixture.points) throw Error("Analysis count mismatch");
      const delivery = await createCadDelivery(model, `real-${projection}`); await writeFile(`${output}/real-${projection}.zip`, delivery.archive);
      result.stages.push({ projection, ok: true, seconds: (performance.now() - start) / 1000, entities: model.entities.length, walls: model.statistics.observedWallEntities, parameters: model.parameters });
    } catch (e) { result.stages.push({ projection, ok: false, seconds: (performance.now() - start) / 1000, error: String(e) }); }
  }
  const project = `${output}/真实原件工程.pvplan`, saveStart = performance.now();
  await store.saveProject(native.token, project, { source: { units: "m", synthetic: false }, projection: "xy", settings: {}, annotations: [] });
  const restored = await store.openProject(project);
  if (restored.native.sha256 !== native.sha256 || restored.native.size !== native.size) throw Error("Project roundtrip mismatch");
  result.saveRestoreSeconds = (performance.now() - saveStart) / 1000; result.sourceSha256 = native.sha256; result.checks.push("流式工程原件保存/重开 SHA256 一致");
  if (result.stages.some(s => !s.ok)) { result.geometryIncomplete = true; process.exitCode = 2; }
} catch (e) { result.failure = String(e); console.error(e); process.exitCode = 1; }
finally { result.peakRssBytes = Math.max(result.peakRssBytes, process.memoryUsage().rss); await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2)); await store.close(); console.log(JSON.stringify(result, null, 2)); }
