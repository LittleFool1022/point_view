import type { PointCloudData } from "../domain/types";
import { projectCadPoint, type CadAlignment, type CadProjection } from "./geometry";
import type { CadEntity, DrawingModel } from "./model";

export type DrawingPoint = [number, number];
export type WorldPoint = [number, number, number];

/** 仅在预览会话中保存；不进入 DrawingModel 的序列化成果。 */
export interface CadPreviewSource {
  drawingId: string;
  cloud: PointCloudData;
  indices?: readonly number[];
  projection: CadProjection;
  planAlignment?: CadAlignment;
  projectedAlignment?: CadAlignment;
}

export interface CadLinkSelection {
  origin: "cad" | "cloud";
  entityIds: string[];
  pointIndices: number[];
  drawingPoint?: DrawingPoint;
  kind: "exact" | "neighborhood" | "unmapped";
  message: string;
}

export const CAD_LINK_POINT_BUDGET = 120_000;

export function sourcePoint(source: CadPreviewSource, index: number): WorldPoint | undefined {
  if (!Number.isInteger(index) || index < 0 || !source.cloud.visible[index]) return;
  const offset = index * 3;
  const point: WorldPoint = [source.cloud.positions[offset]!, source.cloud.positions[offset + 1]!, source.cloud.positions[offset + 2]!];
  return point.every(Number.isFinite) ? point : undefined;
}

export function projectSourcePoint(source: CadPreviewSource, index: number): DrawingPoint | undefined {
  const point = sourcePoint(source, index);
  if (!point) return;
  const projected = projectCadPoint(point, source.projection, source.planAlignment, source.projectedAlignment);
  return [projected[0] * 1000, projected[1] * 1000];
}

export function entitySegments(entity: CadEntity): Array<[DrawingPoint, DrawingPoint]> {
  if (entity.type === "line") return [[entity.start, entity.end]];
  if (entity.type !== "polyline") return [];
  return entity.points.slice(0, entity.closed ? undefined : -1).map((point, i) => [point, entity.points[(i + 1) % entity.points.length]!]);
}

export function distanceToDrawingSegment(point: DrawingPoint, start: DrawingPoint, end: DrawingPoint): number {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSq)) : 0;
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}

export function entityCenter(entity: CadEntity): DrawingPoint {
  if (entity.type === "point" || entity.type === "text") return entity.position;
  const points = entity.type === "line" ? [entity.start, entity.end] : entity.points;
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** 固定源快照的二维格网，只查实测候选，不为推断线补造源点。 */
export function createCadLinkIndex(source: CadPreviewSource, model: DrawingModel) {
  const toleranceMm = Math.max(20, model.accuracy.gridResolutionMm * 1.5, model.accuracy.roundingMm);
  const cellSize = toleranceMm * 2;
  const samples = new Map<number, DrawingPoint>();
  const cells = new Map<string, number[]>();
  const entities = new Map(model.entities.map(entity => [entity.id, entity]));
  const walls = model.entities.filter(entity => entity.layer === "OBSERVED_WALL" && entity.source === "observed");
  const wallSegments = walls.map(entity => ({ entity, segments: entitySegments(entity) }));
  const exactEntities = new Map<number, string[]>();
  const cache = new Map<string, CadLinkSelection>();
  const count = source.indices?.length ?? source.cloud.visible.length;
  const stride = Math.max(1, Math.ceil(count / CAD_LINK_POINT_BUDGET));
  for (let cursor = 0; cursor < count; cursor += stride) {
    const index = source.indices?.[cursor] ?? cursor;
    const point = projectSourcePoint(source, index);
    if (!point) continue;
    samples.set(index, point);
    const key = `${Math.floor(point[0] / cellSize)}:${Math.floor(point[1] / cellSize)}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(index); cells.set(key, bucket);
  }
  for (const entity of model.entities) {
    const index = entity.metadata?.sourcePointIndex;
    if (entity.layer !== "POINT_CLOUD" || entity.type !== "point" || typeof index !== "number") continue;
    if (!sourcePoint(source, index)) continue;
    exactEntities.set(index, [...(exactEntities.get(index) ?? []), entity.id]);
  }

  const forEntity = (id: string): CadLinkSelection | undefined => {
    if (cache.has(id)) return cache.get(id);
    const entity = entities.get(id);
    if (!entity) return;
    const result: CadLinkSelection = { origin: "cad", entityIds: [id], pointIndices: [], drawingPoint: entityCenter(entity), kind: "unmapped", message: "该图元没有直接源点对应" };
    const exact = entity.metadata?.sourcePointIndex;
    if (entity.layer === "POINT_CLOUD" && entity.type === "point" && typeof exact === "number" && sourcePoint(source, exact)) {
      result.pointIndices = [exact]; result.kind = "exact"; result.message = "原始采样点 · 精确对应";
    } else if (entity.layer === "OBSERVED_WALL" && entity.source === "observed") {
      const segments = entitySegments(entity);
      const candidates = new Set<number>();
      // 沿线段走格网，避免斜线的包围矩形扫描大量无关空格子。
      for (const [start, end] of segments) {
        const steps = Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / cellSize);
        for (let step = 0; step <= Math.max(1, steps); step++) {
          const t = step / Math.max(1, steps);
          const x = Math.floor((start[0] + (end[0] - start[0]) * t) / cellSize);
          const y = Math.floor((start[1] + (end[1] - start[1]) * t) / cellSize);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const index of cells.get(`${x + dx}:${y + dy}`) ?? []) candidates.add(index);
          }
        }
      }
      result.pointIndices = [...candidates].filter(index => segments.some(([start, end]) => distanceToDrawingSegment(samples.get(index)!, start, end) <= toleranceMm));
      result.kind = "neighborhood";
      result.message = result.pointIndices.length ? `投影邻域 · ${result.pointIndices.length.toLocaleString()} 个采样候选` : "投影邻域内没有采样候选";
    }
    cache.set(id, result);
    return result;
  };

  const forPoint = (index: number): CadLinkSelection | undefined => {
    const point = projectSourcePoint(source, index);
    if (!point) return;
    const exact = exactEntities.get(index) ?? [];
    const neighbors = wallSegments.filter(({ segments }) => segments.some(([start, end]) => distanceToDrawingSegment(point, start, end) <= toleranceMm)).map(({ entity }) => entity.id);
    return {
      origin: "cloud", entityIds: [...exact, ...neighbors], pointIndices: [index], drawingPoint: point,
      kind: exact.length ? "exact" : "neighborhood",
      message: exact.length ? "原始采样点 · 精确对应" : neighbors.length ? `投影邻域 · ${neighbors.length} 条实测墙线候选` : "已标出投影位置，附近没有实测墙线",
    };
  };
  return { forEntity, forPoint, sampleCount: samples.size, toleranceMm };
}

export function linkedWorldBounds(source: CadPreviewSource, indices: readonly number[]) {
  const min: WorldPoint = [Infinity, Infinity, Infinity], max: WorldPoint = [-Infinity, -Infinity, -Infinity];
  for (const index of indices) {
    const point = sourcePoint(source, index);
    if (!point) continue;
    for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, point[axis]!); max[axis] = Math.max(max[axis]!, point[axis]!); }
  }
  if (!Number.isFinite(min[0])) return;
  return { center: min.map((value, axis) => (value + max[axis]!) / 2) as WorldPoint, radius: Math.max(0.1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2) };
}
