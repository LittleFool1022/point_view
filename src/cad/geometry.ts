import type { PointCloudData } from "../domain/types";

export type CadProjection = "xy" | "xz" | "yz";

export interface CadBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface CadSummary {
  projection: CadProjection;
  pointCount: number;
  bounds: CadBounds;
  width: number;
  depth: number;
  height: number;
  projectedAreaM2: number;
  volumeM3: number;
}

export interface TopPlaneResult {
  planeZ: number;
  tolerance: number;
  indices: number[];
}

export interface CadRegion {
  id: number;
  cells: number;
  areaM2: number;
  bounds: { min: [number, number]; max: [number, number] };
  polygon: Array<[number, number]>;
  /** 同一连通墙体可能同时具有外轮廓和内轮廓，DXF 必须全部保留。 */
  contours: Array<Array<[number, number]>>;
}

export interface CadRegionResult {
  gridSize: number;
  cellSize: number;
  occupiedCells: number;
  discardedCells: number;
  regions: CadRegion[];
  method: "projected-occupancy" | "vertical-persistence";
  /** 垂直结构识别实际采用的高度范围，仅 XY 墙体模式存在。 */
  heightRange?: [number, number];
}

export interface CadRegionOptions {
  gridSize?: number;
  /** 网格连通块至少保留多少个格子；小于该值的块视为孤立噪声。 */
  minRegionCells?: number;
  /** 每个网格至少命中的点数；严格 CAD 过滤默认 2。 */
  minCellPoints?: number;
  /** 投影轮廓简化容差；默认 0，仅移除严格共线点。 */
  simplifyTolerance?: number;
  /** 将主方向旋转到 X 轴，避免办公室平面斜着导出。 */
  alignment?: CadAlignment;
  /** 先在三维点云的 X/Y 平面旋正建筑，再做 XY/XZ/YZ 投影。 */
  planAlignment?: CadAlignment;
  /** XY 平面按跨高度持续出现的网格识别墙体，排除地面和大部分家具。 */
  verticalPersistence?: boolean;
  bounds?: { min: [number, number]; max: [number, number] };
  indices?: Iterable<number>;
}

export interface CadPointFilterOptions extends CadRegionOptions {
  /** 过滤时额外排除的点索引，例如自动识别出的顶部点。 */
  excludeIndices?: ReadonlySet<number>;
}

/** CAD 默认使用的严格离散点过滤阈值。 */
export const DEFAULT_CAD_MIN_REGION_CELLS = 24;
export const DEFAULT_CAD_MIN_CELL_POINTS = 2;

export interface CadAlignment {
  angleRadians: number;
  center: [number, number];
  method?: "pca" | "wall-histogram";
  confidence?: number;
}

export type OrthogonalWallSide = "bottom" | "right" | "top" | "left";

export interface OrthogonalWallSegment {
  side: OrthogonalWallSide;
  start: number;
  end: number;
  source: "observed" | "inferred";
}

export interface OrthogonalWallPlan {
  bounds: { min: [number, number]; max: [number, number] };
  wallThickness: number;
  observed: OrthogonalWallSegment[];
  inferred: OrthogonalWallSegment[];
  observedCoverage: number;
}

export interface CadWallEvidenceMap {
  method: "vertical-persistence" | "small-cloud-fallback";
  gridSize: number;
  cellSize: number;
  bounds: { min: [number, number]; max: [number, number] };
  heightRange: [number, number];
  layerCount: number;
  requiredLayers: number;
  occupiedCells: number;
  wallBandCells: number;
  sourcePointCount: number;
  /** 位于跨高度墙体格网及其墙厚邻域内的原始点索引。 */
  indices: number[];
}

export interface CadWallEvidenceOptions {
  gridSize?: number;
  minRegionCells?: number;
  minCellPoints?: number;
  alignment?: CadAlignment;
  indices?: Iterable<number>;
}

function quantile(values: number[], ratio: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)));
  return sorted[position]!;
}

function planarBounds(points: Iterable<[number, number]>): { min: [number, number]; max: [number, number] } | undefined {
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  let count = 0;
  for (const point of points) {
    count += 1;
    min[0] = Math.min(min[0], point[0]);
    min[1] = Math.min(min[1], point[1]);
    max[0] = Math.max(max[0], point[0]);
    max[1] = Math.max(max[1], point[1]);
  }
  return count ? { min, max } : undefined;
}

function finitePoint(cloud: PointCloudData, index: number): [number, number, number] | undefined {
  if (!cloud.visible[index]) return undefined;
  const x = cloud.positions[index * 3];
  const y = cloud.positions[index * 3 + 1];
  const z = cloud.positions[index * 3 + 2];
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : undefined;
}

function projected(point: [number, number, number], projection: CadProjection): [number, number] {
  if (projection === "xz") return [point[0], point[2]];
  if (projection === "yz") return [point[1], point[2]];
  return [point[0], point[1]];
}

function rotateProjected(point: [number, number], alignment?: CadAlignment): [number, number] {
  if (!alignment || alignment.angleRadians === 0) return point;
  const cos = Math.cos(alignment.angleRadians);
  const sin = Math.sin(alignment.angleRadians);
  const dx = point[0] - alignment.center[0];
  const dy = point[1] - alignment.center[1];
  return [alignment.center[0] + dx * cos - dy * sin, alignment.center[1] + dx * sin + dy * cos];
}

function alignPlanPoint(point: [number, number, number], alignment?: CadAlignment): [number, number, number] {
  if (!alignment || alignment.angleRadians === 0) return point;
  const [x, y] = rotateProjected([point[0], point[1]], alignment);
  return [x, y, point[2]];
}

/** 用二维 PCA 找到办公室主轴；返回将主轴旋到水平线所需的旋转。 */
export function computeCadAlignment(cloud: PointCloudData, projection: CadProjection = "xy", indices?: Iterable<number>): CadAlignment | undefined {
  const selected = indices ? [...indices] : undefined;
  const total = selected?.length ?? cloud.positions.length / 3;
  const stride = Math.max(1, Math.ceil(total / 100_000));
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  const points: Array<[number, number]> = [];
  const visit = (index: number) => {
    const point = finitePoint(cloud, index);
    if (!point) return;
    const projectedPoint = projected(point, projection);
    points.push(projectedPoint);
    sumX += projectedPoint[0];
    sumY += projectedPoint[1];
    count += 1;
  };
  if (selected) for (let index = 0; index < selected.length; index += stride) visit(selected[index]!);
  else for (let index = 0; index < total; index += stride) visit(index);
  if (count < 3) return undefined;
  const center: [number, number] = [sumX / count, sumY / count];
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const point of points) {
    const dx = point[0] - center[0];
    const dy = point[1] - center[1];
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  let principalAngle = 0.5 * Math.atan2(2 * xy, xx - yy);
  // PCA 主轴没有方向，0° 与 90° 等价。归一化到 ±45°，避免长边方向
  // 被错误解释为需要把整张图旋转近 90°。
  while (principalAngle > Math.PI / 4) principalAngle -= Math.PI / 2;
  while (principalAngle < -Math.PI / 4) principalAngle += Math.PI / 2;
  return { angleRadians: -principalAngle, center, method: "pca" };
}

/**
 * 用中部高度点的 X/Y 投影直方图寻找建筑正交主方向。
 * 墙面旋正后会集中落在少量 X/Y 栅格中，家具和地面不会形成同等峰值。
 */
export function computeOrthogonalCadAlignment(cloud: PointCloudData, indices?: Iterable<number>): CadAlignment | undefined {
  const selected = indices ? [...indices] : undefined;
  const sourceCount = selected?.length ?? cloud.positions.length / 3;
  const sourceIndexAt = (cursor: number) => selected?.[cursor] ?? cursor;
  const stride = Math.max(1, Math.ceil(sourceCount / 60_000));
  const sampled: Array<[number, number, number]> = [];
  for (let cursor = 0; cursor < sourceCount; cursor += stride) {
    const point = finitePoint(cloud, sourceIndexAt(cursor));
    if (point) sampled.push(point);
  }
  if (sampled.length < 200) return computeCadAlignment(cloud, "xy", selected);
  const zValues = sampled.map((point) => point[2]);
  const lowerZ = quantile(zValues, 0.18);
  const upperZ = quantile(zValues, 0.82);
  const points = sampled.filter((point) => point[2] >= lowerZ && point[2] <= upperZ).map((point) => [point[0], point[1]] as [number, number]);
  if (points.length < 200) return computeCadAlignment(cloud, "xy", selected);
  const center: [number, number] = [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
  const pointBounds = planarBounds(points)!;
  const span = Math.max(pointBounds.max[0] - pointBounds.min[0], pointBounds.max[1] - pointBounds.min[1], 1);
  const binSize = Math.max(0.04, Math.min(0.12, span / 160));
  const score = (angle: number) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const xBins = new Map<number, number>();
    const yBins = new Map<number, number>();
    for (const point of points) {
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const x = Math.round((dx * cos - dy * sin) / binSize);
      const y = Math.round((dx * sin + dy * cos) / binSize);
      xBins.set(x, (xBins.get(x) ?? 0) + 1);
      yBins.set(y, (yBins.get(y) ?? 0) + 1);
    }
    let concentration = 0;
    for (const count of xBins.values()) if (count >= 4) concentration += count * count;
    for (const count of yBins.values()) if (count >= 4) concentration += count * count;
    return concentration / (points.length * points.length);
  };
  const candidates: Array<{ angle: number; score: number }> = [];
  for (let degrees = -45; degrees <= 45; degrees += 1) {
    const angle = degrees * Math.PI / 180;
    candidates.push({ angle, score: score(angle) });
  }
  candidates.sort((left, right) => right.score - left.score);
  let best = candidates[0]!;
  const coarseAngle = best.angle;
  for (let offset = -1; offset <= 1.0001; offset += 0.1) {
    const angle = coarseAngle + offset * Math.PI / 180;
    const candidateScore = score(angle);
    if (candidateScore > best.score) best = { angle, score: candidateScore };
  }
  const medianScore = [...candidates].sort((left, right) => left.score - right.score)[Math.floor(candidates.length / 2)]!.score;
  return {
    angleRadians: best.angle,
    center,
    method: "wall-histogram",
    confidence: medianScore > 0 ? best.score / medianScore : 1,
  };
}

function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const unique = [...new Map(points.map((point) => [`${point[0]}:${point[1]}`, point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length <= 2) return unique;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Array<[number, number]> = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function polygonArea(points: Array<[number, number]>): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twice += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(twice) / 2;
}

function pointSegmentDistance(point: [number, number], start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

/** 去掉栅格阶梯中的短折点，保留办公室墙体等长直线和主要转角。 */
function simplifyClosedPolygon(points: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  if (points.length <= 4 || tolerance <= 0) return points;
  const result = [...points];
  let changed = true;
  while (changed && result.length > 4) {
    changed = false;
    for (let index = 0; index < result.length; index += 1) {
      const before = result[(index - 1 + result.length) % result.length]!;
      const current = result[index]!;
      const after = result[(index + 1) % result.length]!;
      if (pointSegmentDistance(current, before, after) > tolerance) continue;
      result.splice(index, 1);
      changed = true;
      break;
    }
  }
  return result;
}

/** 计算当前可见点的包围盒与投影凸包面积；面积不是房屋净使用面积。 */
export function computeCadSummary(cloud: PointCloudData, projection: CadProjection = "xy", indices?: Iterable<number>): CadSummary | undefined {
  const selected = indices ? [...indices] : undefined;
  const total = selected?.length ?? cloud.positions.length / 3;
  const sampleStride = Math.max(1, Math.ceil(total / 50_000));
  const hullPoints: Array<[number, number]> = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let pointCount = 0;
  const visit = (index: number) => {
    const point = finitePoint(cloud, index);
    if (!point) return;
    pointCount += 1;
    if (pointCount % sampleStride === 0 || pointCount === 1) hullPoints.push(projected(point, projection));
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  };
  if (selected) selected.forEach(visit);
  else for (let index = 0; index < cloud.positions.length / 3; index += 1) visit(index);
  if (pointCount === 0) return undefined;
  const hull = convexHull(hullPoints);
  return {
    projection,
    pointCount,
    bounds: { min, max },
    width: max[0] - min[0],
    depth: max[1] - min[1],
    height: max[2] - min[2],
    projectedAreaM2: polygonArea(hull),
    volumeM3: (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]),
  };
}

/** 以 Z 轴最高分位点为候选顶面，返回可撤销的隐藏索引；不冒充完整 RANSAC 建筑分割。 */
export function findTopPlaneIndices(cloud: PointCloudData, tolerance = 0.08): TopPlaneResult | undefined {
  const zValues: number[] = [];
  const total = cloud.positions.length / 3;
  const sampleStride = Math.max(1, Math.ceil(total / 200_000));
  for (let index = 0; index < total; index += sampleStride) {
    const point = finitePoint(cloud, index);
    if (point) zValues.push(point[2]);
  }
  if (zValues.length < 3) return undefined;
  zValues.sort((a, b) => a - b);
  const planeZ = zValues[Math.min(zValues.length - 1, Math.floor(zValues.length * 0.995))]!;
  const safeTolerance = Math.max(0.001, tolerance);
  const indices: number[] = [];
  for (let index = 0; index < total; index += 1) {
    const point = finitePoint(cloud, index);
    if (point && point[2] >= planeZ - safeTolerance) indices.push(index);
  }
  return { planeZ, tolerance: safeTolerance, indices };
}

/**
 * 返回 CAD 应实际使用的点索引。
 *
 * 旧流程只在生成轮廓时丢弃小连通块，但包围盒、面积、尺寸和代表点
 * 仍然读取全部可见点，单个离散点就能把整张图的标注拉大。这里先按
 * 投影栅格提取八邻域连通块，再把被保留块覆盖的原始点索引返回给摘要
 * 和 DXF 导出，保证所有 CAD 结果使用同一套干净点集。
 */
export function filterCadPointIndices(
  cloud: PointCloudData,
  projection: CadProjection = "xy",
  options: CadPointFilterOptions = {},
): number[] {
  const total = cloud.positions.length / 3;
  const sourceIndices = options.indices ? [...options.indices] : undefined;
  const sourceCount = sourceIndices?.length ?? total;
  const sourceIndexAt = (cursor: number) => sourceIndices?.[cursor] ?? cursor;
  const excluded = options.excludeIndices;
  // 小样本点云没有足够密度估计连通块，保留其有效点以兼容手工点云和导入预览。
  if (sourceCount <= 16) {
    const result: number[] = [];
    for (let cursor = 0; cursor < sourceCount; cursor += 1) {
      const index = sourceIndexAt(cursor);
      if (!excluded?.has(index) && finitePoint(cloud, index)) result.push(index);
    }
    return result;
  }
  const stride = Math.max(1, Math.ceil(sourceCount / 500_000));
  const samples: Array<{ index: number; point: [number, number] }> = [];
  for (let cursor = 0; cursor < sourceCount; cursor += stride) {
    const index = sourceIndexAt(cursor);
    if (excluded?.has(index)) continue;
    const point = finitePoint(cloud, index);
    if (point) samples.push({ index, point: projectCadPoint(point, projection, options.planAlignment, options.alignment) });
  }
  if (!samples.length) return [];
  const bounds = options.bounds;
  const sampleBounds = bounds ?? planarBounds(samples.map(({ point }) => point));
  if (!sampleBounds) return [];
  const minX = sampleBounds.min[0];
  const minY = sampleBounds.min[1];
  const maxX = sampleBounds.max[0];
  const maxY = sampleBounds.max[1];
  const requestedGrid = Math.floor(options.gridSize ?? 256);
  const densityGrid = Math.ceil(Math.sqrt(samples.length / 4));
  const gridSize = Math.max(8, Math.min(512, requestedGrid, Math.max(8, densityGrid)));
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const cellSize = span / gridSize;
  const cellFor = (point: [number, number]) => {
    const ix = Math.max(0, Math.min(gridSize - 1, Math.floor((point[0] - minX) / cellSize)));
    const iy = Math.max(0, Math.min(gridSize - 1, Math.floor((point[1] - minY) / cellSize)));
    return `${ix}:${iy}`;
  };
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const key = cellFor(sample.point);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const minCellPoints = Math.max(1, Math.floor(options.minCellPoints ?? DEFAULT_CAD_MIN_CELL_POINTS));
  const occupied = new Set([...counts].filter(([, count]) => count >= minCellPoints).map(([key]) => key));
  if (!occupied.size) return [];
  const components: Set<string>[] = [];
  const remaining = new Set(occupied);
  while (remaining.size) {
    const seed = remaining.values().next().value as string;
    remaining.delete(seed);
    const component = new Set([seed]);
    const queue = [seed];
    while (queue.length) {
      const key = queue.pop()!;
      const [x, y] = key.split(":").map(Number);
      for (const neighbor of [
        `${x - 1}:${y - 1}`, `${x}:${y - 1}`, `${x + 1}:${y - 1}`,
        `${x - 1}:${y}`, `${x + 1}:${y}`,
        `${x - 1}:${y + 1}`, `${x}:${y + 1}`, `${x + 1}:${y + 1}`,
      ]) {
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        component.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  components.sort((a, b) => b.size - a.size);
  const minRegionCells = Math.max(1, Math.floor(options.minRegionCells ?? DEFAULT_CAD_MIN_REGION_CELLS));
  const keptCells = new Set(components.filter((component) => component.size >= minRegionCells).flatMap((component) => [...component]));
  if (!keptCells.size) return [];
  const result: number[] = [];
  for (let cursor = 0; cursor < sourceCount; cursor += 1) {
    const index = sourceIndexAt(cursor);
    if (excluded?.has(index)) continue;
    const point = finitePoint(cloud, index);
    if (!point) continue;
    const projectedPoint = projectCadPoint(point, projection, options.planAlignment, options.alignment);
    if (keptCells.has(cellFor(projectedPoint))) result.push(index);
  }
  return result;
}

export function projectPoint(point: [number, number, number], projection: CadProjection): [number, number] {
  return projected(point, projection);
}

export function transformCadProjectedPoint(point: [number, number], alignment?: CadAlignment): [number, number] {
  return rotateProjected(point, alignment);
}

/**
 * 先在建筑平面内旋正三维点，再投影到指定视图；立面因此与平面图共用
 * 同一组建筑轴线，不会把家具和斜采集方向误当成立面方向。
 */
export function projectCadPoint(
  point: [number, number, number],
  projection: CadProjection,
  planAlignment?: CadAlignment,
  projectedAlignment?: CadAlignment,
): [number, number] {
  return rotateProjected(projected(alignPlanPoint(point, planAlignment), projection), projectedAlignment);
}

/**
 * 将旋正后的三维点云压成 XY 多高度证据地图。
 * 只有在多个高度层持续出现的格子才进入墙带；XZ/YZ 后续只能消费这些
 * 墙带中的原始点，从数据入口排除房间中央的家具和零散点。
 */
export function buildCadWallEvidenceMap(
  cloud: PointCloudData,
  options: CadWallEvidenceOptions = {},
): CadWallEvidenceMap | undefined {
  const selected = options.indices ? [...options.indices] : undefined;
  const total = cloud.positions.length / 3;
  const sourceCount = selected?.length ?? total;
  const sourceIndexAt = (cursor: number) => selected?.[cursor] ?? cursor;
  if (!sourceCount) return undefined;

  const validIndices: number[] = [];
  const sampled: Array<{ point: [number, number]; z: number }> = [];
  const stride = Math.max(1, Math.ceil(sourceCount / 500_000));
  for (let cursor = 0; cursor < sourceCount; cursor += 1) {
    const index = sourceIndexAt(cursor);
    const point = finitePoint(cloud, index);
    if (!point) continue;
    validIndices.push(index);
    if (cursor % stride === 0) sampled.push({ point: projectCadPoint(point, "xy", options.alignment), z: point[2] });
  }
  if (!sampled.length) return undefined;

  const sampleBounds = sampled.length >= 1_000
    ? {
      min: [quantile(sampled.map(({ point }) => point[0]), 0.005), quantile(sampled.map(({ point }) => point[1]), 0.005)] as [number, number],
      max: [quantile(sampled.map(({ point }) => point[0]), 0.995), quantile(sampled.map(({ point }) => point[1]), 0.995)] as [number, number],
    }
    : planarBounds(sampled.map(({ point }) => point));
  if (!sampleBounds) return undefined;
  const zValues = sampled.map(({ z }) => z);
  const robustMinZ = quantile(zValues, 0.01);
  const robustMaxZ = quantile(zValues, 0.99);
  const verticalSpan = robustMaxZ - robustMinZ;
  const requestedGrid = Math.floor(options.gridSize ?? 256);
  // 让每格平均至少承载约 4 个采样点；真实大点云仍保持请求的 256 格，
  // 稀疏夹具则自动使用粗格网，避免同一面墙被切成互不相邻的单格。
  const densityGrid = Math.ceil(Math.sqrt(sampled.length / 4));
  const gridSize = Math.max(8, Math.min(512, requestedGrid, Math.max(8, densityGrid)));
  const span = Math.max(sampleBounds.max[0] - sampleBounds.min[0], sampleBounds.max[1] - sampleBounds.min[1], 1e-6);
  const cellSize = span / gridSize;
  const layerCount = 6;
  const requiredLayers = 3;

  // 小型手工夹具没有足够密度建立跨高度地图，保留全部有效点但显式标记回退。
  if (sampled.length < 100 || verticalSpan < 0.5) {
    return {
      method: "small-cloud-fallback", gridSize, cellSize, bounds: sampleBounds,
      heightRange: [robustMinZ, robustMaxZ], layerCount: 1, requiredLayers: 1,
      occupiedCells: 0, wallBandCells: 0, sourcePointCount: validIndices.length, indices: validIndices,
    };
  }

  const lower = robustMinZ + verticalSpan * 0.15;
  const upper = robustMaxZ - verticalSpan * 0.15;
  const layerHeight = (upper - lower) / layerCount;
  if (!(layerHeight > 0)) return undefined;
  const insideBounds = ([x, y]: [number, number]) =>
    x >= sampleBounds.min[0] && x <= sampleBounds.max[0]
    && y >= sampleBounds.min[1] && y <= sampleBounds.max[1];
  const cellCoordinates = ([x, y]: [number, number]): [number, number] => [
    Math.max(0, Math.min(gridSize - 1, Math.floor((x - sampleBounds.min[0]) / cellSize))),
    Math.max(0, Math.min(gridSize - 1, Math.floor((y - sampleBounds.min[1]) / cellSize))),
  ];
  const cellKey = (point: [number, number]) => cellCoordinates(point).join(":");
  const layerCounts = new Map<string, Uint16Array>();
  for (const sample of sampled) {
    if (!insideBounds(sample.point) || sample.z < lower || sample.z > upper) continue;
    const layer = Math.min(layerCount - 1, Math.floor((sample.z - lower) / layerHeight));
    const key = cellKey(sample.point);
    const counts = layerCounts.get(key) ?? new Uint16Array(layerCount);
    if (counts[layer]! < 65_535) counts[layer] += 1;
    layerCounts.set(key, counts);
  }
  const minCellPoints = Math.max(1, Math.floor(options.minCellPoints ?? DEFAULT_CAD_MIN_CELL_POINTS));
  const persistent = new Set([...layerCounts].filter(([, counts]) => {
    let layers = 0;
    for (const count of counts) if (count >= minCellPoints) layers += 1;
    return layers >= requiredLayers;
  }).map(([key]) => key));
  if (!persistent.size) return undefined;

  const components: Set<string>[] = [];
  const remaining = new Set(persistent);
  while (remaining.size) {
    const seed = remaining.values().next().value as string;
    remaining.delete(seed);
    const component = new Set([seed]);
    const queue = [seed];
    while (queue.length) {
      const [x, y] = queue.pop()!.split(":").map(Number);
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
        if (dx === 0 && dy === 0) continue;
        const neighbor = `${x + dx}:${y + dy}`;
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        component.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  const minRegionCells = Math.max(1, Math.floor(options.minRegionCells ?? DEFAULT_CAD_MIN_REGION_CELLS));
  const keptCells = new Set(components.filter((component) => component.size >= minRegionCells).flatMap((component) => [...component]));
  if (!keptCells.size) return undefined;

  // 一格扩张只用于把墙面厚度和测量噪声纳入立面输入，不会创建新的墙线证据。
  const wallBandCells = new Set<string>();
  for (const key of keptCells) {
    const [x, y] = key.split(":").map(Number);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      if (x + dx >= 0 && x + dx < gridSize && y + dy >= 0 && y + dy < gridSize) wallBandCells.add(`${x + dx}:${y + dy}`);
    }
  }
  const wallIndices: number[] = [];
  for (const index of validIndices) {
    const point = finitePoint(cloud, index)!;
    const xy = projectCadPoint(point, "xy", options.alignment);
    if (insideBounds(xy) && wallBandCells.has(cellKey(xy))) wallIndices.push(index);
  }
  if (!wallIndices.length) return undefined;
  return {
    method: "vertical-persistence", gridSize, cellSize, bounds: sampleBounds,
    heightRange: [lower, upper], layerCount, requiredLayers,
    occupiedCells: keptCells.size, wallBandCells: wallBandCells.size,
    sourcePointCount: validIndices.length, indices: wallIndices,
  };
}

function mergeWallIntervals(intervals: Array<[number, number]>, minimum: number, maximum: number, gapTolerance: number, minimumLength: number): Array<[number, number]> {
  const clipped = intervals
    .map(([start, end]) => [Math.max(minimum, Math.min(start, end)), Math.min(maximum, Math.max(start, end))] as [number, number])
    .filter(([start, end]) => end - start >= minimumLength)
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of clipped) {
    const previous = merged.at(-1);
    if (!previous || interval[0] > previous[1] + gapTolerance) merged.push([...interval]);
    else previous[1] = Math.max(previous[1], interval[1]);
  }
  return merged;
}

function complementWallIntervals(observed: Array<[number, number]>, minimum: number, maximum: number, minimumGap: number): Array<[number, number]> {
  const inferred: Array<[number, number]> = [];
  let cursor = minimum;
  for (const [start, end] of observed) {
    if (start - cursor >= minimumGap) inferred.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (maximum - cursor >= minimumGap) inferred.push([cursor, maximum]);
  return inferred;
}

/**
 * 将墙体占据轮廓压缩为正交直线段。
 * 靠近外包络且连续出现的区间标为 observed，剩余缺口单独标为 inferred。
 */
export function fitOrthogonalWallPlan(result: CadRegionResult, options: { inferGaps?: boolean } = {}): OrthogonalWallPlan | undefined {
  const contours = result.regions.flatMap((region) => region.contours);
  const bounds = planarBounds(contours.flat());
  if (!bounds) return undefined;
  const width = bounds.max[0] - bounds.min[0];
  const height = bounds.max[1] - bounds.min[1];
  if (width <= result.cellSize * 2 || height <= result.cellSize * 2) return undefined;
  const wallThickness = Math.min(0.25, Math.max(0.08, result.cellSize * 3));
  const edgeTolerance = Math.max(result.cellSize * 5, wallThickness * 1.5);
  const gapTolerance = Math.max(result.cellSize * 6, 0.18);
  const minimumLength = Math.max(result.cellSize * 4, 0.12);
  const intervals: Record<OrthogonalWallSide, Array<[number, number]>> = { bottom: [], right: [], top: [], left: [] };
  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const start = contour[index]!;
      const end = contour[(index + 1) % contour.length]!;
      const dx = Math.abs(end[0] - start[0]);
      const dy = Math.abs(end[1] - start[1]);
      if (dx >= dy && dx >= result.cellSize * 0.75) {
        const y = (start[1] + end[1]) / 2;
        if (Math.abs(y - bounds.min[1]) <= edgeTolerance) intervals.bottom.push([start[0], end[0]]);
        if (Math.abs(y - bounds.max[1]) <= edgeTolerance) intervals.top.push([start[0], end[0]]);
      }
      if (dy >= dx && dy >= result.cellSize * 0.75) {
        const x = (start[0] + end[0]) / 2;
        if (Math.abs(x - bounds.min[0]) <= edgeTolerance) intervals.left.push([start[1], end[1]]);
        if (Math.abs(x - bounds.max[0]) <= edgeTolerance) intervals.right.push([start[1], end[1]]);
      }
    }
  }
  const observed: OrthogonalWallSegment[] = [];
  const inferred: OrthogonalWallSegment[] = [];
  const sideRanges: Record<OrthogonalWallSide, [number, number]> = {
    bottom: [bounds.min[0], bounds.max[0]], top: [bounds.min[0], bounds.max[0]],
    left: [bounds.min[1], bounds.max[1]], right: [bounds.min[1], bounds.max[1]],
  };
  let observedLength = 0;
  let perimeter = 0;
  for (const side of ["bottom", "right", "top", "left"] as const) {
    const [minimum, maximum] = sideRanges[side];
    const merged = mergeWallIntervals(intervals[side], minimum, maximum, gapTolerance, minimumLength);
    const missing = options.inferGaps === false ? [] : complementWallIntervals(merged, minimum, maximum, minimumLength);
    for (const [start, end] of merged) {
      observed.push({ side, start, end, source: "observed" });
      observedLength += end - start;
    }
    for (const [start, end] of missing) inferred.push({ side, start, end, source: "inferred" });
    perimeter += maximum - minimum;
  }
  return { bounds, wallThickness, observed, inferred, observedCoverage: perimeter > 0 ? observedLength / perimeter : 0 };
}

function regionPolygons(
  cells: Set<string>,
  gridSize: number,
  minX: number,
  minY: number,
  cellSize: number,
  simplifyTolerance: number,
): Array<Array<[number, number]>> {
  type Vertex = [number, number];
  type Edge = { a: Vertex; b: Vertex };
  const edges: Edge[] = [];
  const has = (x: number, y: number) => cells.has(`${x}:${y}`);
  const add = (a: Vertex, b: Vertex) => edges.push({ a, b });
  for (const key of cells) {
    const [ix, iy] = key.split(":").map(Number);
    // 所有边统一按顺时针写入，已占据网格始终位于有向边右侧。
    // 旧实现的水平边方向与垂直边相反，边界交点处会被错误串成尖刺。
    if (!has(ix - 1, iy)) add([ix, iy], [ix, iy + 1]);
    if (!has(ix + 1, iy)) add([ix + 1, iy + 1], [ix + 1, iy]);
    if (!has(ix, iy - 1)) add([ix + 1, iy], [ix, iy]);
    if (!has(ix, iy + 1)) add([ix, iy + 1], [ix + 1, iy + 1]);
  }
  if (!edges.length) return [];
  const key = (point: Vertex) => `${point[0]}:${point[1]}`;
  const byStart = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const list = byStart.get(key(edge.a)) ?? [];
    list.push(index);
    byStart.set(key(edge.a), list);
  });
  const unused = new Set(edges.map((_, index) => index));
  const loops: Array<Array<[number, number]>> = [];
  while (unused.size) {
    const first = unused.values().next().value as number;
    unused.delete(first);
    const start = edges[first]!.a;
    let current = edges[first]!.b;
    let previous = start;
    const loop: Vertex[] = [start, current];
    let guard = 0;
    while (key(current) !== key(start) && guard < edges.length + 2) {
      guard += 1;
      const incoming: Vertex = [current[0] - previous[0], current[1] - previous[1]];
      const next = (byStart.get(key(current)) ?? [])
        .filter((index) => unused.has(index))
        .sort((left, right) => {
          const leftEdge = edges[left]!;
          const rightEdge = edges[right]!;
          const leftDirection: Vertex = [leftEdge.b[0] - leftEdge.a[0], leftEdge.b[1] - leftEdge.a[1]];
          const rightDirection: Vertex = [rightEdge.b[0] - rightEdge.a[0], rightEdge.b[1] - rightEdge.a[1]];
          const leftCross = incoming[0] * leftDirection[1] - incoming[1] * leftDirection[0];
          const rightCross = incoming[0] * rightDirection[1] - incoming[1] * rightDirection[0];
          return leftCross - rightCross;
        })[0];
      if (next === undefined) break;
      unused.delete(next);
      const edge = edges[next]!;
      previous = current;
      current = edge.b;
      loop.push(current);
    }
    if (loop.length >= 4 && key(loop[loop.length - 1]!) === key(start)) {
      loop.pop();
      const simplified = loop.filter((point, index) => {
        const before = loop[(index - 1 + loop.length) % loop.length]!;
        const next = loop[(index + 1) % loop.length]!;
        return (before[0] - point[0]) * (next[1] - point[1]) !== (before[1] - point[1]) * (next[0] - point[0]);
      });
      loops.push(simplifyClosedPolygon(simplified.map(([x, y]) => [minX + x * cellSize, minY + y * cellSize]), simplifyTolerance));
    }
  }
  return loops
    .filter((loop) => loop.length >= 3 && polygonArea(loop) > cellSize * cellSize * 0.5)
    .sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)))
    .map((loop) => loop.map((point) => [point[0], point[1]]));
}

/**
 * 将投影点栅格化并按八邻域提取连通块。
 * 小连通块会被丢弃，导出时因此不会把孤立测量噪声画成 CAD 区域。
 */
export function extractCadRegions(
  cloud: PointCloudData,
  projection: CadProjection = "xy",
  options: CadRegionOptions = {},
): CadRegionResult | undefined {
  const bounds = options.bounds;
  const projectedPoints: Array<{ point: [number, number]; height: number }> = [];
  const total = cloud.positions.length / 3;
  const selected = options.indices ? [...options.indices] : undefined;
  const sampleCount = selected?.length ?? total;
  const stride = Math.max(1, Math.ceil(sampleCount / 500_000));
  if (selected) {
    for (let cursor = 0; cursor < selected.length; cursor += stride) {
      const point = finitePoint(cloud, selected[cursor]!);
      if (point) projectedPoints.push({ point: projectCadPoint(point, projection, options.planAlignment, options.alignment), height: point[2] });
    }
  } else {
    for (let index = 0; index < total; index += stride) {
      const point = finitePoint(cloud, index);
      if (point) projectedPoints.push({ point: projectCadPoint(point, projection, options.planAlignment, options.alignment), height: point[2] });
    }
  }
  if (!projectedPoints.length && !bounds) return undefined;
  const robustBounds = projectedPoints.length >= 1_000
    ? {
      min: [quantile(projectedPoints.map(({ point }) => point[0]), 0.005), quantile(projectedPoints.map(({ point }) => point[1]), 0.005)] as [number, number],
      max: [quantile(projectedPoints.map(({ point }) => point[0]), 0.995), quantile(projectedPoints.map(({ point }) => point[1]), 0.995)] as [number, number],
    }
    : planarBounds(projectedPoints.map(({ point }) => point));
  const projectedBounds = bounds ?? robustBounds;
  if (!projectedBounds) return undefined;
  const minX = projectedBounds.min[0];
  const minY = projectedBounds.min[1];
  const maxX = projectedBounds.max[0];
  const maxY = projectedBounds.max[1];
  // 点数少时不能使用固定 256 网格，否则正常边界点也会各占一格而被误判为孤立点。
  // 让每格大约承载 4 个采样点；大点云仍受 512 上限保护。
  const requestedGrid = Math.floor(options.gridSize ?? 256);
  const densityGrid = Math.ceil(Math.sqrt(projectedPoints.length / 4));
  const gridSize = Math.max(8, Math.min(512, requestedGrid, Math.max(8, densityGrid)));
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const cellSize = span / gridSize;
  const cellFor = (point: [number, number]) => {
    const ix = Math.max(0, Math.min(gridSize - 1, Math.floor((point[0] - minX) / cellSize)));
    const iy = Math.max(0, Math.min(gridSize - 1, Math.floor((point[1] - minY) / cellSize)));
    return `${ix}:${iy}`;
  };
  const insideBounds = (point: [number, number]) =>
    point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY;
  const minCellPoints = projectedPoints.length < 100
    ? 1
    : Math.max(1, Math.floor(options.minCellPoints ?? 1));
  const heights = projectedPoints.map(({ height }) => height);
  const robustMinZ = quantile(heights, 0.01);
  const robustMaxZ = quantile(heights, 0.99);
  const verticalSpan = robustMaxZ - robustMinZ;
  // 小型测试点云、单平面扫描和立面投影没有足够的高度证据，回退到普通
  // 投影轮廓；不能因为启用了 XY 墙体模式就导出空文件。
  const useVerticalPersistence = options.verticalPersistence === true
    && projection === "xy"
    && projectedPoints.length >= 100
    && verticalSpan >= 0.5;
  let method: CadRegionResult["method"] = "projected-occupancy";
  let heightRange: [number, number] | undefined;
  let occupied: Set<string>;
  if (useVerticalPersistence) {
    const layerCount = 6;
    const lower = robustMinZ + verticalSpan * 0.15;
    const upper = robustMaxZ - verticalSpan * 0.15;
    const layerHeight = (upper - lower) / layerCount;
    const layerCounts = new Map<string, Uint16Array>();
    if (verticalSpan >= 0.5 && layerHeight > 0) {
      for (const sample of projectedPoints) {
        if (!insideBounds(sample.point) || sample.height < lower || sample.height > upper) continue;
        const layer = Math.min(layerCount - 1, Math.floor((sample.height - lower) / layerHeight));
        const key = cellFor(sample.point);
        const counts = layerCounts.get(key) ?? new Uint16Array(layerCount);
        const layerCountValue = counts[layer] ?? 0;
        if (layerCountValue < 65_535) counts[layer] = layerCountValue + 1;
        layerCounts.set(key, counts);
      }
    }
    occupied = new Set([...layerCounts].filter(([, counts]) => {
      let persistentLayers = 0;
      for (const count of counts) if (count >= minCellPoints) persistentLayers += 1;
      return persistentLayers >= 3;
    }).map(([key]) => key));
    method = "vertical-persistence";
    heightRange = [lower, upper];
  } else {
    const counts = new Map<string, number>();
    for (const sample of projectedPoints) {
      if (!insideBounds(sample.point)) continue;
      const key = cellFor(sample.point);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    occupied = new Set([...counts].filter(([, count]) => count >= minCellPoints).map(([key]) => key));
  }
  const components: Set<string>[] = [];
  const remaining = new Set(occupied);
  while (remaining.size) {
    const seed = remaining.values().next().value as string;
    remaining.delete(seed);
    const component = new Set([seed]);
    const queue = [seed];
    while (queue.length) {
      const key = queue.pop()!;
      const [x, y] = key.split(":").map(Number);
      for (const neighbor of [
        `${x - 1}:${y - 1}`, `${x}:${y - 1}`, `${x + 1}:${y - 1}`,
        `${x - 1}:${y}`, `${x + 1}:${y}`,
        `${x - 1}:${y + 1}`, `${x}:${y + 1}`, `${x + 1}:${y + 1}`,
      ]) {
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        component.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  components.sort((a, b) => b.size - a.size);
  const defaultMinRegionCells = Math.max(8, Math.min(64, Math.ceil((components[0]?.size ?? 0) * 0.003)));
  const minRegionCells = Math.max(1, Math.floor(options.minRegionCells ?? defaultMinRegionCells));
  // 默认只消除严格共线点。自动按 2.5 格简化会跨过凹角连成长斜线，
  // 这是旧 DXF 出现星形、尖刺轮廓的直接原因。
  const simplifyTolerance = Math.max(0, options.simplifyTolerance ?? 0);
  const keepAllTinyInput = !useVerticalPersistence && occupied.size <= minRegionCells * 2;
  const kept = keepAllTinyInput ? components : components.filter((component) => component.size >= minRegionCells);
  const regions: CadRegion[] = [];
  kept.forEach((component, id) => {
    const contours = regionPolygons(component, gridSize, minX, minY, cellSize, simplifyTolerance);
    const polygon = contours[0];
    if (!polygon || polygon.length < 3) return;
    let minCellX = Infinity;
    let minCellY = Infinity;
    let maxCellX = -Infinity;
    let maxCellY = -Infinity;
    for (const key of component) {
      const [x, y] = key.split(":").map(Number);
      minCellX = Math.min(minCellX, x);
      minCellY = Math.min(minCellY, y);
      maxCellX = Math.max(maxCellX, x);
      maxCellY = Math.max(maxCellY, y);
    }
    regions.push({
      id,
      cells: component.size,
      areaM2: component.size * cellSize * cellSize,
      bounds: { min: [minX + minCellX * cellSize, minY + minCellY * cellSize], max: [minX + (maxCellX + 1) * cellSize, minY + (maxCellY + 1) * cellSize] },
      polygon,
      contours,
    });
  });
  return {
    gridSize,
    cellSize,
    occupiedCells: occupied.size,
    discardedCells: occupied.size - kept.reduce((sum, component) => sum + component.size, 0),
    regions,
    method,
    heightRange,
  };
}
