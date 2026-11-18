import type { CadProjection } from "./geometry";
import { dimensionEntities, type CadDimension } from "./dimensions";
import { PAPER_SIZE_MM, cadEntityPoints, type AnnotationEntity, type CadBoundsMm, type CadEntity, type DrawingModel } from "./model";
import { cadSheet, restyleCadDrawing } from "./sheet";
import { exportCadDxf } from "./dxf";

export type MultiViewModels = Record<CadProjection, DrawingModel>;
export const MULTI_VIEW_ORDER: CadProjection[] = ["xy", "xz", "yz"];
const VIEW_LABELS: Record<CadProjection, string> = { xy: "俯视图 · XY", xz: "正视图 · XZ", yz: "侧视图 · YZ" };
const VIEW_GAP_MM = 2_000;

type Offset = { x: number; y: number; projection: CadProjection };
function move(point: [number, number], offset: Offset): [number, number] {
  return [point[0] + offset.x, point[1] + offset.y];
}

function moveEntity(entity: CadEntity, offset: Offset): CadEntity {
  const id = `${offset.projection}:${entity.id}`;
  const metadata = entity.metadata ? { ...entity.metadata, dimensionId: typeof entity.metadata.dimensionId === "string" ? `${offset.projection}:${entity.metadata.dimensionId}` : entity.metadata.dimensionId, startEntityId: typeof entity.metadata.startEntityId === "string" ? `${offset.projection}:${entity.metadata.startEntityId}` : entity.metadata.startEntityId, endEntityId: typeof entity.metadata.endEntityId === "string" ? `${offset.projection}:${entity.metadata.endEntityId}` : entity.metadata.endEntityId, ...(entity.metadata.dimensionId?{}:{view:offset.projection}) } : { view: offset.projection };
  if (entity.type === "line") return { ...entity, id, metadata, start: move(entity.start, offset), end: move(entity.end, offset) };
  if (entity.type === "polyline") return { ...entity, id, metadata, points: entity.points.map(point => move(point, offset)) };
  if (entity.type === "text" || entity.type === "point") return { ...entity, id, metadata, position: move(entity.position, offset) };
  return { ...entity, id, metadata, center: move(entity.center, offset) };
}

const entityPoints=cadEntityPoints;

const EXPECTED_VIEWS = { xy: "top_xy", xz: "front_xz", yz: "side_yz" } as const;
export function assertMultiViewModels(models: MultiViewModels, sourceSha256?: string): void {
  const hashes = new Set<string>();
  for (const projection of MULTI_VIEW_ORDER) {
    const model = models[projection];
    if (model.view !== EXPECTED_VIEWS[projection] || model.parameters.projection !== projection) throw Error(`${projection} 与实际图纸投影不一致，已拒绝合并。`);
    if (model.paperSize !== models.xy.paperSize || model.scale !== models.xy.scale) throw Error("三视图图幅和比例必须一致。");
    if (model.sourceSha256) hashes.add(model.sourceSha256);
    if (sourceSha256 && model.sourceSha256 !== sourceSha256) throw Error(`${projection} 与交付源件 SHA-256 不一致或缺失，请重新生成图纸。`);
  }
  if (hashes.size > 1) throw Error("三视图来源 SHA-256 不一致，已拒绝合并。");
}

function entitiesBounds(entities: CadEntity[]): CadBoundsMm {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const entity of entities) for (const point of entityPoints(entity)) {
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : { min: [0, 0], max: [1, 1] };
}

function fitMultiViewSheet(model: DrawingModel): DrawingModel {
  const paper = PAPER_SIZE_MM[model.paperSize], current = Number(model.scale.split(":")[1]) || 100;
  const width = model.modelBoundsMm.max[0] - model.modelBoundsMm.min[0], height = model.modelBoundsMm.max[1] - model.modelBoundsMm.min[1];
  const required = Math.max(current, width / Math.max(50, paper[0] - 200), height / Math.max(50, paper[1] - 70));
  let denominator = Math.ceil(required / 50) * 50;
  for (let attempt = 0; attempt < 6; attempt++) {
    const next = restyleCadDrawing(model, { scale: `1:${denominator}` }), plot = cadSheet(next);
    if (!plot.outsideEntityIds.length && !plot.titleOverlapEntityIds.length) return next;
    denominator *= 2;
  }
  throw Error("三视图无法在当前图幅内排版，请扩大图幅后重试。");
}

/** 三视图仅以毫米模型坐标平移排版；不缩放几何，ID 和尺寸关联加投影响前缀。 */
export function createMultiViewDrawing(models: MultiViewModels): DrawingModel {
  assertMultiViewModels(models);
  const base = models.xy, entities: CadEntity[] = [], dimensions: CadDimension[] = [], annotations: AnnotationEntity[] = [], warnings: DrawingModel["warnings"] = [];
  let cursorX = 0;
  for (const projection of MULTI_VIEW_ORDER) {
    const model = models[projection];
    const content = model.entities.filter(entity => entity.layer !== "FRAME" && entity.layer !== "TITLE_BLOCK" && !entity.metadata?.dimensionId);
    const bounds = entitiesBounds([...content, ...(model.dimensions ?? []).flatMap(dimensionEntities)]);
    const offset = { x: cursorX - bounds.min[0], y: -bounds.min[1], projection }, height = Math.max(1, bounds.max[1] - bounds.min[1]);
    for (const entity of content) entities.push(moveEntity(entity, offset));
    for (const dimension of model.dimensions ?? []) dimensions.push({
      ...dimension, id: `${projection}:${dimension.id}`,
      start: move(dimension.start, offset), end: move(dimension.end, offset), linePoint: move(dimension.linePoint, offset),
    });
    for (const annotation of model.annotations) annotations.push({ ...annotation, id: `${projection}:${annotation.id}`, geometry: { type: "point", pointMm: move(annotation.geometry.pointMm, offset) } });
    for (const warning of model.warnings) warnings.push({ ...warning, message: `【${VIEW_LABELS[projection]}】${warning.message}` });
    entities.push({ id: `view-label-${projection}`, type: "text", text: VIEW_LABELS[projection], position: [cursorX, height + 500], heightMm: 350, layer: "TEXT", category: "text", source: "derived", confidence: "confirmed", metadata: { view: projection } });
    cursorX += Math.max(1, bounds.max[0] - bounds.min[0]) + VIEW_GAP_MM;
  }
  for (const dimension of dimensions) entities.push(...dimensionEntities(dimension));
  const modelBoundsMm = entitiesBounds(entities), frameAndTitle = base.entities.filter(entity => entity.layer === "FRAME" || entity.layer === "TITLE_BLOCK");
  const composite: DrawingModel = {
    ...base,
    drawingId: `${base.drawingId}-multi-view`,
    drawingCoordinateSystem: "三视图模型空间（XY / XZ / YZ），毫米",
    entities: [...entities, ...frameAndTitle], dimensions, annotations, warnings, modelBoundsMm,
    titleBlock: { ...base.titleBlock, drawingName: "建筑测绘三视总图", drawingCoordinateSystem: "三视图模型空间（XY / XZ / YZ），毫米" },
    parameters: Object.assign({}, base.parameters, { analysisMode: "point-cloud-multi-view", views: [...MULTI_VIEW_ORDER] }),
    statistics: {
      sourcePointCount: base.statistics.sourcePointCount,
      observedWallEntities: MULTI_VIEW_ORDER.reduce((sum, key) => sum + models[key].statistics.observedWallEntities, 0),
      inferredWallEntities: MULTI_VIEW_ORDER.reduce((sum, key) => sum + models[key].statistics.inferredWallEntities, 0),
      roomCount: MULTI_VIEW_ORDER.reduce((sum, key) => sum + models[key].statistics.roomCount, 0),
      doorCount: MULTI_VIEW_ORDER.reduce((sum, key) => sum + models[key].statistics.doorCount, 0),
      windowCount: MULTI_VIEW_ORDER.reduce((sum, key) => sum + models[key].statistics.windowCount, 0),
      annotationCount: MULTI_VIEW_ORDER.reduce((sum, key) => sum + models[key].statistics.annotationCount, 0),
    },
  };
  return fitMultiViewSheet(composite);
}

export function exportMultiViewCadDxf(models: MultiViewModels): Uint8Array {
  return exportCadDxf(createMultiViewDrawing(models));
}
