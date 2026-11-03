import { dimensionEntities, validateDimensions, type CadDimension } from "./dimensions";
import type { PointCloudData } from "../domain/types";
import type { CadPreviewSource } from "./linking";
import {
  buildCadWallEvidenceMap,
  computeCadAlignment,
  computeOrthogonalCadAlignment,
  computeCadSummary,
  extractCadRegions,
  fitOrthogonalWallPlan,
  projectCadPoint,
  transformCadProjectedPoint,
  DEFAULT_CAD_MIN_CELL_POINTS,
  DEFAULT_CAD_MIN_REGION_CELLS,
  type CadAlignment,
  type CadProjection,
  type CadSummary,
  type OrthogonalWallPlan,
  type OrthogonalWallSegment,
} from "./geometry";

export type CadPaperSize = "A0" | "A1" | "A2" | "A3" | "A4";
export type CadLineType = "CONTINUOUS" | "DASHED" | "CENTER";
export type CadEvidenceSource = "observed" | "inferred" | "manual" | "derived";
export type CadConfidence = "measured" | "inferred" | "mixed" | "confirmed";
export type CadWarningSeverity = "error" | "warning" | "info";

export const CAD_LAYER_NAMES = [
  "OBSERVED_WALL", "INFERRED_WALL", "DOOR", "WINDOW", "AXIS", "DIM", "TEXT",
  "FRAME", "TITLE_BLOCK", "POINT_CLOUD", "TOPO_HIDDEN", "FURNITURE",
] as const;
export type CadLayerName = typeof CAD_LAYER_NAMES[number];

export interface CadLayer {
  name: CadLayerName;
  semantic: string;
  lineType: CadLineType;
  color: `#${string}`;
  aciColor: number;
  lineWidthMm: number;
  export: boolean;
}

export const CAD_LAYERS: CadLayer[] = [
  { name: "OBSERVED_WALL", semantic: "有直接点云证据的实测墙段", lineType: "CONTINUOUS", color: "#6FD8FF", aciColor: 4, lineWidthMm: 0.5, export: true },
  { name: "INFERRED_WALL", semantic: "遮挡补齐或算法推断墙段", lineType: "DASHED", color: "#F3A35D", aciColor: 30, lineWidthMm: 0.5, export: true },
  { name: "DOOR", semantic: "门扇、开启弧线和门洞", lineType: "CONTINUOUS", color: "#EAF3FF", aciColor: 7, lineWidthMm: 0.35, export: true },
  { name: "WINDOW", semantic: "窗洞和窗格线", lineType: "CONTINUOUS", color: "#EAF3FF", aciColor: 7, lineWidthMm: 0.35, export: true },
  { name: "AXIS", semantic: "建筑轴网和指北针", lineType: "CENTER", color: "#E2596F", aciColor: 1, lineWidthMm: 0.25, export: true },
  { name: "DIM", semantic: "尺寸界线、尺寸线和尺寸文字", lineType: "CONTINUOUS", color: "#BCD6EE", aciColor: 8, lineWidthMm: 0.25, export: true },
  { name: "TEXT", semantic: "房间名、面积和图纸说明", lineType: "CONTINUOUS", color: "#BCD6EE", aciColor: 8, lineWidthMm: 0.25, export: true },
  { name: "FRAME", semantic: "标准图框", lineType: "CONTINUOUS", color: "#EAF3FF", aciColor: 7, lineWidthMm: 0.5, export: true },
  { name: "TITLE_BLOCK", semantic: "标题栏", lineType: "CONTINUOUS", color: "#BCD6EE", aciColor: 8, lineWidthMm: 0.25, export: true },
  { name: "POINT_CLOUD", semantic: "抽样点云证据", lineType: "CONTINUOUS", color: "#687B82", aciColor: 9, lineWidthMm: 0.13, export: true },
  { name: "TOPO_HIDDEN", semantic: "顶部隐藏点和复核数据", lineType: "CONTINUOUS", color: "#5E6B70", aciColor: 9, lineWidthMm: 0.13, export: false },
  { name: "FURNITURE", semantic: "家具和零散物体", lineType: "CONTINUOUS", color: "#4B555A", aciColor: 9, lineWidthMm: 0.13, export: false },
];

interface CadEntityBase {
  id: string;
  layer: CadLayerName;
  category: "wall" | "door" | "window" | "axis" | "dimension" | "text" | "frame" | "point-evidence";
  source: CadEvidenceSource;
  confidence: CadConfidence;
  metadata?: Record<string, string | number | boolean>;
}

export interface CadLineEntity extends CadEntityBase {
  type: "line";
  start: [number, number];
  end: [number, number];
}

export interface CadPolylineEntity extends CadEntityBase {
  type: "polyline";
  points: Array<[number, number]>;
  closed: boolean;
}

export interface CadTextEntity extends CadEntityBase {
  type: "text";
  text: string;
  position: [number, number];
  heightMm: number;
  rotationDegrees?: number;
}

export interface CadPointEntity extends CadEntityBase {
  type: "point";
  position: [number, number];
}

export type CadEntity = CadLineEntity | CadPolylineEntity | CadTextEntity | CadPointEntity;

export interface CadAnnotation {
  id?: string;
  text: string;
  /**
   * 旧数据默认沿用点云投影坐标（米）；画布交互写入 drawing-mm，
   * 这样标注可以在既有图纸上即时放置和移动，无需重新拟合几何。
   */
  x: number;
  y: number;
  category?: "text" | "room" | "door" | "window";
  coordinateSpace?: "source-m" | "drawing-mm";
  projection?: CadProjection;
}

export interface AnnotationEntity {
  id: string;
  category: "text" | "room" | "door" | "window";
  text: string;
  layer: CadLayerName;
  source: CadEvidenceSource;
  confidence: CadConfidence;
  geometry: { type: "point"; pointMm: [number, number] };
}

export interface DrawingWarning {
  code: string;
  severity: CadWarningSeverity;
  message: string;
  relatedLayer?: CadLayerName;
}

export interface AccuracyMetadata {
  registrationErrorMm?: number;
  registrationStatus: "provided" | "not-provided";
  gridResolutionMm: number;
  fittingEstimateMm: number;
  topPlaneToleranceMm: number;
  roundingMm: number;
  sources: string[];
}

export interface TitleBlock {
  drawingName: string;
  drawingNumber: string;
  scale: string;
  paperSize: CadPaperSize;
  sourceCoordinateSystem: string;
  drawingCoordinateSystem: string;
  units: "mm";
  accuracyNote: string;
  drawnBy: string;
  checkedBy: string;
  drawingDate: string;
  softwareVersion: string;
  dataVersion: string;
  evidenceNote: string;
}

export interface CadBoundsMm {
  min: [number, number];
  max: [number, number];
}

export interface CadDrawingStatistics {
  sourcePointCount: number;
  observedWallEntities: number;
  inferredWallEntities: number;
  roomCount: number;
  doorCount: number;
  windowCount: number;
  annotationCount: number;
}

export interface CadDrawingParameters {
  projection: CadProjection;
  minRegionCells: number;
  minCellPoints: number;
  includePoints: boolean;
  detailDimensions: boolean;
  maxDetailRegions: number;
  orthogonalizeWalls: boolean;
  inferWallGaps: boolean;
  alignToPrincipalAxis: boolean;
  planAlignment?: { angleRadians: number; originM: [number, number]; method: "wall-directions" };
  evidenceMapMethod?: "vertical-persistence" | "small-cloud-fallback";
  evidencePointCount?: number;
  evidenceCellCount?: number;
  topPlaneToleranceM: number;
  roundingMm: number;
}

export interface DrawingModel {
  schemaVersion: "point-view-drawing/1.0.0";
  drawingId: string;
  sourceProjectId?: string;
  sourceName: string;
  units: "mm";
  sourceCoordinateSystem: string;
  drawingCoordinateSystem: string;
  view: "top_xy" | "front_xz" | "side_yz";
  scale: string;
  paperSize: CadPaperSize;
  layers: CadLayer[];
  entities: CadEntity[];
  dimensions?: CadDimension[];
  annotations: AnnotationEntity[];
  titleBlock: TitleBlock;
  northArrow: { direction: "+Y" | "+Z"; label: string };
  accuracy: AccuracyMetadata;
  warnings: DrawingWarning[];
  parameters: CadDrawingParameters;
  statistics: CadDrawingStatistics;
  sourceSummary: CadSummary;
  modelBoundsMm: CadBoundsMm;
  layoutBoundsMm: CadBoundsMm;
  generatedAt: string;
}

export interface CadDrawingSettings {
  includePoints: boolean;
  minRegionCells: number;
  minCellPoints: number;
  detailDimensions: boolean;
  maxDetailRegions: number;
  orthogonalizeWalls: boolean;
  inferWallGaps: boolean;
  alignToPrincipalAxis: boolean;
  paperSize: CadPaperSize;
  scale: string;
  roundingMm: number;
}

export const DEFAULT_CAD_DRAWING_SETTINGS: CadDrawingSettings = {
  includePoints: false,
  minRegionCells: DEFAULT_CAD_MIN_REGION_CELLS,
  minCellPoints: DEFAULT_CAD_MIN_CELL_POINTS,
  detailDimensions: false,
  maxDetailRegions: 12,
  orthogonalizeWalls: true,
  inferWallGaps: false,
  alignToPrincipalAxis: false,
  paperSize: "A3",
  scale: "1:100",
  roundingMm: 10,
};

export interface BuildDrawingModelOptions {
  cloud: PointCloudData;
  projection: CadProjection;
  indices?: Iterable<number>;
  annotations?: CadAnnotation[];
  settings?: Partial<CadDrawingSettings>;
  topPlaneToleranceM?: number;
  sourceProjectId?: string;
  sourceName?: string;
  sourceCoordinateSystem?: string;
  drawingId?: string;
  generatedAt?: string;
  drawnBy?: string;
  checkedBy?: string;
  softwareVersion?: string;
  /** 将生成时的精确坐标参数和墙带源索引交给预览；不序列化到成果包。 */
  onPreviewSource?(source: CadPreviewSource): void;
}

export interface DrawingValidationReport {
  valid: boolean;
  errors: DrawingWarning[];
  warnings: DrawingWarning[];
}

export const PAPER_SIZE_MM: Record<CadPaperSize, [number, number]> = {
  A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210],
};

const mToMm = (value: number) => value * 1_000;
const pointMToMm = (point: [number, number]): [number, number] => [mToMm(point[0]), mToMm(point[1])];

function drawingId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `cad-${Date.now()}`;
}

function scaleDenominator(scale: string): number {
  const match = /^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(scale.trim());
  const value = match ? Number(match[1]) : 100;
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function rectangle(bounds: { minX: number; minY: number; maxX: number; maxY: number }, inset = 0): Array<[number, number]> {
  const minX = bounds.minX + inset;
  const minY = bounds.minY + inset;
  const maxX = bounds.maxX - inset;
  const maxY = bounds.maxY - inset;
  if (minX >= maxX || minY >= maxY) return [];
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
}

function orthogonalWallLine(segment: OrthogonalWallSegment, plan: OrthogonalWallPlan, inset: number): [[number, number], [number, number]] {
  if (segment.side === "bottom") return [[segment.start, plan.bounds.min[1] + inset], [segment.end, plan.bounds.min[1] + inset]];
  if (segment.side === "top") return [[segment.start, plan.bounds.max[1] - inset], [segment.end, plan.bounds.max[1] - inset]];
  if (segment.side === "left") return [[plan.bounds.min[0] + inset, segment.start], [plan.bounds.min[0] + inset, segment.end]];
  return [[plan.bounds.max[0] - inset, segment.start], [plan.bounds.max[0] - inset, segment.end]];
}

function entityBounds(entities: CadEntity[]): CadBoundsMm {
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  const visit = ([x, y]: [number, number]) => {
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y);
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y);
  };
  for (const entity of entities) {
    if (entity.type === "line") { visit(entity.start); visit(entity.end); }
    if (entity.type === "polyline") entity.points.forEach(visit);
    if (entity.type === "text" || entity.type === "point") visit(entity.position);
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0], max: [1, 1] };
  return { min, max };
}

function finiteEntity(entity: CadEntity): boolean {
  const finitePoint = (point: [number, number]) => point.every(Number.isFinite);
  if (entity.type === "line") return finitePoint(entity.start) && finitePoint(entity.end);
  if (entity.type === "polyline") return entity.points.every(finitePoint);
  return finitePoint(entity.position);
}

function representativePoints(
  cloud: PointCloudData,
  projection: CadProjection,
  indices: number[] | undefined,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  planAlignment: CadAlignment | undefined,
  projectedAlignment: CadAlignment | undefined,
  maxPoints = 20_000,
): Array<{ position: [number, number]; sourcePointIndex: number }> {
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1e-6);
  const cellSize = span / 256;
  const sampled = new Set<string>();
  const points: Array<{ position: [number, number]; sourcePointIndex: number }> = [];
  const visit = (index: number) => {
    if (points.length >= maxPoints || !cloud.visible[index]) return;
    const point: [number, number, number] = [cloud.positions[index * 3]!, cloud.positions[index * 3 + 1]!, cloud.positions[index * 3 + 2]!];
    if (!point.every(Number.isFinite)) return;
    const projected = projectCadPoint(point, projection, planAlignment, projectedAlignment);
    if (projected[0] < bounds.minX || projected[0] > bounds.maxX || projected[1] < bounds.minY || projected[1] > bounds.maxY) return;
    const key = `${Math.floor((projected[0] - bounds.minX) / cellSize)}:${Math.floor((projected[1] - bounds.minY) / cellSize)}`;
    if (sampled.has(key)) return;
    sampled.add(key);
    points.push({ position: pointMToMm(projected), sourcePointIndex: index });
  };
  if (indices) indices.forEach(visit);
  else for (let index = 0; index < cloud.positions.length / 3; index += 1) visit(index);
  return points;
}

/**
 * 将点云算法的米制结果一次性转换为毫米制 DrawingModel。
 * Canvas 预览、DXF、标注 JSON 都只消费返回值，不再重复拟合墙体。
 */
export function buildDrawingModel(options: BuildDrawingModelOptions): DrawingModel {
  const settings = { ...DEFAULT_CAD_DRAWING_SETTINGS, ...options.settings };
  const sourceIndices = options.indices ? [...options.indices] : undefined;
  const summary = computeCadSummary(options.cloud, options.projection, sourceIndices);
  if (!summary) throw new Error("当前点云为空，无法生成 CAD 预览");
  const useOrthogonalWallFit = settings.orthogonalizeWalls;
  // 建筑主方向必须在三维点云的 X/Y 平面先统一旋正，再分别做平面/立面投影。
  // 旧流程仅旋正 XY，XZ/YZ 仍沿采集坐标投影，家具和斜墙会生成数百条锯齿轮廓。
  const planAlignment = useOrthogonalWallFit
    ? computeOrthogonalCadAlignment(options.cloud, sourceIndices)
    : undefined;
  const projectedAlignment = !useOrthogonalWallFit && settings.alignToPrincipalAxis
    ? computeCadAlignment(options.cloud, options.projection, sourceIndices)
    : undefined;
  const wallEvidence = useOrthogonalWallFit
    ? buildCadWallEvidenceMap(options.cloud, {
      gridSize: 256,
      minRegionCells: settings.minRegionCells,
      minCellPoints: settings.minCellPoints,
      alignment: planAlignment,
      indices: sourceIndices,
    })
    : undefined;
  if (useOrthogonalWallFit && !wallEvidence) {
    throw new Error("二维墙体证据不足：未找到跨高度持续存在的墙带，请框选建筑范围或降低证据阈值");
  }
  const evidenceIndices = wallEvidence?.indices ?? sourceIndices;
  const regionResult = extractCadRegions(options.cloud, options.projection, {
    gridSize: 256,
    minRegionCells: settings.minRegionCells,
    minCellPoints: settings.minCellPoints,
    alignment: projectedAlignment,
    planAlignment,
    indices: evidenceIndices,
    verticalPersistence: false,
  });
  if (!regionResult?.regions.length) {
    throw new Error(options.projection === "xy"
      ? "未识别到跨高度连续的墙体，请框选建筑范围或降低成块过滤阈值"
      : "未识别到可生成预览的连续投影轮廓");
  }

  const exportRegions = regionResult.regions.slice(0, 32);
  const orthogonalCandidate = useOrthogonalWallFit
    ? fitOrthogonalWallPlan({ ...regionResult, regions: exportRegions }, { inferGaps: settings.inferWallGaps })
    : undefined;
  const minimumCoverage = wallEvidence?.method === "small-cloud-fallback" ? 0 : 0.2;
  const orthogonalPlan = orthogonalCandidate && orthogonalCandidate.observedCoverage >= minimumCoverage ? orthogonalCandidate : undefined;
  if (useOrthogonalWallFit && !orthogonalPlan) {
    throw new Error("二维墙体证据覆盖不足：严格实测模式不会用外包络或家具轮廓补成墙体");
  }
  const boundsM = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  if (orthogonalPlan) {
    boundsM.minX = orthogonalPlan.bounds.min[0]; boundsM.minY = orthogonalPlan.bounds.min[1];
    boundsM.maxX = orthogonalPlan.bounds.max[0]; boundsM.maxY = orthogonalPlan.bounds.max[1];
  } else for (const region of exportRegions) for (const contour of region.contours) for (const point of contour) {
      boundsM.minX = Math.min(boundsM.minX, point[0]); boundsM.minY = Math.min(boundsM.minY, point[1]);
      boundsM.maxX = Math.max(boundsM.maxX, point[0]); boundsM.maxY = Math.max(boundsM.maxY, point[1]);
    }
  const sizeM = Math.max(boundsM.maxX - boundsM.minX, boundsM.maxY - boundsM.minY, 1);
  const scaleFactor = scaleDenominator(settings.scale);
  const paperTextMm = 2.5 * scaleFactor;
  const drawingTextMm = paperTextMm;
  const entities: CadEntity[] = [];
  const annotations: AnnotationEntity[] = [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${String(++sequence).padStart(4, "0")}`;
  const pushLine = (start: [number, number], end: [number, number], layer: CadLayerName, category: CadLineEntity["category"], source: CadEvidenceSource, confidence: CadConfidence, metadata?: CadEntityBase["metadata"]) =>
    entities.push({ id: nextId(category), type: "line", start, end, layer, category, source, confidence, metadata });
  const pushText = (text: string, position: [number, number], heightMm: number, layer: CadLayerName, category: CadTextEntity["category"], source: CadEvidenceSource, confidence: CadConfidence, metadata?: CadEntityBase["metadata"], rotationDegrees?: number) =>
    entities.push({ id: nextId(category), type: "text", text, position, heightMm, layer, category, source, confidence, metadata, rotationDegrees });

  if (orthogonalPlan) {
    for (const segment of [...orthogonalPlan.observed, ...orthogonalPlan.inferred]) {
      // 严格证据模式只保留证据边界本身；第二条估算墙厚线仅在显式允许推断时出现。
      for (const inset of settings.inferWallGaps ? [0, orthogonalPlan.wallThickness] : [0]) {
        const [start, end] = orthogonalWallLine(segment, orthogonalPlan, inset).map(pointMToMm) as [[number, number], [number, number]];
        entities.push({
          id: nextId(`${segment.source}-wall`), type: "line", start, end,
          layer: segment.source === "observed" ? "OBSERVED_WALL" : "INFERRED_WALL",
          category: "wall", source: segment.source, confidence: segment.source === "observed" ? "measured" : "inferred",
          metadata: {
            side: segment.side,
            wallThicknessMm: mToMm(orthogonalPlan.wallThickness),
            fit: "2d-evidence-map-interval",
            evidenceCellSizeMm: mToMm(wallEvidence?.cellSize ?? regionResult.cellSize),
            evidencePointCount: wallEvidence?.indices.length ?? 0,
          },
        });
      }
    }
  } else for (const region of exportRegions) for (const [contourIndex, contour] of region.contours.entries()) {
      entities.push({
        id: nextId("observed-wall"), type: "polyline", points: contour.map(pointMToMm), closed: true,
        layer: "OBSERVED_WALL", category: "wall", source: "observed", confidence: "measured",
        metadata: { regionId: region.id + 1, contourIndex: contourIndex + 1, evidenceCells: region.cells },
      });
    }

  if (settings.inferWallGaps && options.projection === "xy" && !orthogonalPlan) {
    const inferredWallThicknessM = Math.min(0.25, Math.max(0.08, regionResult.cellSize * 3));
    for (const [index, contour] of [rectangle(boundsM), rectangle(boundsM, inferredWallThicknessM)].entries()) {
      if (contour.length < 3) continue;
      entities.push({
        id: nextId("inferred-wall"), type: "polyline", points: contour.map(pointMToMm), closed: true,
        layer: "INFERRED_WALL", category: "wall", source: "inferred", confidence: "inferred",
        metadata: { envelope: index === 0 ? "outer" : "inner", wallThicknessMm: mToMm(inferredWallThicknessM) },
      });
    }
  }

  const minX = mToMm(boundsM.minX); const minY = mToMm(boundsM.minY);
  const maxX = mToMm(boundsM.maxX); const maxY = mToMm(boundsM.maxY);
  const sizeMm = mToMm(sizeM);
  const dimensionOffset = sizeMm * 0.1;
  const dimensions: CadDimension[] = [];
  const dimension = (start: [number,number], end: [number,number], linePoint: [number,number], height=drawingTextMm) => {
    if (Math.hypot(end[0]-start[0],end[1]-start[1])<1e-6) return;
    const d:CadDimension={id:nextId("dimension"),kind:"aligned",start,end,linePoint,textHeightMm:height,roundingMm:settings.roundingMm,source:"derived"};
    dimensions.push(d);entities.push(...dimensionEntities(d));
  };
  dimension([minX,minY],[maxX,minY],[minX,minY-dimensionOffset]);
  dimension([minX,minY],[minX,maxY],[minX-dimensionOffset,minY]);
  if (settings.detailDimensions) {
    const detailOffset=Math.max(sizeMm*.045,drawingTextMm*2.5);
    for(const region of exportRegions.slice(0,settings.maxDetailRegions)){
      const x1=mToMm(region.bounds.min[0]),y1=mToMm(region.bounds.min[1]),x2=mToMm(region.bounds.max[0]);
      dimension([x1,y1],[x2,y1],[x1,y1-detailOffset],drawingTextMm*.72);
    }
  }

  if (settings.includePoints) {
    for (const point of representativePoints(options.cloud, options.projection, evidenceIndices, boundsM, planAlignment, projectedAlignment)) {
      entities.push({ id: nextId("point-evidence"), type: "point", position: point.position, layer: "POINT_CLOUD", category: "point-evidence", source: "observed", confidence: "measured", metadata: { sourcePointIndex: point.sourcePointIndex } });
    }
  }

  for (const annotation of options.annotations ?? []) {
    if (annotation.projection && annotation.projection !== options.projection) continue;
    const transformed = annotation.coordinateSpace === "drawing-mm"
      ? [annotation.x, annotation.y] as [number, number]
      : pointMToMm(transformCadProjectedPoint([annotation.x, annotation.y], projectedAlignment));
    const pointMm = transformed;
    const id = annotation.id ?? nextId("annotation");
    const category = annotation.category ?? "text";
    const layer: CadLayerName = category === "door" ? "DOOR" : category === "window" ? "WINDOW" : "TEXT";
    annotations.push({ id, category, text: annotation.text, layer, source: "manual", confidence: "confirmed", geometry: { type: "point", pointMm } });
    entities.push({ id: `${id}-label`, type: "text", text: annotation.text, position: pointMm, heightMm: drawingTextMm, layer, category: category === "door" ? "door" : category === "window" ? "window" : "text", source: "manual", confidence: "confirmed" });
  }

  const northSize = 8 * scaleFactor;
  const northX = maxX - northSize * 0.7; const northY = maxY - northSize * 0.2;
  pushLine([northX, northY - northSize], [northX, northY], "AXIS", "axis", "derived", "confirmed");
  pushLine([northX, northY], [northX - northSize * 0.18, northY - northSize * 0.32], "AXIS", "axis", "derived", "confirmed");
  pushLine([northX, northY], [northX + northSize * 0.18, northY - northSize * 0.32], "AXIS", "axis", "derived", "confirmed");
  pushText(options.projection === "xy" ? "+Y" : "+Z", [northX + northSize * 0.16, northY - drawingTextMm * 0.3], drawingTextMm, "AXIS", "axis", "derived", "confirmed");

  const modelBoundsMm = entityBounds(entities);
  const [paperWidthMm, paperHeightMm] = PAPER_SIZE_MM[settings.paperSize];
  const frameWidth = paperWidthMm * scaleFactor; const frameHeight = paperHeightMm * scaleFactor;
  const centerX = (modelBoundsMm.min[0] + modelBoundsMm.max[0]) / 2;
  const centerY = (modelBoundsMm.min[1] + modelBoundsMm.max[1]) / 2 - 25 * scaleFactor;
  const frameBounds = {
    minX: centerX - frameWidth / 2, minY: centerY - frameHeight / 2,
    maxX: centerX + frameWidth / 2, maxY: centerY + frameHeight / 2,
  };
  const margin = 10 * scaleFactor;
  entities.push({ id: nextId("frame"), type: "polyline", points: rectangle(frameBounds).map((point) => [point[0], point[1]]), closed: true, layer: "FRAME", category: "frame", source: "derived", confidence: "confirmed" });
  entities.push({ id: nextId("frame"), type: "polyline", points: rectangle(frameBounds, margin).map((point) => [point[0], point[1]]), closed: true, layer: "FRAME", category: "frame", source: "derived", confidence: "confirmed" });

  const titleWidth = Math.min(180 * scaleFactor, frameWidth - margin * 2);
  const titleHeight = Math.min(50 * scaleFactor, frameHeight * 0.28);
  const titleMinX = frameBounds.maxX - margin - titleWidth;
  const titleMinY = frameBounds.minY + margin;
  const titleBounds = { minX: titleMinX, minY: titleMinY, maxX: titleMinX + titleWidth, maxY: titleMinY + titleHeight };
  entities.push({ id: nextId("title-block"), type: "polyline", points: rectangle(titleBounds), closed: true, layer: "TITLE_BLOCK", category: "frame", source: "derived", confidence: "confirmed" });
  for (const ratio of [0.25, 0.5, 0.75]) pushLine([titleMinX, titleMinY + titleHeight * ratio], [titleMinX + titleWidth, titleMinY + titleHeight * ratio], "TITLE_BLOCK", "frame", "derived", "confirmed");
  const titleTextHeight = Math.max(2.5 * scaleFactor, 80);
  const titleBlock: TitleBlock = {
    drawingName: `${options.sourceName ?? "当前点云"} CAD ${options.projection === "xy" ? "平面图" : options.projection === "xz" ? "正立面图" : "侧立面图"}`, drawingNumber: options.drawingId ?? "PV-CAD-001",
    scale: settings.scale, paperSize: settings.paperSize,
    sourceCoordinateSystem: options.sourceCoordinateSystem ?? options.cloud.frameId ?? "LOCAL_ENU",
    drawingCoordinateSystem: planAlignment?.method === "wall-histogram"
      ? "ORTHOGONAL_WALL_ALIGNED_LOCAL"
      : projectedAlignment
        ? "PCA_ALIGNED_LOCAL"
        : (options.sourceCoordinateSystem ?? options.cloud.frameId ?? "LOCAL_ENU"),
    units: "mm",
    accuracyNote: `格网 ${Math.round(mToMm(regionResult.cellSize))} mm；拟合估计 ±${Math.round(mToMm(regionResult.cellSize) / 2)} mm；取整 ${settings.roundingMm} mm`,
    drawnBy: options.drawnBy ?? "Point View", checkedBy: options.checkedBy ?? "待审核",
    drawingDate: (options.generatedAt ?? new Date().toISOString()).slice(0, 10), softwareVersion: options.softwareVersion ?? "Point View 0.1.6",
    dataVersion: options.cloud.id,
    evidenceNote: settings.inferWallGaps
      ? "OBSERVED_WALL=二维证据地图实测区间；INFERRED_WALL=显式启用的缺口辅助线"
      : "OBSERVED_WALL=二维证据地图实测区间；无证据缺口保持断开",
  };
  pushText(titleBlock.drawingName, [titleMinX + titleTextHeight, titleMinY + titleHeight * 0.79], titleTextHeight * 1.2, "TITLE_BLOCK", "text", "derived", "confirmed");
  pushText(`图号 ${titleBlock.drawingNumber}  比例 ${titleBlock.scale}  图幅 ${titleBlock.paperSize}`, [titleMinX + titleTextHeight, titleMinY + titleHeight * 0.56], titleTextHeight, "TITLE_BLOCK", "text", "derived", "confirmed");
  pushText(`单位 mm  坐标 ${titleBlock.drawingCoordinateSystem}`, [titleMinX + titleTextHeight, titleMinY + titleHeight * 0.32], titleTextHeight, "TITLE_BLOCK", "text", "derived", "confirmed");
  pushText(titleBlock.evidenceNote, [titleMinX + titleTextHeight, titleMinY + titleHeight * 0.08], titleTextHeight * 0.85, "TITLE_BLOCK", "text", "derived", "confirmed");

  const warnings: DrawingWarning[] = [
    { code: "UNIT_CONVERTED_TO_MM", severity: "info", message: "点云米制坐标已在 DrawingModel 边界统一转换为毫米。" },
    { code: "ROOM_AREA_NOT_AVAILABLE", severity: "warning", message: "尚无可靠房间内边界，未生成房间净面积；可见点凸包面积仅作覆盖质控。", relatedLayer: "TEXT" },
    { code: "OPENING_RECOGNITION_NOT_AVAILABLE", severity: "warning", message: "当前算法未提供可靠门窗识别，DOOR/WINDOW 图层仅保留人工标注。", relatedLayer: "DOOR" },
    { code: "REGISTRATION_ERROR_NOT_PROVIDED", severity: "warning", message: "源数据未提供配准误差，标题栏仅记录格网、拟合与取整误差来源。" },
    { code: "DXF_UNICODE_FALLBACK", severity: "info", message: "DXF 中文使用 Unicode 转义；旧版 CAD 字体缺失时可能需要替换文字样式。", relatedLayer: "TEXT" },
  ];
  if (entities.some((entity) => entity.layer === "INFERRED_WALL")) warnings.unshift({ code: "INFERRED_CONTENT", severity: "warning", message: "图纸含正交包络推断墙体，导出前必须人工复核。", relatedLayer: "INFERRED_WALL" });
  if (wallEvidence) warnings.push({
    code: "EVIDENCE_MAP_DRIVEN", severity: "info",
    message: wallEvidence.method === "vertical-persistence"
      ? `已建立 ${wallEvidence.gridSize}×${wallEvidence.gridSize} XY 多高度证据地图（格网 ${Math.round(mToMm(wallEvidence.cellSize))} mm，${wallEvidence.requiredLayers}/${wallEvidence.layerCount} 层持续）；三视图仅使用墙带内 ${wallEvidence.indices.length.toLocaleString()} 点。`
      : "点数不足以建立跨高度地图；当前小型点云使用全部有效点并保留回退标记。",
    relatedLayer: "OBSERVED_WALL",
  });
  if (orthogonalPlan) warnings.push({
    code: "ORTHOGONAL_WALL_FIT", severity: "info",
    message: settings.inferWallGaps
      ? `墙体证据覆盖 ${(orthogonalPlan.observedCoverage * 100).toFixed(1)}%；已显式启用缺口辅助线，必须人工复核。`
      : `墙体证据覆盖 ${(orthogonalPlan.observedCoverage * 100).toFixed(1)}%；严格实测模式未补齐任何无证据缺口。`,
    relatedLayer: "OBSERVED_WALL",
  });
  if (planAlignment?.method === "wall-histogram") warnings.push({ code: "ORTHOGONAL_ALIGNMENT", severity: "info", message: `已在三维点云 X/Y 平面按墙面直方图自动旋正 ${(planAlignment.angleRadians * 180 / Math.PI).toFixed(2)}°（方向置信度 ${(planAlignment.confidence ?? 1).toFixed(2)}），所有投影视图共用该建筑轴线。`, relatedLayer: "AXIS" });
  else if (projectedAlignment) warnings.push({ code: "PCA_ALIGNMENT", severity: "info", message: `已执行 PCA 辅助旋正 ${(projectedAlignment.angleRadians * 180 / Math.PI).toFixed(2)}°，出图坐标与采集坐标方向不同。`, relatedLayer: "AXIS" });
  const innerFrameWidth = frameWidth - margin * 2;
  const innerFrameHeight = frameHeight - margin * 2 - titleHeight;
  if (modelBoundsMm.max[0] - modelBoundsMm.min[0] > innerFrameWidth || modelBoundsMm.max[1] - modelBoundsMm.min[1] > innerFrameHeight) {
    warnings.push({ code: "DRAWING_EXCEEDS_FRAME", severity: "warning", message: `当前内容可能超出 ${settings.paperSize} ${settings.scale} 图框，建议调整图幅或比例。`, relatedLayer: "FRAME" });
  }

  const model: DrawingModel = {
    schemaVersion: "point-view-drawing/1.0.0",
    drawingId: options.drawingId ?? drawingId(), sourceProjectId: options.sourceProjectId, sourceName: options.sourceName ?? "当前点云", units: "mm",
    sourceCoordinateSystem: titleBlock.sourceCoordinateSystem, drawingCoordinateSystem: titleBlock.drawingCoordinateSystem,
    view: options.projection === "xy" ? "top_xy" : options.projection === "xz" ? "front_xz" : "side_yz",
    scale: settings.scale, paperSize: settings.paperSize, layers: CAD_LAYERS.map((layer) => ({ ...layer })), entities, dimensions, annotations,
    titleBlock, northArrow: { direction: options.projection === "xy" ? "+Y" : "+Z", label: options.projection === "xy" ? "+Y" : "+Z" },
    accuracy: {
      registrationStatus: "not-provided", gridResolutionMm: mToMm(wallEvidence?.cellSize ?? regionResult.cellSize), fittingEstimateMm: mToMm(regionResult.cellSize) / 2,
      topPlaneToleranceMm: mToMm(options.topPlaneToleranceM ?? 0.08), roundingMm: settings.roundingMm,
      sources: ["registration:not-provided", "wall-evidence:xy-vertical-persistence", "fitting:grid-cell/2", "rounding:configured"],
    },
    warnings,
    parameters: {
      projection: options.projection, minRegionCells: settings.minRegionCells, minCellPoints: settings.minCellPoints,
      includePoints: settings.includePoints, detailDimensions: settings.detailDimensions, maxDetailRegions: settings.maxDetailRegions,
      orthogonalizeWalls: settings.orthogonalizeWalls, inferWallGaps: settings.inferWallGaps,
      alignToPrincipalAxis: settings.alignToPrincipalAxis, topPlaneToleranceM: options.topPlaneToleranceM ?? 0.08,
      roundingMm: settings.roundingMm, evidenceMapMethod: wallEvidence?.method,
      evidencePointCount: wallEvidence?.indices.length, evidenceCellCount: wallEvidence?.occupiedCells,
    },
    statistics: {
      sourcePointCount: summary.pointCount,
      observedWallEntities: entities.filter((entity) => entity.layer === "OBSERVED_WALL").length,
      inferredWallEntities: entities.filter((entity) => entity.layer === "INFERRED_WALL").length,
      roomCount: annotations.filter((annotation) => annotation.category === "room").length,
      doorCount: annotations.filter((annotation) => annotation.category === "door").length,
      windowCount: annotations.filter((annotation) => annotation.category === "window").length,
      annotationCount: annotations.length,
    },
    sourceSummary: summary, modelBoundsMm, layoutBoundsMm: { min: [frameBounds.minX, frameBounds.minY], max: [frameBounds.maxX, frameBounds.maxY] },
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
  refreshCadTitle(model);
  const report = validateDrawingModel(model);
  if (!report.valid) throw new Error(`CAD 模型校验失败：${report.errors.map((item) => item.message).join("；")}`);
  options.onPreviewSource?.({ drawingId: model.drawingId, cloud: options.cloud, indices: evidenceIndices, projection: options.projection, planAlignment, projectedAlignment });
  return model;
}

function projectionForView(view: DrawingModel["view"]): CadProjection {
  return view === "top_xy" ? "xy" : view === "front_xz" ? "xz" : "yz";
}

/**
 * 只替换 DrawingModel 的人工标注图层，不重新计算墙体、尺寸、图框或证据。
 * 用于标注的新增、改名、拖动和删除，以及导出前的最后一次状态同步。
 */
export function applyCadAnnotations(model: DrawingModel, source: CadAnnotation[]): DrawingModel {
  const projection = projectionForView(model.view);
  const annotations = source.filter((annotation) => !annotation.projection || annotation.projection === projection);
  const previousPoints = new Map(model.annotations.map((annotation) => [annotation.id, annotation.geometry.pointMm]));
  const previousHeights = new Map(model.entities.flatMap((entity) => entity.source === "manual" && entity.type === "text"
    ? [[entity.id.replace(/-label$/, ""), entity.heightMm] as const]
    : []));
  const generatedEntities = model.entities.filter((entity) => entity.source !== "manual" || !!entity.metadata?.dimensionId);
  const defaultHeightMm = 2.5 * scaleDenominator(model.scale);
  const annotationEntities: CadEntity[] = [];
  const modelAnnotations: AnnotationEntity[] = [];

  for (const annotation of annotations) {
    const id = annotation.id ?? drawingId();
    const category = annotation.category ?? "text";
    const layer: CadLayerName = category === "door" ? "DOOR" : category === "window" ? "WINDOW" : "TEXT";
    const pointMm: [number, number] = annotation.coordinateSpace === "drawing-mm"
      ? [annotation.x, annotation.y]
      : previousPoints.get(id) ?? pointMToMm([annotation.x, annotation.y]);
    modelAnnotations.push({
      id,
      category,
      text: annotation.text,
      layer,
      source: "manual",
      confidence: "confirmed",
      geometry: { type: "point", pointMm },
    });
    annotationEntities.push({
      id: `${id}-label`,
      type: "text",
      text: annotation.text,
      position: pointMm,
      heightMm: previousHeights.get(id) ?? defaultHeightMm,
      layer,
      category: category === "door" ? "door" : category === "window" ? "window" : "text",
      source: "manual",
      confidence: "confirmed",
    });
  }

  const entities = [...generatedEntities, ...annotationEntities];
  return {
    ...model,
    entities,
    annotations: modelAnnotations,
    statistics: {
      ...model.statistics,
      roomCount: modelAnnotations.filter((annotation) => annotation.category === "room").length,
      doorCount: modelAnnotations.filter((annotation) => annotation.category === "door").length,
      windowCount: modelAnnotations.filter((annotation) => annotation.category === "window").length,
      annotationCount: modelAnnotations.length,
    },
  };
}

export function validateDrawingModel(model: DrawingModel): DrawingValidationReport {
  const errors: DrawingWarning[] = [];
  const warnings: DrawingWarning[] = [];
  const layerNames = new Set(model.layers.map((layer) => layer.name));
  if (model.units !== "mm") errors.push({ code: "INVALID_UNITS", severity: "error", message: "DrawingModel 必须使用毫米单位。" });
  if (!model.entities.length) errors.push({ code: "EMPTY_MODEL", severity: "error", message: "DrawingModel 不包含任何可绘制实体。" });
  for (const message of validateDimensions(model)) errors.push({code:"INVALID_DIMENSION",severity:"error",message});
  const ids = new Set<string>();
  for (const entity of model.entities) {
    if (ids.has(entity.id)) errors.push({ code: "DUPLICATE_ENTITY_ID", severity: "error", message: `实体 ID 重复：${entity.id}` });
    ids.add(entity.id);
    if (!layerNames.has(entity.layer)) errors.push({ code: "UNKNOWN_LAYER", severity: "error", message: `实体 ${entity.id} 引用了未定义图层 ${entity.layer}` });
    if (!finiteEntity(entity)) errors.push({ code: "NON_FINITE_COORDINATE", severity: "error", message: `实体 ${entity.id} 含非法坐标。`, relatedLayer: entity.layer });
    if (entity.type === "polyline" && entity.points.length < 2) errors.push({ code: "DEGENERATE_POLYLINE", severity: "error", message: `实体 ${entity.id} 为退化多段线。`, relatedLayer: entity.layer });
    if (entity.type === "text" && (!entity.text.trim() || !Number.isFinite(entity.heightMm) || entity.heightMm <= 0)) errors.push({ code: "INVALID_TEXT", severity: "error", message: `文字实体 ${entity.id} 无效。`, relatedLayer: entity.layer });
  }
  if (!model.entities.some((entity) => entity.layer === "OBSERVED_WALL")) warnings.push({ code: "NO_OBSERVED_WALL", severity: "warning", message: "图纸没有实测墙体实体。", relatedLayer: "OBSERVED_WALL" });
  const requiredTitleFields = [model.titleBlock.drawingName, model.titleBlock.drawingNumber, model.titleBlock.scale, model.titleBlock.sourceCoordinateSystem, model.titleBlock.drawingCoordinateSystem, model.titleBlock.accuracyNote];
  if (requiredTitleFields.some((value) => !value.trim())) errors.push({ code: "INCOMPLETE_TITLE_BLOCK", severity: "error", message: "标题栏必填字段不完整。", relatedLayer: "TITLE_BLOCK" });
  if (model.entities.some((entity) => entity.layer === "INFERRED_WALL") && !model.warnings.some((item) => item.code === "INFERRED_CONTENT")) {
    errors.push({ code: "MISSING_INFERRED_WARNING", severity: "error", message: "图纸含推断墙体但缺少显式警告。", relatedLayer: "INFERRED_WALL" });
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** 标题栏显示与元数据共用字段，避免派生后仍显示旧算法或旧比例。 */
export function refreshCadTitle(model:DrawingModel):void {
  const t=model.titleBlock;
  const values:Record<string,string>={name:t.drawingName,info:`图号 ${t.drawingNumber}  比例 ${t.scale}  图幅 ${t.paperSize}  日期 ${t.drawingDate}`,coordinate:`单位 mm  坐标 ${t.drawingCoordinateSystem}  制图 ${t.drawnBy}  校核 ${t.checkedBy}`,quality:`复核图 · ${t.accuracyNote}`};
  for(const e of model.entities)if(e.layer==='TITLE_BLOCK'&&e.type==='text'){
    const field=typeof e.metadata?.titleField==='string'?e.metadata.titleField:e.text===t.drawingName?'name':e.text.startsWith('图号 ')?'info':e.text.startsWith('单位 mm')?'coordinate':e.text.startsWith('OBSERVED_WALL=')||e.text===t.evidenceNote?'quality':undefined;
    if(field&&values[field]){e.text=values[field]!;e.metadata={...e.metadata,titleField:field};}
  }
}
