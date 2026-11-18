import type { PointCloudData } from "../../../src/domain/types";
import { cadEntityPoints, type DrawingModel, type CadDrawingSettings, type CadEntity } from "../../../src/cad/model";
import { computeOrthogonalCadAlignment, projectCadPoint, type CadProjection } from "../../../src/cad/geometry";
import { generateWallDrawing, type WallSegment } from "./wallLines";
import { generateDrawing } from "./analysis";
import type { DecodedSource } from "./binaryPcd";

export interface CadSourceFootprint { min: [number, number]; max: [number, number] }
function elevationOutline(model:DrawingModel):void{
  const walls=model.entities.filter(entity=>entity.category==='wall'),points=walls.flatMap(cadEntityPoints);if(!points.length)return;
  const minX=Math.min(...points.map(p=>p[0])),maxX=Math.max(...points.map(p=>p[0])),minY=Math.min(...points.map(p=>p[1])),maxY=Math.max(...points.map(p=>p[1]));
  const corners:[[number,number],[number,number],[number,number],[number,number]]=[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]];
  const lines:CadEntity[]=corners.map((start,index)=>({id:`elevation-outline-${index}`,type:'line',start,end:corners[(index+1)%4]!,layer:'INFERRED_WALL',category:'wall',source:'derived',confidence:'inferred',lineType:'CONTINUOUS',metadata:{operation:'elevation-outer-envelope'}}));
  model.entities=[...model.entities.filter(entity=>entity.category!=='wall'),...lines];model.statistics.observedWallEntities=0;model.statistics.inferredWallEntities=lines.length;
  model.warnings.push({code:'INFERRED_CONTENT',severity:'warning',message:'正/侧视图为建筑范围内点云外包络，仅表达总体宽度和高度；内部扫描纹理、家具与门窗细部未绘出，须人工复核补绘。',relatedLayer:'INFERRED_WALL'});
}

function appendHighFidelityElevationDetails(model: DrawingModel, cloud: PointCloudData, projection: Exclude<CadProjection, "xy">, orthogonalizeWalls: boolean): number {
  const planAlignment = orthogonalizeWalls ? computeOrthogonalCadAlignment(cloud) : undefined;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i]) {
    const [px, py] = projectCadPoint([cloud.positions[i * 3]!, cloud.positions[i * 3 + 1]!, cloud.positions[i * 3 + 2]!], "xy", planAlignment);
    minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
  }
  if (!Number.isFinite(minX) || maxX - minX < 0.6 || maxY - minY < 0.6) return 0;

  const cell = 0.06, margin = 0.22;
  const nx = Math.ceil((maxX - minX) / cell) + 1, ny = Math.ceil((maxY - minY) / cell) + 1, gridSize = nx * ny;
  if (gridSize > 2_000_000) return 0;
  const counts = new Uint32Array(gridSize), layers = new Uint32Array(gridSize);
  const zLow = new Float32Array(gridSize).fill(Infinity), zHigh = new Float32Array(gridSize).fill(-Infinity);
  for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i]) {
    const z = cloud.positions[i * 3 + 2]!;
    const [px, py] = projectCadPoint([cloud.positions[i * 3]!, cloud.positions[i * 3 + 1]!, z], "xy", planAlignment);
    const gx = Math.max(0, Math.min(nx - 1, Math.floor((px - minX) / cell)));
    const gy = Math.max(0, Math.min(ny - 1, Math.floor((py - minY) / cell)));
    const key = gy * nx + gx;
    counts[key]++; zLow[key] = Math.min(zLow[key]!, z); zHigh[key] = Math.max(zHigh[key]!, z);
    layers[key] |= 1 << ((Math.floor(z / 0.25) % 32 + 32) % 32);
  }

  const uMin = projection === "xz" ? minX : minY, uMax = projection === "xz" ? maxX : maxY;
  const nu = projection === "xz" ? nx : ny;
  const uActive = new Uint8Array(nu), uLow = new Float32Array(nu).fill(Infinity), uHigh = new Float32Array(nu).fill(-Infinity);
  for (let gy = 0; gy < ny; gy++) {
    const py = minY + (gy + 0.5) * cell;
    if (py <= minY + margin || py >= maxY - margin) continue;
    for (let gx = 0; gx < nx; gx++) {
      const px = minX + (gx + 0.5) * cell;
      if (px <= minX + margin || px >= maxX - margin) continue;
      const key = gy * nx + gx;
      if (counts[key]! < 5 || zHigh[key]! - zLow[key]! < 0.65) continue;
      let bits = layers[key]!, occupied = 0;
      while (bits) { bits &= bits - 1; occupied++; }
      if (occupied < 3) continue;
      const uIdx = projection === "xz" ? gx : gy;
      const uCoord = projection === "xz" ? px : py;
      if (uCoord <= uMin + margin || uCoord >= uMax - margin) continue;
      uActive[uIdx] = 1;
      uLow[uIdx] = Math.min(uLow[uIdx]!, zLow[key]!);
      uHigh[uIdx] = Math.max(uHigh[uIdx]!, zHigh[key]!);
    }
  }

  let added = 0;
  for (let i = 0; i < nu; i++) {
    if (!uActive[i]) continue;
    let end = i;
    let minZ = uLow[i]!, maxZ = uHigh[i]!;
    while (end + 1 < nu && (uActive[end + 1] || (end + 2 < nu && uActive[end + 2]))) {
      end++;
      if (uActive[end]) { minZ = Math.min(minZ, uLow[end]!); maxZ = Math.max(maxZ, uHigh[end]!); }
    }
    const leftMm = (uMin + i * cell) * 1000, rightMm = (uMin + (end + 1) * cell) * 1000;
    const lowMm = minZ * 1000, highMm = maxZ * 1000;
    const baseMeta = { operation: "elevation-interior-projection" };
    if (rightMm - leftMm < 150) {
      const xMm = (leftMm + rightMm) / 2;
      model.entities.push({ id: `elevation-interior-${added++}`, type: "line", start: [xMm, lowMm], end: [xMm, highMm], layer: "INFERRED_WALL", category: "wall", source: "derived", confidence: "inferred", lineType: "DASHED", metadata: baseMeta });
    } else {
      model.entities.push({ id: `elevation-interior-${added++}`, type: "polyline", points: [[leftMm, lowMm], [leftMm, highMm], [rightMm, highMm], [rightMm, lowMm]], closed: false, layer: "INFERRED_WALL", category: "wall", source: "derived", confidence: "inferred", lineType: "DASHED", metadata: baseMeta });
    }
    i = end;
  }
  return added;
}
/** 所有源点参与网格矩累积；在有界结果上拟合，避免千万级 JS 索引数组。 */
export async function generateLargeDrawing(decoded: DecodedSource, name: string, projection: CadProjection, settings: Partial<CadDrawingSettings>, progress: (stage: string) => void, footprint?: CadSourceFootprint, baselineWalls?: WallSegment[]): Promise<DrawingModel> {
  const original = decoded.cloud, sourcePointCount=original.visible.length;
  let drawingCloud=original;
  if(projection!=='xy'&&footprint){
    const visible=original.visible.slice();let retained=0;
    for(let i=0;i<visible.length;i++)if(visible[i]){
      const x=original.positions[i*3]!,y=original.positions[i*3+1]!;
      if(x<footprint.min[0]||x>footprint.max[0]||y<footprint.min[1]||y>footprint.max[1])visible[i]=0;else retained++;
    }
    if(retained<100)throw Error('俯视建筑范围内的立面点不足，请检查建筑范围。');
    drawingCloud={...original,visible};
  }
  const count = drawingCloud.visible.length;
  if (projection === "xy" && settings.orthogonalizeWalls !== false) return generateWallDrawing(drawingCloud, name, settings, progress, baselineWalls);
  const highFidelity = settings.autoCleanOutdoor === false && settings.autoCleanIndoor === false;
  const keepAllInterior = highFidelity || settings.autoCleanIndoor === false;
  const wallFidelity = highFidelity ? "high-fidelity" : keepAllInterior ? "interior-preserved" : "architectural-outline";
  const elevationSettings = highFidelity ? { ...settings, minCellPoints: 1, minRegionCells: 12 } : settings;

  const finalizeElevation = (model: DrawingModel, sourceCloud: PointCloudData, aggregatedMode: boolean) => {
    if (projection !== "xy") {
      if (keepAllInterior) {
        const interiorAdded = highFidelity ? appendHighFidelityElevationDetails(model, sourceCloud, projection, settings.orthogonalizeWalls !== false) : 0;
        model.statistics.observedWallEntities = model.entities.filter(e => e.category === "wall" && e.layer === "OBSERVED_WALL").length;
        model.statistics.inferredWallEntities = model.entities.filter(e => e.category === "wall" && e.layer === "INFERRED_WALL").length;
        if (interiorAdded > 0) {
          model.warnings.push({ code: "INFERRED_CONTENT", severity: "warning", relatedLayer: "INFERRED_WALL", message: `高保真立面已保留实测外轮廓，并投射 ${interiorAdded} 处室内竖向墙段（INFERRED_WALL 虚线），须结合平面图复核。` });
        }
        const suffix = highFidelity ? "high-fidelity-silhouette" : "observed-silhouette";
        Object.assign(model.parameters, {
          wallFidelity,
          analysisMode: aggregatedMode ? `elevation-${suffix}+full-source-grid-moments` : `elevation-${suffix}`,
          ...(footprint ? { analysisSourcePoints: sourcePointCount, footprint } : {}),
        });
      } else if (footprint) {
        elevationOutline(model);
        Object.assign(model.parameters, {
          wallFidelity,
          analysisMode: aggregatedMode ? "elevation-building-footprint+outer-envelope+full-source-grid-moments" : "elevation-building-footprint+outer-envelope",
          analysisSourcePoints: sourcePointCount,
          footprint,
        });
      }
      if (footprint) {
        model.statistics.sourcePointCount = sourcePointCount;
        model.warnings.push({ code: "ELEVATION_FOOTPRINT_FILTER", severity: "warning", message: "正/侧视图仅使用俯视实测墙确定的建筑 XY 范围；范围外植被不参与立面，原始点云未修改。" });
      }
    }
    return model;
  };

  if (count <= 500_000) {
    const model = generateDrawing(drawingCloud, name, projection, elevationSettings);
    return finalizeElevation(model, drawingCloud, false);
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) if (drawingCloud.visible[i]) for (let k = 0; k < 3; k++) { const v = drawingCloud.positions[i * 3 + k]!; min[k] = Math.min(min[k]!, v); max[k] = Math.max(max[k]!, v); }
  const dims = [256, 256, 32];
  const buckets = 256 * 256 * 32;
  const counts = new Uint32Array(buckets), x = new Float64Array(buckets), y = new Float64Array(buckets), z = new Float64Array(buckets);
  const scale = dims.map((n, i) => (n - 1) / Math.max(max[i]! - min[i]!, 1e-9));
  let contributed = 0;
  for (let i = 0; i < count; i++) {
    if (!drawingCloud.visible[i]) continue;
    const px = drawingCloud.positions[i * 3]!, py = drawingCloud.positions[i * 3 + 1]!, pz = drawingCloud.positions[i * 3 + 2]!;
    const ix = Math.max(0, Math.min(255, Math.floor((px - min[0]) * scale[0]!))), iy = Math.max(0, Math.min(255, Math.floor((py - min[1]) * scale[1]!))), iz = Math.max(0, Math.min(31, Math.floor((pz - min[2]) * scale[2]!)));
    const key = (iz * 256 + iy) * 256 + ix;
    counts[key]++; x[key] += px; y[key] += py; z[key] += pz; contributed++;
    if (i % 500_000 === 0) { progress(`完整点集网格聚合 ${Math.floor(i / count * 100)}%`); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  let occupied = 0; for (const c of counts) if (c) occupied++;
  if (occupied > 500_000) throw Error(`聚合结果仍有 ${occupied.toLocaleString()} 个单元，请按建筑区域分区分析；原始点云已保留。`);
  const positions = new Float32Array(occupied * 3); let cursor = 0;
  for (let i = 0; i < buckets; i++) if (counts[i]) { positions[cursor * 3] = x[i]! / counts[i]!; positions[cursor * 3 + 1] = y[i]! / counts[i]!; positions[cursor * 3 + 2] = z[i]! / counts[i]!; cursor++; }
  const aggregate: PointCloudData = { id: drawingCloud.id, frameId: drawingCloud.frameId, stampNs: 0n, positions, colors: new Uint8Array(occupied * 3), visible: new Uint8Array(occupied).fill(1) };
  progress("从聚合证据生成工程图");
  const model = generateDrawing(aggregate, name, projection, elevationSettings);
  if (settings.orthogonalizeWalls === false) model.warnings.push({ code: "PROJECTION_REVIEW_ONLY", severity: "warning", message: "当前为投影占据轮廓，可能包含家具、植被及其他物体，不代表已识别建筑墙体。" });
  model.statistics.sourcePointCount = sourcePointCount;
  model.sourceSummary = { ...model.sourceSummary, pointCount: contributed, bounds: { min: [...min], max: [...max] }, width: max[0] - min[0], depth: max[1] - min[1], height: max[2] - min[2], volumeM3: (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]) };
  Object.assign(model.parameters, { analysisMode: 'full-source-grid-moments', analysisSourcePoints: sourcePointCount, contributedPoints: contributed, aggregateCells: occupied, aggregateGrid: dims, aggregateCellSizeM: dims.map((d, i) => (max[i]! - min[i]!) / (d - 1)), directionReferenceBudget: 60000 });
  finalizeElevation(model, drawingCloud, true);
  model.titleBlock.evidenceNote += "；完整源点网格聚合，详见成果参数";
  return model;
}
