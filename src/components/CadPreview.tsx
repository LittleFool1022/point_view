import { snapCadEndpoint, dimensionMeasurement, type CadDimension, type CadPoint2 } from "../cad/dimensions";
import { Crosshair, Eye, EyeOff, Grid2X2, Layers3, Maximize2, Minus, Plus, ScanLine, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import type { CadAnnotation, CadBoundsMm, CadEntity, CadLayerName, DrawingModel } from "../cad/model";
import type { CadProjection } from "../cad/geometry";

export interface CadPreviewLink {
  enabled: boolean;
  highlightedIds: readonly string[];
  pinnedId?: string;
  drawingPoint?: [number, number];
  focusRequest?: { token: number; point: [number, number]; radiusMm?: number; fit?: boolean };
  onHoverEntity(id?: string): void;
  onSelectEntity(id?: string): void;
  onVisibleEntitiesChange(ids: string[]): void;
}

/** 尺寸几何修订：选中尺寸后，拖动其关联图元的端点（或改数值）后交回外部提交。 */
export interface DimensionRevisionHandlers {
  /** 图纸上可直接拖动修订的端点（命中测试优先于选择/放置标注）。 */
  draggable?: boolean;
  /** 选中尺寸关联的图元端点；空数组时界面明确提示无关联对象。 */
  candidates: ReadonlyArray<{ entityId: string; vertexIndex: number; current: CadPoint2; label: string }>;
  /** 正在修订的端点（点“修订端点”进入）；undefined 时画布不进入端点模式。 */
  active?: { entityId: string; vertexIndex: number };
  disabled?: boolean;
  onActiveChange?(active: { entityId: string; vertexIndex: number } | undefined): void;
  /** 端点松开鼠标后给出新图纸毫米坐标，由外部换算修订量、提交并记录。 */
  onCommit(entityId: string, vertexIndex: number, point: CadPoint2): void;
}

interface CadPreviewProps {
  /** 尺寸修订手柄：只对被选中尺寸的关联端点生效。 */
  revision?: DimensionRevisionHandlers;
  dimensionMode?: CadDimension['kind'];
  onCreateDimension?(start:CadPoint2,end:CadPoint2,linePoint:CadPoint2):void;
  onDeleteDimension?(id:string):void;
  /** 选中尺寸或改尺寸线位置时回传给外部核验面板，保持唯一选中的尺寸。 */
  selectedDimensionId?:string;
  onSelectedDimensionChange?(id?:string):void;
  onMoveDimensionLine?(id:string,linePoint:CadPoint2):void;
  lightMode?: boolean;
  model?: DrawingModel;
  stale?: boolean;
  projection: CadProjection;
  annotations: CadAnnotation[];
  placingAnnotation?: Pick<CadAnnotation, "text" | "category">;
  selectedAnnotationId?: string;
  onPlaceAnnotation(pointMm: [number, number]): void;
  onMoveAnnotation(id: string, pointMm: [number, number]): void;
  onDeleteAnnotation(id: string): void;
  onSelectedAnnotationChange(id?: string): void;
  link?: CadPreviewLink;
}

type Point = [number, number];
// 白底预览使用同语义深色线条；不改图层原色或导出内容。
const LIGHT_LAYER_COLORS: Record<CadLayerName, string> = {
  OBSERVED_WALL: "#26353d", INFERRED_WALL: "#725a40", DOOR: "#286746", WINDOW: "#1d617d",
  AXIS: "#8b4b4b", DIM: "#645222", TEXT: "#26353d", FRAME: "#465158", TITLE_BLOCK: "#465158",
  POINT_CLOUD: "#687b82", TOPO_HIDDEN: "#7a858a", FURNITURE: "#596a62",
};
type DisplayAnnotation = { id: string; annotation: CadAnnotation; pointMm: Point };
type CanvasDrag =
  | { mode: "pan"; x: number; y: number; moved: boolean }
  | { mode: "annotation"; id: string; x: number; y: number; moved: boolean; pointMm: Point }
  | { mode: "revision"; x: number; y: number; entityId: string; vertexIndex: number; pointMm: Point; moved: boolean }
  | { mode: "place" | "dimension"; x: number; y: number; moved: boolean };

const CAD_LAYER_LABELS: Record<CadLayerName, string> = {
  OBSERVED_WALL: "实测墙体",
  INFERRED_WALL: "辅助墙体",
  DOOR: "门",
  WINDOW: "窗",
  AXIS: "轴线",
  DIM: "尺寸",
  TEXT: "文字",
  FRAME: "图框",
  TITLE_BLOCK: "标题栏",
  POINT_CLOUD: "原始点",
  TOPO_HIDDEN: "隐藏点",
  FURNITURE: "家具",
};

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0]; const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}

function formatEntity(entity: CadEntity): string {
  if (entity.type === "text") return entity.text;
  if (entity.type === "polyline") return `${entity.points.length} 个顶点${entity.closed ? " · 闭合" : ""}`;
  if (entity.type === "line") return `长度 ${Math.round(Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]))} mm`;
  return `(${Math.round(entity.position[0])}, ${Math.round(entity.position[1])}) mm`;
}

function annotationLayer(category: CadAnnotation["category"]): CadLayerName {
  return category === "door" ? "DOOR" : category === "window" ? "WINDOW" : "TEXT";
}

function annotationScreenRect(annotation: DisplayAnnotation, point: Point) {
  const width = Math.max(52, annotation.annotation.text.length * 14 + 24);
  return { left: point[0] + 9, top: point[1] - 17, width, height: 34 };
}

export function CadPreview({
  revision,
  dimensionMode, onCreateDimension, onDeleteDimension,
  selectedDimensionId, onSelectedDimensionChange, onMoveDimensionLine,
  lightMode = false,
  model,
  stale = false,
  projection,
  annotations,
  placingAnnotation,
  selectedAnnotationId,
  onPlaceAnnotation,
  onMoveAnnotation,
  onDeleteAnnotation,
  onSelectedAnnotationChange,
  link,
}: CadPreviewProps) {
  const [dimensionPoints,setDimensionPoints]=useState<CadPoint2[]>([]);
  const [snapPoint,setSnapPoint]=useState<CadPoint2>();
  /** 只改尺寸线位置，保持尺寸定义点不动，避免把旧尺寸贴到新几何。 */
  const [lineMove,setLineMove]=useState<string>();
  useEffect(()=>{setDimensionPoints([]);setSnapPoint(undefined);},[dimensionMode,model?.drawingId,stale]);
  useEffect(()=>{setLineMove(undefined);},[model?.drawingId,stale,dimensionMode]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<CanvasDrag | undefined>(undefined);
  const hoverRef = useRef<string | undefined>(undefined);
  const hoverTimeRef = useRef(0);
  const focusFrameRef = useRef(0);
  const [size, setSize] = useState({ width: 640, height: 480 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>([0, 0]);
  const [layoutMode, setLayoutMode] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [annotationDrag, setAnnotationDrag] = useState<{ id: string; pointMm: Point }>();
  /** 修订端点的拖动预览：松开鼠标才提交，Esc 或失焦丢弃。 */
  const [revisionDrag, setRevisionDrag] = useState<{ entityId: string; vertexIndex: number; pointMm: Point }>();
  const [visibility, setVisibility] = useState<Partial<Record<CadLayerName, boolean>>>({});

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(1, Math.floor(entry?.contentRect.width ?? element.clientWidth));
      const height = Math.max(1, Math.floor(entry?.contentRect.height ?? element.clientHeight));
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [model?.drawingId]);

  useEffect(() => {
    setZoom(1); setPan([0, 0]); setSelectedId(undefined); setLayoutMode(false); setLayersOpen(false);
    if (model) setVisibility(Object.fromEntries(model.layers.map((layer) => [layer.name, true])));
  }, [model?.drawingId]);

  useEffect(() => {
    if (placingAnnotation) canvasRef.current?.focus();
  }, [placingAnnotation]);

  const bounds = useMemo<CadBoundsMm>(() => {
    if (!model) return { min: [0, 0], max: [1, 1] };
    return layoutMode ? model.layoutBoundsMm : model.modelBoundsMm;
  }, [layoutMode, model]);
  const center = useMemo<Point>(() => [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2], [bounds]);
  const fitScale = Math.max(1e-6, Math.min((size.width - 48) / Math.max(1, bounds.max[0] - bounds.min[0]), (size.height - 48) / Math.max(1, bounds.max[1] - bounds.min[1])));
  const scale = fitScale * zoom;
  const toScreen = (point: Point): Point => [size.width / 2 + pan[0] + (point[0] - center[0]) * scale, size.height / 2 + pan[1] - (point[1] - center[1]) * scale];
  const fromScreen = (point: Point): Point => [
    center[0] + (point[0] - size.width / 2 - pan[0]) / scale,
    center[1] - (point[1] - size.height / 2 - pan[1]) / scale,
  ];

  /** 尺寸修订手柄：插件显式进入端点模式，或开启了可选端点拖动。 */
  const revisionHandles = !!revision && !revision.disabled && !stale && (!!revision.active || !!revision.draggable);

  const displayAnnotations = useMemo<DisplayAnnotation[]>(() => {
    if (!model) return [];
    const modelPoints = new Map(model.annotations.map((annotation) => [annotation.id, annotation.geometry.pointMm]));
    return annotations.flatMap((annotation, index) => {
      if (annotation.projection && annotation.projection !== projection) return [];
      const id = annotation.id ?? `${projection}-${index}`;
      const pointMm: Point = annotationDrag?.id === id
        ? annotationDrag.pointMm
        : annotation.coordinateSpace === "drawing-mm"
          ? [annotation.x, annotation.y]
          : modelPoints.get(id) ?? [annotation.x * 1_000, annotation.y * 1_000];
      return [{ id, annotation, pointMm }];
    });
  }, [annotationDrag, annotations, model, projection]);

  const shownEntities = useMemo(() => {
    if (!model) return [];
    return model.entities.filter((entity) => {
      if (entity.source === "manual" && !entity.metadata?.dimensionId) return false;
      if (visibility[entity.layer] === false) return false;
      if (!layoutMode && (entity.layer === "FRAME" || entity.layer === "TITLE_BLOCK")) return false;
      return true;
    });
  }, [layoutMode, model, visibility]);

  useEffect(() => {
    link?.onVisibleEntitiesChange(shownEntities.map(entity => entity.id));
  }, [shownEntities, link?.onVisibleEntitiesChange]);

  useEffect(() => {
    const request = link?.focusRequest;
    if (!request || !link?.enabled) return;
    cancelAnimationFrame(focusFrameRef.current);
    const nextZoom = request.fit
      ? Math.max(0.2, Math.min(24, Math.min(size.width, size.height) * 0.35 / (Math.max(50, request.radiusMm ?? 100) * fitScale)))
      : zoom;
    const destination: Point = [-(request.point[0] - center[0]) * fitScale * nextZoom, (request.point[1] - center[1]) * fitScale * nextZoom];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPan(destination); setZoom(nextZoom); return;
    }
    const start = performance.now(), from = pan, fromZoom = zoom;
    const animate = (now: number) => {
      const t = Math.min(1, (now - start) / 320), eased = 1 - (1 - t) ** 3;
      setPan([from[0] + (destination[0] - from[0]) * eased, from[1] + (destination[1] - from[1]) * eased]);
      setZoom(fromZoom + (nextZoom - fromZoom) * eased);
      if (t < 1) focusFrameRef.current = requestAnimationFrame(animate);
    };
    focusFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(focusFrameRef.current);
  }, [link?.focusRequest, link?.enabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(size.width * ratio); canvas.height = Math.floor(size.height * ratio);
    canvas.style.width = `${size.width}px`; canvas.style.height = `${size.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = lightMode ? "#ffffff" : "#101214"; context.fillRect(0, 0, size.width, size.height);

    if (showGrid) {
      const targetStep = 56 / scale;
      const magnitude = 10 ** Math.floor(Math.log10(Math.max(targetStep, 1e-6)));
      const normalized = targetStep / magnitude;
      const step = (normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
      const viewMinX = center[0] - (size.width / 2 + pan[0]) / scale;
      const viewMaxX = center[0] + (size.width / 2 - pan[0]) / scale;
      const viewMinY = center[1] - (size.height / 2 - pan[1]) / scale;
      const viewMaxY = center[1] + (size.height / 2 + pan[1]) / scale;
      context.beginPath();
      for (let x = Math.floor(viewMinX / step) * step; x <= viewMaxX; x += step) { const sx = toScreen([x, 0])[0]; context.moveTo(sx, 0); context.lineTo(sx, size.height); }
      for (let y = Math.floor(viewMinY / step) * step; y <= viewMaxY; y += step) { const sy = toScreen([0, y])[1]; context.moveTo(0, sy); context.lineTo(size.width, sy); }
      context.strokeStyle = lightMode ? "#e8ecef" : "rgba(150, 165, 175, .08)"; context.lineWidth = 1; context.stroke();
    }

    const layers = new Map(model.layers.map((layer) => [layer.name, layer]));
    const highlighted = new Set(link?.enabled ? link.highlightedIds : []);
    // 联动图元最后绘制，避免被原始点和尺寸线遮住。
    const orderedEntities = [...shownEntities.filter(entity => !highlighted.has(entity.id)), ...shownEntities.filter(entity => highlighted.has(entity.id))];
    for (const entity of orderedEntities) {
      const layer = layers.get(entity.layer);
      if (!layer) continue;
      const active = highlighted.has(entity.id) || (!link && entity.id === selectedId);
      const color = active ? (lightMode ? "#995617" : "#F4D4A2") : lightMode ? LIGHT_LAYER_COLORS[entity.layer] : layer.color;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = active ? 3.5 : Math.max(1, Math.min(4, layer.lineWidthMm * 4));
      context.setLineDash(layer.lineType === "DASHED" ? [10, 7] : layer.lineType === "CENTER" ? [18, 6, 3, 6] : []);
      if (entity.type === "line") {
        const start = toScreen(entity.start); const end = toScreen(entity.end);
        context.beginPath(); context.moveTo(start[0], start[1]); context.lineTo(end[0], end[1]); context.stroke();
      } else if (entity.type === "polyline") {
        if (!entity.points.length) continue;
        context.beginPath();
        entity.points.forEach((point, index) => { const screen = toScreen(point); if (index === 0) context.moveTo(screen[0], screen[1]); else context.lineTo(screen[0], screen[1]); });
        if (entity.closed) context.closePath(); context.stroke();
      } else if (entity.type === "point") {
        const point = toScreen(entity.position); context.beginPath(); context.arc(point[0], point[1], active ? 4 : 1.4, 0, Math.PI * 2); context.fill();
      } else {
        const point = toScreen(entity.position);
        context.save(); context.translate(point[0], point[1]); context.rotate(-(entity.rotationDegrees ?? 0) * Math.PI / 180);
        context.font = `${Math.max(1, entity.heightMm * scale)}px IBM Plex Sans, Microsoft YaHei, sans-serif`;
        context.textAlign = entity.metadata?.dimensionId ? "center" : "left";
        context.textBaseline = entity.metadata?.dimensionId ? "alphabetic" : "middle"; context.fillText(entity.text, 0, 0); context.restore();
      }
    }
    context.setLineDash([]);
    if (link?.enabled && link.drawingPoint) {
      const [x, y] = toScreen(link.drawingPoint);
      context.strokeStyle = lightMode ? "#995617" : "#F4D4A2"; context.lineWidth = 1.5;
      context.beginPath(); context.arc(x, y, 8, 0, Math.PI * 2);
      context.moveTo(x - 14, y); context.lineTo(x - 5, y); context.moveTo(x + 5, y); context.lineTo(x + 14, y);
      context.moveTo(x, y - 14); context.lineTo(x, y - 5); context.moveTo(x, y + 5); context.lineTo(x, y + 14); context.stroke();
    }
    for (const annotation of displayAnnotations) {
      if (visibility[annotationLayer(annotation.annotation.category)] === false) continue;
      const point = toScreen(annotation.pointMm);
      const rect = annotationScreenRect(annotation, point);
      const selected = annotation.id === selectedAnnotationId;
      context.fillStyle = lightMode ? (selected ? "#eee7de" : "#f5f6f6") : selected ? "rgba(51, 38, 29, 0.96)" : "rgba(34, 33, 30, 0.92)";
      context.strokeStyle = lightMode ? (selected ? "#755638" : "#929da5") : selected ? "#e38c51" : "#5a544b";
      context.lineWidth = selected ? 2 : 1;
      context.beginPath();
      context.roundRect(rect.left, rect.top, rect.width, rect.height, 5);
      context.fill(); context.stroke();
      context.fillStyle = lightMode ? "#995617" : "#d77a3d";
      context.beginPath(); context.arc(point[0], point[1], selected ? 5 : 4, 0, Math.PI * 2); context.fill();
      context.fillStyle = lightMode ? "#20282d" : "#f3f0e9";
      context.font = "600 14px IBM Plex Sans, Microsoft YaHei, sans-serif";
      context.textBaseline = "middle";
      context.fillText(annotation.annotation.text, rect.left + 10, rect.top + rect.height / 2, rect.width - 18);
    }
    context.setLineDash([]);
    // 尺寸几何修订：关联端点画可拖动手柄；拖动中实时预览新位置。
    for (const candidate of revisionHandles ? revision!.candidates : []) {
      const activeHandle = revision!.active && candidate.entityId === revision!.active.entityId && candidate.vertexIndex === revision!.active.vertexIndex;
      const point = revisionDrag && revisionDrag.entityId === candidate.entityId && revisionDrag.vertexIndex === candidate.vertexIndex ? revisionDrag.pointMm : candidate.current;
      if (point) {
        const [sx, sy] = toScreen(point);
        context.fillStyle = lightMode ? "#b3541e" : "#F4D4A2";
        context.strokeStyle = lightMode ? "#ffffff" : "#101214";
        context.lineWidth = 2;
        context.beginPath(); context.arc(sx, sy, activeHandle || revisionHandles ? 6 : 4, 0, Math.PI * 2); context.fill(); context.stroke();
        if (activeHandle) {
          context.beginPath(); context.moveTo(sx - 13, sy); context.lineTo(sx + 13, sy); context.moveTo(sx, sy - 13); context.lineTo(sx, sy + 13); context.strokeStyle = lightMode ? "#b3541e" : "#F4D4A2"; context.lineWidth = 1; context.stroke();
        }
      }
    }
  }, [bounds, center, displayAnnotations, model, pan, scale, selectedAnnotationId, selectedId, showGrid, shownEntities, size, visibility, link?.enabled, link?.highlightedIds, link?.drawingPoint, lightMode, revision?.active, revision?.candidates, revision?.disabled, revisionHandles, revisionDrag]);

  const findAnnotation = (point: Point): DisplayAnnotation | undefined => {
    for (const annotation of [...displayAnnotations].reverse()) {
      if (visibility[annotationLayer(annotation.annotation.category)] === false) continue;
      const screen = toScreen(annotation.pointMm);
      const rect = annotationScreenRect(annotation, screen);
      const hitLabel = point[0] >= rect.left - 5 && point[0] <= rect.left + rect.width + 5
        && point[1] >= rect.top - 5 && point[1] <= rect.top + rect.height + 5;
      const hitAnchor = Math.hypot(point[0] - screen[0], point[1] - screen[1]) <= 11;
      if (hitLabel || hitAnchor) return annotation;
    }
    return undefined;
  };

  const findEntity = (point: Point): CadEntity | undefined => {
    let best: { entity: CadEntity; distance: number } | undefined;
    for (const entity of shownEntities) {
      let distance = Infinity;
      if (entity.type === "line") distance = distanceToSegment(point, toScreen(entity.start), toScreen(entity.end));
      if (entity.type === "polyline") {
        for (let index = 0; index < entity.points.length - (entity.closed ? 0 : 1); index += 1) {
          distance = Math.min(distance, distanceToSegment(point, toScreen(entity.points[index]!), toScreen(entity.points[(index + 1) % entity.points.length]!)));
        }
      }
      if (entity.type === "point" || entity.type === "text") distance = Math.hypot(point[0] - toScreen(entity.position)[0], point[1] - toScreen(entity.position)[1]);
      if (distance <= 10 && (!best || distance < best.distance)) best = { entity, distance };
    }
    return best?.entity;
  };

  /** 图纸上命中尺寸（尺寸线、界线、刻度或尺寸文字）即返回该尺寸编号。 */
  const findDimension = (point: Point): string | undefined => {
    let best: { dimensionId: string; distance: number } | undefined;
    for (const entity of shownEntities) {
      const dimensionId = entity.metadata?.dimensionId as string | undefined;
      if (!dimensionId || entity.type === "point") continue;
      let distance = Infinity;
      if (entity.type === "line") distance = distanceToSegment(point, toScreen(entity.start), toScreen(entity.end));
      if (entity.type === "text") distance = Math.hypot(point[0] - toScreen(entity.position)[0], point[1] - toScreen(entity.position)[1]);
      if (distance <= 10 && (!best || distance < best.distance)) best = { dimensionId, distance };
    }
    return best?.dimensionId;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    cancelAnimationFrame(focusFrameRef.current);
    hoverRef.current = undefined; link?.onHoverEntity(undefined);
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const point: Point = [event.clientX - rect.left, event.clientY - rect.top];
    // 修订手柄优先：命中关联端点即进入拖动，不触发平移或选图元。
    if (revisionHandles && model) {
      const hit = revision!.candidates.find(row => Math.hypot(toScreen(row.current)[0] - point[0], toScreen(row.current)[1] - point[1]) <= 12);
      if (hit) {
        // 直接拖动选中尺寸的关联端点：不必先进入端点模式。
        revision!.onActiveChange?.({ entityId: hit.entityId, vertexIndex: hit.vertexIndex });
        dragRef.current = { mode: "revision", x: event.clientX, y: event.clientY, entityId: hit.entityId, vertexIndex: hit.vertexIndex, pointMm: fromScreen(point), moved: false };
        return;
      }
    }
    if ((dimensionMode || lineMove) && !stale) { dragRef.current={mode:"dimension",x:event.clientX,y:event.clientY,moved:false};return; }
    if (placingAnnotation) {
      // 点在图元（墙线或尺寸）上时按选择处理；空白处才放置标注，避免标注层挡住尺寸选择。
      // 命中尺寸时按尺寸选择：尺寸线与墙线常在同一点重叠。
      const onDimension = findDimension(point);
      const onEndpoint = revision?.candidates.some(row => Math.hypot(toScreen(row.current)[0] - point[0], toScreen(row.current)[1] - point[1]) <= 10);
      if (!findEntity(point) && !onDimension && !onEndpoint) {
        dragRef.current = { mode: "place", x: event.clientX, y: event.clientY, moved: false };
        return;
      }
    }
    const annotation = findAnnotation(point);
    if (annotation) {
      setSelectedId(undefined);
      link?.onSelectEntity(undefined);
      onSelectedAnnotationChange(annotation.id);
      dragRef.current = { mode: "annotation", id: annotation.id, x: event.clientX, y: event.clientY, moved: false, pointMm: annotation.pointMm };
      return;
    }
    dragRef.current = { mode: "pan", x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if(dimensionMode&&model){const r=event.currentTarget.getBoundingClientRect(),p=fromScreen([event.clientX-r.left,event.clientY-r.top]);setSnapPoint(dimensionPoints.length<2?snapCadEndpoint(model,p,10/scale,layer=>visibility[layer as CadLayerName]!==false)?.point:undefined);}
    if (!drag) {
      if (link?.enabled && !placingAnnotation && performance.now() - hoverTimeRef.current >= 80) {
        hoverTimeRef.current = performance.now();
        const rect = event.currentTarget.getBoundingClientRect();
        const point: Point = [event.clientX - rect.left, event.clientY - rect.top];
        const id = findAnnotation(point) ? undefined : findEntity(point)?.id;
        if (id !== hoverRef.current) { hoverRef.current = id; link.onHoverEntity(id); }
      }
      return;
    }
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    drag.x = event.clientX; drag.y = event.clientY;
    if (drag.mode === "pan") setPan(([x, y]) => [x + dx, y + dy]);
    if (drag.mode === "annotation") {
      drag.pointMm = [drag.pointMm[0] + dx / scale, drag.pointMm[1] - dy / scale];
      setAnnotationDrag({ id: drag.id, pointMm: drag.pointMm });
    }
    if (drag.mode === "revision") {
      drag.pointMm = [drag.pointMm[0] + dx / scale, drag.pointMm[1] - dy / scale];
      setRevisionDrag({ entityId: drag.entityId, vertexIndex: drag.vertexIndex, pointMm: drag.pointMm });
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current; dragRef.current = undefined;
    if (!drag) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point: Point = [event.clientX - rect.left, event.clientY - rect.top];
    if(drag.mode==="dimension"&&!drag.moved&&model&&lineMove&&!dimensionMode){
      onMoveDimensionLine?.(lineMove,fromScreen(point));setLineMove(undefined);return;
    }
    if(drag.mode==="dimension"&&!drag.moved&&model){
      const raw=fromScreen(point),p=dimensionPoints.length<2?(snapCadEndpoint(model,raw,10/scale,layer=>visibility[layer as CadLayerName]!==false)?.point??raw):raw;
      const next=[...dimensionPoints,p];
      if(next.length===3){onCreateDimension?.(next[0]!,next[1]!,next[2]!);setDimensionPoints([]);setSnapPoint(undefined);}else setDimensionPoints(next);
    }
    if (drag.mode === "revision") {
      if (drag.moved) revision?.onCommit(drag.entityId, drag.vertexIndex, drag.pointMm);
      setRevisionDrag(undefined);
    }
    if (drag.mode === "place" && !drag.moved) onPlaceAnnotation(fromScreen(point));
    if (drag.mode === "annotation") {
      if (drag.moved) onMoveAnnotation(drag.id, drag.pointMm);
      setAnnotationDrag(undefined);
    }
    if (drag.mode === "pan" && !drag.moved) {
      // 尺寸命中时优先选中该尺寸：尺寸数与墙线在同一点重叠，按图元最近会永远选中墙线。
      const entityHit = findEntity(point);
      const dimensionHit = findDimension(point) ?? (entityHit?.metadata?.dimensionId as string | undefined);
      setSelectedId(dimensionHit ? undefined : entityHit?.id);
      // 选中的尺寸需在图纸上看得见：属性栏与修订入口都按这个尺寸显示。
      onSelectedDimensionChange?.(dimensionHit);
      if (link?.enabled) link.onSelectEntity(entityHit?.id);
      onSelectedAnnotationChange(undefined);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    cancelAnimationFrame(focusFrameRef.current);
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const cursor: Point = [event.clientX - rect.left - size.width / 2, event.clientY - rect.top - size.height / 2];
    const next = Math.max(0.2, Math.min(24, zoom * Math.exp(-event.deltaY * 0.0015)));
    const ratio = next / zoom;
    setPan(([x, y]) => [cursor[0] - (cursor[0] - x) * ratio, cursor[1] - (cursor[1] - y) * ratio]);
    setZoom(next);
  };
  const resetView = () => { cancelAnimationFrame(focusFrameRef.current); setZoom(1); setPan([0, 0]); };
  const selected = model?.entities.find((entity) => entity.id === (link ? link.pinnedId : selectedId));
  const selectedDimension = model?.dimensions?.find(d=>d.id===(selected?.metadata?.dimensionId??selectedDimensionId));
  const selectedAnnotation = displayAnnotations.find((annotation) => annotation.id === selectedAnnotationId);
  const layerRows = model?.layers.map((layer) => ({
    layer,
    count: model.entities.filter((entity) => entity.layer === layer.name).length,
    warnings: model.warnings.filter((warning) => warning.relatedLayer === layer.name && warning.severity !== "info").length,
  })) ?? [];
  const visibleLayerCount = layerRows.filter(({ layer }) => visibility[layer.name] !== false).length;

  const revisionRank: "none" | "some" = revision && selectedDimensionId && revision.candidates.length ? "some" : "none";
  const showRevisionLink = !!revision && !!selectedDimensionId && !!model?.dimensions?.some(dimension => dimension.id === selectedDimensionId);
  if (!model) return <div className="cad-preview-empty"><ScanLine /><strong>把你的空间变成图纸</strong><span>点击下方“生成图纸”，先看看空间的{projection === "xy" ? "俯视" : projection === "xz" ? "前视" : "侧视"}轮廓。</span></div>;

  return <div className="cad-preview-shell" data-dimension-step={dimensionPoints.length}>
    {revision?.active&&<div className="cad-dimension-hint" role="status" data-testid="dimension-revision-hint">拖动高亮端点修改几何，尺寸随几何重算 · Esc 退出</div>}
    {lineMove&&<div className="cad-dimension-hint" role="status">点击图纸放置尺寸线位置，尺寸数值随几何保持不变 · Esc 退出</div>}
    {dimensionMode&&<div className="cad-dimension-hint">{dimensionPoints.length===0?'选择尺寸起点':dimensionPoints.length===1?'选择尺寸终点':'选择尺寸线位置'} · Esc 退出</div>}
    {[...dimensionPoints,...(snapPoint?[snapPoint]:[])].map((p,i)=>{const xy=toScreen(p);return <i key={i} className="cad-snap-point" style={{left:xy[0],top:xy[1]}}/>;})}
    {selectedDimension&&<div className="cad-dimension-properties" data-testid="cartesian-dimension-properties"><span>图纸几何尺寸 {dimensionMeasurement(selectedDimension).toFixed(3)} mm</span>{onMoveDimensionLine&&<button aria-label="改尺寸线位置" title="再点一次图纸放置尺寸线位置，用于避开已有标注" onClick={()=>setLineMove(selectedDimension.id)}>改尺寸线位置</button>}{onDeleteDimension&&<button onClick={()=>onDeleteDimension(selectedDimension.id)}>删除尺寸</button>}</div>}
    {revision&&!revision.disabled&&showRevisionLink&&<div className="cad-revision-hint" role="status" data-testid="dimension-revision-link">{revisionRank==="none"?"选中尺寸没有可修订的关联墙线，无法直接改几何":`选中尺寸关联 ${revision.candidates.length} 个端点 · ${[...new Set(revision.candidates.map(row=>row.label))].join("、")}`}</div>}
    <div className={`cad-preview-stage ${placingAnnotation ? "placing-annotation" : ""}`} ref={stageRef}>
      <div className="cad-preview-toolbar" role="toolbar" aria-label="CAD 预览工具">
        <div className="cad-view-switch"><button className={!layoutMode ? "active" : ""} aria-pressed={!layoutMode} title="空间轮廓" onClick={() => { setLayoutMode(false); resetView(); }}>轮廓</button><button className={layoutMode ? "active" : ""} aria-pressed={layoutMode} title="完整图纸" onClick={() => { setLayoutMode(true); resetView(); }}>图纸</button></div>
        <button aria-label="缩小 CAD 预览" title="缩小" onClick={() => { cancelAnimationFrame(focusFrameRef.current); setZoom((value) => Math.max(.2, value / 1.25)); }}><Minus /></button>
        <button aria-label="放大 CAD 预览" title="放大" onClick={() => { cancelAnimationFrame(focusFrameRef.current); setZoom((value) => Math.min(24, value * 1.25)); }}><Plus /></button>
        <button aria-label="适配 CAD 图纸" title="适配图纸" onClick={resetView}><Maximize2 /></button>
        <button className={showGrid ? "active" : ""} aria-pressed={showGrid} aria-label="显示 CAD 网格" title="网格" onClick={() => setShowGrid((value) => !value)}><Grid2X2 /></button>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
      <button className="cad-layer-trigger" aria-label="CAD 图层" aria-expanded={layersOpen} aria-controls="cad-layer-panel" onClick={() => setLayersOpen((value) => !value)}><Layers3 /><span>图层</span><small>{visibleLayerCount}/{layerRows.length}</small></button>
      <canvas
        ref={canvasRef}
        data-highlighted-entities={link?.enabled ? link.highlightedIds.join(",") : ""}
        data-drawing-center={JSON.stringify([center[0] - pan[0] / scale, center[1] + pan[1] / scale])}
        data-drawing-scale={scale}
        data-layout-mode={layoutMode ? "full" : "model"}
        tabIndex={0}
        aria-label={dimensionMode ? "CAD 尺寸标注画布" : placingAnnotation ? `在图纸中放置标注 ${placingAnnotation.text}` : "CAD 图纸预览画布"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = undefined; setAnnotationDrag(undefined); setRevisionDrag(undefined); }}
        onPointerLeave={() => { hoverRef.current = undefined; link?.onHoverEntity(undefined); }}
        onKeyDown={(event) => {
          if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotationId) {
            event.preventDefault();
            onDeleteAnnotation(selectedAnnotationId);
          }
          if (event.key === "Escape" && revision?.active) { event.preventDefault(); setRevisionDrag(undefined); revision.onActiveChange?.(undefined); }
        }}
        onWheel={onWheel}
      />
      {placingAnnotation && <div className="cad-placement-hint" role="status"><Crosshair />点击图纸放置“{placingAnnotation.text}”<small>Esc 取消</small></div>}
      {stale && <div className="cad-preview-stale" role="status">空间或设置已变化，请更新图纸</div>}
      <div className="cad-preview-axis"><span>图纸纵向 ↑</span><span>图纸横向 →</span></div>
      {selected && !selectedDimension && <div className="cad-entity-inspector"><strong>已选图元</strong><span>{formatEntity(selected)}</span></div>}
      {selectedAnnotation && <div className="cad-annotation-inspector">
        <span><strong>{selectedAnnotation.annotation.text}</strong><small>拖动可移动</small></span>
        <button aria-label={`删除标注 ${selectedAnnotation.annotation.text}`} title="删除标注" onClick={() => onDeleteAnnotation(selectedAnnotation.id)}><Trash2 /></button>
      </div>}
      {layersOpen && <aside id="cad-layer-panel" className="cad-layer-panel" aria-label="CAD 图层">
        <header><div><strong>图层可见性</strong><small>{model.entities.length} 个实体</small></div><div className="cad-layer-actions"><button title="恢复全部图层" aria-label="恢复全部 CAD 图层" onClick={() => setVisibility(Object.fromEntries(model.layers.map((layer) => [layer.name, true])))}><Eye /></button><button title="关闭图层" aria-label="关闭 CAD 图层" onClick={() => setLayersOpen(false)}><X /></button></div></header>
        <div className="cad-layer-quick"><button onClick={() => setVisibility((current) => ({ ...current, INFERRED_WALL: false }))}><EyeOff />隐藏推断</button><button onClick={() => setVisibility(Object.fromEntries(model.layers.map((layer) => [layer.name, layer.name === "OBSERVED_WALL"])))}><Eye />仅看实测</button></div>
        <div className="cad-layer-list">
          {layerRows.map(({ layer, count, warnings }) => <label key={layer.name} className={visibility[layer.name] === false ? "muted" : ""}>
            <input type="checkbox" checked={visibility[layer.name] !== false} onChange={(event) => setVisibility((current) => ({ ...current, [layer.name]: event.target.checked }))} />
            <i style={{ color: layer.color, borderTopStyle: layer.lineType === "DASHED" ? "dashed" : "solid" }} />
            <span><strong>{CAD_LAYER_LABELS[layer.name]}</strong><small>{count} 个{warnings ? ` · ${warnings} 项提醒` : ""}</small></span>
          </label>)}
        </div>
      </aside>}
    </div>
  </div>;
}
