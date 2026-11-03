import type { PointCloudData } from "../../../src/domain/types";
import type { DrawingModel, CadDrawingSettings } from "../../../src/cad/model";
import type { CadProjection } from "../../../src/cad/geometry";
import { generateWallDrawing } from "./wallLines";
import { generateDrawing } from "./analysis";
import type { DecodedSource } from "./binaryPcd";

/** 所有源点参与网格矩累积；在有界结果上拟合，避免千万级 JS 索引数组。 */
export async function generateLargeDrawing(decoded: DecodedSource, name: string, projection: CadProjection, settings: Partial<CadDrawingSettings>, progress: (stage: string) => void): Promise<DrawingModel> {
  const original = decoded.cloud, count = original.visible.length;
  if (projection === "xy" && settings.orthogonalizeWalls !== false) return generateWallDrawing(original, name, settings, progress);
  if (count <= 500_000) return generateDrawing(original, name, projection, settings);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) if (original.visible[i]) for (let k = 0; k < 3; k++) { const v = original.positions[i * 3 + k]!; min[k] = Math.min(min[k]!, v); max[k] = Math.max(max[k]!, v); }
  const dims = [256, 256, 32];
  const buckets = 256 * 256 * 32;
  const counts = new Uint32Array(buckets), x = new Float64Array(buckets), y = new Float64Array(buckets), z = new Float64Array(buckets);
  const scale = dims.map((n, i) => (n - 1) / Math.max(max[i]! - min[i]!, 1e-9));
  let contributed = 0;
  for (let i = 0; i < count; i++) {
    if (!original.visible[i]) continue;
    const px = original.positions[i * 3]!, py = original.positions[i * 3 + 1]!, pz = original.positions[i * 3 + 2]!;
    const ix = Math.max(0, Math.min(255, Math.floor((px - min[0]) * scale[0]!))), iy = Math.max(0, Math.min(255, Math.floor((py - min[1]) * scale[1]!))), iz = Math.max(0, Math.min(31, Math.floor((pz - min[2]) * scale[2]!)));
    const key = (iz * 256 + iy) * 256 + ix;
    counts[key]++; x[key] += px; y[key] += py; z[key] += pz; contributed++;
    if (i % 500_000 === 0) { progress(`完整点集网格聚合 ${Math.floor(i / count * 100)}%`); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  let occupied = 0; for (const c of counts) if (c) occupied++;
  if (occupied > 500_000) throw Error(`聚合结果仍有 ${occupied.toLocaleString()} 个单元，请按建筑区域分区分析；原始点云已保留。`);
  const positions = new Float32Array(occupied * 3); let cursor = 0;
  for (let i = 0; i < buckets; i++) if (counts[i]) { positions[cursor * 3] = x[i]! / counts[i]!; positions[cursor * 3 + 1] = y[i]! / counts[i]!; positions[cursor * 3 + 2] = z[i]! / counts[i]!; cursor++; }
  const aggregate: PointCloudData = { id: original.id, frameId: original.frameId, stampNs: 0n, positions, colors: new Uint8Array(occupied * 3), visible: new Uint8Array(occupied).fill(1) };
  progress("从聚合证据生成工程图");
  const model = generateDrawing(aggregate, name, projection, settings);
  if (settings.orthogonalizeWalls === false) model.warnings.push({ code: "PROJECTION_REVIEW_ONLY", severity: "warning", message: "当前为投影占据轮廓，可能包含家具、植被及其他物体，不代表已识别建筑墙体。" });
  model.statistics.sourcePointCount = count;
  model.sourceSummary = { ...model.sourceSummary, pointCount: count, bounds: { min: [...min], max: [...max] }, width: max[0] - min[0], depth: max[1] - min[1], height: max[2] - min[2], volumeM3: (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]) };
  model.warnings.push({ code: "FULL_SOURCE_GRID_AGGREGATION", severity: "warning", message: `${contributed.toLocaleString()} 个源点参与 ${occupied.toLocaleString()} 个网格质心聚合；墙带拟合基于聚合点，非逐点拟合，方向估计最多使用 6 万参考点。` });
  Object.assign(model.parameters, { analysisMode: "full-source-grid-moments", analysisSourcePoints: count, contributedPoints: contributed, aggregateCells: occupied, aggregateGrid: dims, aggregateCellSizeM: dims.map((d, i) => (max[i]! - min[i]!) / (d - 1)), directionReferenceBudget: 60000 });
  model.titleBlock.evidenceNote += "；完整源点网格聚合，详见成果参数";
  return model;
}
