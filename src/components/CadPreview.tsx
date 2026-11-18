import { snapCadEndpoint, dimensionMeasurement, type CadDimension, type CadPoint2 } from "../cad/dimensions";
import { openCadEndpoints, snapCadOpenEndpoint, manualCadConnections, previewCadConnection, resolveCadConnectionStyle, type CadConnectionEntity, type CadConnectionStyle, type CadEndpoint, type ResolvedCadConnectionStyle } from "../cad/connections";
import { Spline, Circle, Crosshair, Eye, EyeOff, Grid2X2, Hand, Layers3, Link2, Maximize2, Minus, MousePointer2, PenLine, Plus, Redo2, ScanLine, Square, Trash2, Undo2, Waypoints, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { type CadAnnotation, type CadBoundsMm, type CadEntity, type CadLayerName, type CadLineType, type DrawingModel } from "../cad/model";
import { canEditCadEntity, createCadShape, deleteCadGeometry, moveCadGeometry, withCadEdits, type CadDrawTool } from "../cad/editing";
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

interface CadPreviewProps {
  dimensionMode?: CadDimension['kind'];
  onCreateDimension?(start:CadPoint2,end:CadPoint2,linePoint:CadPoint2):void;
  onDeleteDimension?(id:string):void;
  connectionMode?: boolean;
  onCreateConnection?(start:CadEndpoint,end:CadEndpoint,style:CadConnectionStyle):void;
  onEdit?(model:DrawingModel,message:string):void;
  canUndo?:boolean;
  canRedo?:boolean;
  onUndo?():void;
  onRedo?():void;
  onToolChange?(tool:string):void;
  busy?:boolean;
  onLayoutModeChange?(open:boolean):void;
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
  POINT_CLOUD: "#687b82", TOPO_HIDDEN: "#7a858a", FURNITURE: "#596a62", USER_DRAWING: "#3f806b",
};
type DisplayAnnotation = { id: string; annotation: CadAnnotation; pointMm: Point };
type CanvasDrag =
  | { mode: "pan"; x: number; y: number; moved: boolean }
  | { mode: "annotation"; id: string; x: number; y: number; moved: boolean; pointMm: Point }
  | { mode: "entity"; id: string; x: number; y: number; startWorld: Point; moved: boolean }
  | { mode: "place" | "dimension" | "connection" | "draw"; x: number; y: number; moved: boolean };
type EditorTool = "select" | "pan" | "connect" | CadDrawTool;

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
  FURNITURE: "家具",
  USER_DRAWING: "人工绘图",
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
  if(entity.type==='circle')return `圆 · 半径 ${Math.round(entity.radiusMm)} mm`;
  if(entity.type==='arc')return `圆弧 · 半径 ${Math.round(entity.radiusMm)} mm`;
  return `(${Math.round(entity.position[0])}, ${Math.round(entity.position[1])}) mm`;
}

const CONNECTION_STYLE_CYCLE: ResolvedCadConnectionStyle[] = ["outer90", "inner90", "direct", "arc"];
const CONNECTION_STYLE_LABELS: Record<ResolvedCadConnectionStyle, string> = {
  outer90: "外折 90°",
  inner90: "内折 90°",
  direct: "直连",
  arc: "弧线",
};

function annotationLayer(category: CadAnnotation["category"]): CadLayerName {
  return category === "door" ? "DOOR" : category === "window" ? "WINDOW" : "TEXT";
}

function annotationScreenRect(annotation: DisplayAnnotation, point: Point) {
  const width = Math.max(52, annotation.annotation.text.length * 14 + 24);
  return { left: point[0] + 9, top: point[1] - 17, width, height: 34 };
}

export function CadPreview({
  dimensionMode, onCreateDimension, onDeleteDimension, connectionMode, onCreateConnection,
  onEdit,canUndo,canRedo,onUndo,onRedo,onToolChange,busy,onLayoutModeChange,
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
  const [tool,setTool]=useState<EditorTool>("select"),[drawPoints,setDrawPoints]=useState<Point[]>([]),[drawCursor,setDrawCursor]=useState<Point>();
  const [lineType,setLineType]=useState<CadLineType>("CONTINUOUS"),[entityDrag,setEntityDrag]=useState<CadEntity>();
  const [dimensionPoints,setDimensionPoints]=useState<CadPoint2[]>([]);
  const [connectionPoints,setConnectionPoints]=useState<CadEndpoint[]>([]);
  const [connectionStyle,setConnectionStyle]=useState<CadConnectionStyle>("auto");
  const [snapPoint,setSnapPoint]=useState<CadPoint2>();
  const [snapEndpoint,setSnapEndpoint]=useState<CadEndpoint>();
  useEffect(()=>{setDimensionPoints([]);setConnectionPoints([]);setConnectionStyle("auto");setSnapPoint(undefined);setSnapEndpoint(undefined);setDrawPoints([]);setEntityDrag(undefined);},[dimensionMode,connectionMode,model,stale]);
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
  const [visibility, setVisibility] = useState<Partial<Record<CadLayerName, boolean>>>({});
  const editable=!stale&&!layoutMode&&!busy&&!!onEdit;
  function selectTool(next:EditorTool){
    if(next!=='select'&&!editable)return;
    setTool(next);setDrawPoints([]);setDrawCursor(undefined);setEntityDrag(undefined);setSelectedId(undefined);setConnectionPoints([]);setSnapPoint(undefined);setSnapEndpoint(undefined);setConnectionStyle("auto");onToolChange?.(next);
    if(next==='connect')canvasRef.current?.focus();
  }
  useEffect(()=>{
    if(connectionMode){setTool('connect');canvasRef.current?.focus();}
    else setTool(current=>current==='connect'?'select':current);
    if(dimensionMode)setVisibility(current=>({...current,DIM:true}));
  },[connectionMode,dimensionMode]);
  useEffect(()=>onLayoutModeChange?.(layoutMode),[layoutMode]);

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
    setZoom(1); setPan([0, 0]); setSelectedId(undefined); setLayoutMode(false); setLayersOpen(false);setTool('select');setDrawPoints([]);setEntityDrag(undefined);
    if (model) setVisibility(Object.fromEntries(model.layers.map((layer) => [layer.name, layer.export])));
  }, [model?.drawingId]);

  useEffect(() => {
    if (placingAnnotation) {setVisibility(current=>({...current,[annotationLayer(placingAnnotation.category)]:true}));canvasRef.current?.focus();}
  }, [placingAnnotation]);
  const connectionCount=model?manualCadConnections(model).length:0,previousConnectionCount=useRef(0);
  useEffect(()=>{if(connectionCount>previousConnectionCount.current)setVisibility(current=>({...current,INFERRED_WALL:true}));previousConnectionCount.current=connectionCount;},[connectionCount]);

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
    const annotationLabelIds=new Set(model.annotations.map(annotation=>`${annotation.id}-label`));
    return model.entities.filter((entity) => {
      if (annotationLabelIds.has(entity.id)||entity.metadata?.operation==='annotation-label') return false;
      if (visibility[entity.layer] === false) return false;
      if (!layoutMode && (entity.layer === "FRAME" || entity.layer === "TITLE_BLOCK")) return false;
      return true;
    }).map(entity=>entity.id===entityDrag?.id?entityDrag:entity);
  }, [layoutMode, model, visibility,entityDrag]);
  const openEndpoints = useMemo(() => tool==='connect' && model ? openCadEndpoints(model, layer => visibility[layer as CadLayerName] !== false) : [], [tool, model, visibility]);
  const connectionTarget = useMemo<CadEndpoint | undefined>(() => {
    if (tool !== "connect" || connectionPoints.length !== 1) return undefined;
    if (snapEndpoint && snapEndpoint.entityId !== connectionPoints[0]!.entityId) return snapEndpoint;
    return drawCursor ? { point: drawCursor, entityId: "__preview__" } : undefined;
  }, [tool, connectionPoints, snapEndpoint, drawCursor]);
  const resolvedConnectionStyle = useMemo<ResolvedCadConnectionStyle | undefined>(() => {
    if (tool !== "connect" || !model) return undefined;
    if (connectionStyle !== "auto") return connectionStyle;
    if (connectionPoints.length === 1 && connectionTarget) return resolveCadConnectionStyle(model, connectionPoints[0]!, connectionTarget, "auto");
    return undefined;
  }, [tool, model, connectionStyle, connectionPoints, connectionTarget]);
  const connectionPreview = useMemo<CadConnectionEntity | undefined>(() => {
    if (!model || tool !== "connect" || connectionPoints.length !== 1 || !connectionTarget) return undefined;
    return previewCadConnection(model, connectionPoints[0]!, connectionTarget, connectionStyle);
  }, [model, tool, connectionPoints, connectionTarget, connectionStyle]);
  useEffect(() => {
    if (tool !== "connect") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable)) return;
      if (event.code !== "Space" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      setConnectionStyle(current => {
        if (current === "auto") {
          const index = resolvedConnectionStyle ? CONNECTION_STYLE_CYCLE.indexOf(resolvedConnectionStyle) : -1;
          return CONNECTION_STYLE_CYCLE[(index + 1) % CONNECTION_STYLE_CYCLE.length]!;
        }
        const index = CONNECTION_STYLE_CYCLE.indexOf(current);
        return CONNECTION_STYLE_CYCLE[(index + 1) % CONNECTION_STYLE_CYCLE.length]!;
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [tool, resolvedConnectionStyle]);
  const draftEntity=useMemo(()=>{
    if(!drawCursor||!['line','polyline','rectangle','circle','arc'].includes(tool))return undefined;
    const required=tool==='arc'?3:tool==='polyline'?3:2;if(drawPoints.length+1<required)return undefined;
    try{return createCadShape(tool as CadDrawTool,[...drawPoints,drawCursor],lineType);}catch{return undefined;}
  },[drawCursor,drawPoints,tool,lineType]);

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
    const targetWidth = Math.floor(size.width * ratio), targetHeight = Math.floor(size.height * ratio);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth; canvas.height = targetHeight;
      canvas.style.width = `${size.width}px`; canvas.style.height = `${size.height}px`;
    }
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
    const orderedEntities = [...shownEntities.filter(entity => !highlighted.has(entity.id)), ...shownEntities.filter(entity => highlighted.has(entity.id)),...(draftEntity?[draftEntity]:[])];
    for (const entity of orderedEntities) {
      const layer = layers.get(entity.layer);
      if (!layer) continue;
      const active = highlighted.has(entity.id) || (!link && entity.id === selectedId);
      const color = active ? (lightMode ? "#995617" : "#F4D4A2") : lightMode ? LIGHT_LAYER_COLORS[entity.layer] : layer.color;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = active ? 3.5 : Math.max(1, Math.min(4, layer.lineWidthMm * 4));
      const displayLineType=entity.lineType??layer.lineType;
      context.setLineDash(displayLineType === "DASHED" ? [10, 7] : displayLineType === "CENTER" ? [18, 6, 3, 6] : []);
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
      } else if(entity.type==='circle'){
        const center=toScreen(entity.center);context.beginPath();context.arc(center[0],center[1],entity.radiusMm*scale,0,Math.PI*2);context.stroke();
      } else if(entity.type==='arc'){
        const center=toScreen(entity.center);context.beginPath();context.arc(center[0],center[1],entity.radiusMm*scale,-entity.startAngle,-entity.endAngle,true);context.stroke();
      } else {
        const point = toScreen(entity.position);
        context.save(); context.translate(point[0], point[1]); context.rotate(-(entity.rotationDegrees ?? 0) * Math.PI / 180);
        context.font = `${Math.max(1, entity.heightMm * scale)}px IBM Plex Sans, Microsoft YaHei, sans-serif`;
        context.textAlign = entity.metadata?.dimensionId ? "center" : "left";
        context.textBaseline = entity.metadata?.dimensionId ? "alphabetic" : "middle"; context.fillText(entity.text, 0, 0); context.restore();
      }
    }
    context.setLineDash([]);
    if (connectionPreview) {
      context.strokeStyle = lightMode ? "#995617" : "#F4D4A2"; context.lineWidth = 1.75; context.setLineDash([6, 4]);
      if (connectionPreview.type === "line") {
        const start = toScreen(connectionPreview.start), end = toScreen(connectionPreview.end);
        context.beginPath(); context.moveTo(start[0], start[1]); context.lineTo(end[0], end[1]); context.stroke();
      } else if (connectionPreview.type === "polyline" && connectionPreview.points.length) {
        context.beginPath();
        connectionPreview.points.forEach((pt, idx) => { const sPt = toScreen(pt); if (idx === 0) context.moveTo(sPt[0], sPt[1]); else context.lineTo(sPt[0], sPt[1]); });
        context.stroke();
      } else if (connectionPreview.type === "arc") {
        const arcCenter = toScreen(connectionPreview.center);
        context.beginPath(); context.arc(arcCenter[0], arcCenter[1], connectionPreview.radiusMm * scale, -connectionPreview.startAngle, -connectionPreview.endAngle, true); context.stroke();
      }
      context.setLineDash([]);
    }
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
  }, [bounds, center, tool, connectionPoints, connectionPreview, displayAnnotations, model, pan, scale, selectedAnnotationId, selectedId, showGrid, shownEntities, size, snapPoint, visibility, link?.enabled, link?.highlightedIds, link?.drawingPoint, lightMode,draftEntity]);

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
      if(entity.type==='circle'||entity.type==='arc'){
        const world=fromScreen(point),radial=Math.abs(Math.hypot(world[0]-entity.center[0],world[1]-entity.center[1])-entity.radiusMm)*scale;
        if(entity.type==='circle')distance=radial;
        else {
          let angle=Math.atan2(world[1]-entity.center[1],world[0]-entity.center[0]);while(angle<entity.startAngle)angle+=Math.PI*2;
          if(angle<=entity.endAngle)distance=radial;
        }
      }
      if (entity.type === "point" || entity.type === "text") distance = Math.hypot(point[0] - toScreen(entity.position)[0], point[1] - toScreen(entity.position)[1]);
      if (distance <= 10 && (!best || distance < best.distance)) best = { entity, distance };
    }
    return best?.entity;
  };

  function commitShape(shape:CadEntity,message:string){
    if(!model)return;setVisibility(current=>({...current,[shape.layer]:true}));onEdit?.(withCadEdits(model,[...model.entities,shape]),message);selectTool('select');
  }
  function finishPolyline(){
    if(tool!=='polyline'||drawPoints.length<2||!model)return;
    const points=drawPoints.filter((point,index)=>index===0||Math.hypot(point[0]-drawPoints[index-1]![0],point[1]-drawPoints[index-1]![1])>1e-6);
    try{commitShape(createCadShape('polyline',points,lineType),'已绘制多段线。');}catch{setDrawPoints([]);}
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    cancelAnimationFrame(focusFrameRef.current);
    hoverRef.current = undefined; link?.onHoverEntity(undefined);
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect(),point: Point = [event.clientX - rect.left, event.clientY - rect.top];
    if (dimensionMode && editable) { dragRef.current={mode:"dimension",x:event.clientX,y:event.clientY,moved:false};return; }
    if (placingAnnotation&&editable) { dragRef.current = { mode: "place", x: event.clientX, y: event.clientY, moved: false };return; }
    if(tool==='connect'&&editable){dragRef.current={mode:"connection",x:event.clientX,y:event.clientY,moved:false};return;}
    if(!['select','pan'].includes(tool)&&editable){dragRef.current={mode:"draw",x:event.clientX,y:event.clientY,moved:false};return;}
    const annotation = findAnnotation(point);
    if (annotation&&editable) {
      setSelectedId(undefined);link?.onSelectEntity(undefined);onSelectedAnnotationChange(annotation.id);
      dragRef.current = { mode: "annotation", id: annotation.id, x: event.clientX, y: event.clientY, moved: false, pointMm: annotation.pointMm };return;
    }
    const entity=findEntity(point);
    if(tool==='select'&&entity&&editable&&canEditCadEntity(entity)){
      setSelectedId(entity.id);onSelectedAnnotationChange(undefined);
      dragRef.current={mode:'entity',id:entity.id,x:event.clientX,y:event.clientY,startWorld:fromScreen(point),moved:false};return;
    }
    dragRef.current = { mode: "pan", x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current,rect=event.currentTarget.getBoundingClientRect(),screen:Point=[event.clientX-rect.left,event.clientY-rect.top],world=fromScreen(screen);
    if(!['select','pan'].includes(tool))setDrawCursor(world);
    if(model&&(dimensionMode||tool==='connect')){
      if(tool==='connect'){
        const snapped=snapCadOpenEndpoint(model,world,10/scale,layer=>visibility[layer as CadLayerName]!==false);
        setSnapPoint(snapped?.point);setSnapEndpoint(snapped);
      }else{
        setSnapPoint(dimensionPoints.length<2?snapCadEndpoint(model,world,10/scale,layer=>visibility[layer as CadLayerName]!==false)?.point:undefined);
        setSnapEndpoint(undefined);
      }
    }
    if (!drag) {
      if (link?.enabled && !placingAnnotation && performance.now() - hoverTimeRef.current >= 80) {
        hoverTimeRef.current = performance.now();const id = findAnnotation(screen) ? undefined : findEntity(screen)?.id;
        if (id !== hoverRef.current) { hoverRef.current = id; link.onHoverEntity(id); }
      }
      return;
    }
    const dx = event.clientX - drag.x,dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    drag.x = event.clientX; drag.y = event.clientY;
    if (drag.mode === "pan") setPan(([x, y]) => [x + dx, y + dy]);
    if (drag.mode === "annotation") {drag.pointMm = [drag.pointMm[0] + dx / scale, drag.pointMm[1] - dy / scale];setAnnotationDrag({ id: drag.id, pointMm: drag.pointMm });}
    if(drag.mode==='entity'&&model){
      const next=moveCadGeometry(model,drag.id,world[0]-drag.startWorld[0],world[1]-drag.startWorld[1]);
      setEntityDrag(next.entities.find(entity=>entity.id===drag.id));
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current; dragRef.current = undefined;if (!drag) return;
    const rect = event.currentTarget.getBoundingClientRect(),point: Point = [event.clientX - rect.left, event.clientY - rect.top],world=fromScreen(point);
    if(drag.mode==="dimension"&&!drag.moved&&model){
      const p=dimensionPoints.length<2?(snapCadEndpoint(model,world,10/scale,layer=>visibility[layer as CadLayerName]!==false)?.point??world):world,next=[...dimensionPoints,p];
      if(next.length===3){onCreateDimension?.(next[0]!,next[1]!,next[2]!);setDimensionPoints([]);setSnapPoint(undefined);}else setDimensionPoints(next);
    }
    if(drag.mode==="connection"&&!drag.moved&&model){
      const endpoint=snapCadOpenEndpoint(model,world,10/scale,layer=>visibility[layer as CadLayerName]!==false);
      if(endpoint){const next=[...connectionPoints,endpoint];if(next.length===2){onCreateConnection?.(next[0]!,next[1]!,connectionStyle);setConnectionPoints([]);setSnapPoint(undefined);setSnapEndpoint(undefined);setConnectionStyle("auto");}else setConnectionPoints(next);}
    }
    if(drag.mode==='draw'&&!drag.moved&&model){
      const next=[...drawPoints,world];
      if(tool==='polyline'){setDrawPoints(next);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);return;}
      const required=tool==='arc'?3:2;
      if(next.length===required){
        try{commitShape(createCadShape(tool as CadDrawTool,next,lineType),`已绘制${tool==='line'?'直线':tool==='rectangle'?'矩形':tool==='circle'?'圆':'圆弧'}。`);}catch{setDrawPoints([]);}
      }else setDrawPoints(next);
    }
    if (drag.mode === "place" && !drag.moved) onPlaceAnnotation(world);
    if (drag.mode === "annotation") {if (drag.moved) onMoveAnnotation(drag.id, drag.pointMm);setAnnotationDrag(undefined);}
    if(drag.mode==='entity'&&model){
      if(drag.moved)onEdit?.(moveCadGeometry(model,drag.id,world[0]-drag.startWorld[0],world[1]-drag.startWorld[1]),'已移动图元。');
      setEntityDrag(undefined);setSelectedId(drag.id);
    }
    if (drag.mode === "pan" && !drag.moved&&tool==='select') {
      const id = findEntity(point)?.id;setSelectedId(id);if (link?.enabled) link.onSelectEntity(id);onSelectedAnnotationChange(undefined);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const wheelRef = useRef<(event: globalThis.WheelEvent) => void>(() => {});
  wheelRef.current = (event: globalThis.WheelEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelAnimationFrame(focusFrameRef.current);
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cursor: Point = [event.clientX - rect.left - size.width / 2, event.clientY - rect.top - size.height / 2];
    const next = Math.max(0.2, Math.min(24, zoom * Math.exp(-event.deltaY * 0.0015)));
    const ratio = next / zoom;
    setPan(([x, y]) => [cursor[0] - (cursor[0] - x) * ratio, cursor[1] - (cursor[1] - y) * ratio]);
    setZoom(next);
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: globalThis.WheelEvent) => wheelRef.current(event);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [model?.drawingId]);
  const resetView = () => { cancelAnimationFrame(focusFrameRef.current); setZoom(1); setPan([0, 0]); };
  const selected = model?.entities.find((entity) => entity.id === (link ? link.pinnedId : selectedId) && visibility[entity.layer] !== false);
  const selectedDimension = model?.dimensions?.find(d=>d.id===selected?.metadata?.dimensionId);
  const selectedAnnotation = displayAnnotations.find((annotation) => annotation.id === selectedAnnotationId && visibility[annotationLayer(annotation.annotation.category)] !== false);
  const layerRows = model?.layers.map((layer) => ({
    layer,
    count: model.entities.filter((entity) => entity.layer === layer.name).length,
    warnings: model.warnings.filter((warning) => warning.relatedLayer === layer.name && warning.severity !== "info").length,
  })) ?? [];
  const visibleLayerCount = layerRows.filter(({ layer }) => visibility[layer.name] !== false).length;

  if (!model) return <div className="cad-preview-empty"><ScanLine /><strong>把你的空间变成图纸</strong><span>点击下方“生成图纸”，先看看空间的{projection === "xy" ? "俯视" : projection === "xz" ? "前视" : "侧视"}轮廓。</span></div>;

  return <div className="cad-preview-shell" data-dimension-step={dimensionPoints.length} data-connection-step={connectionPoints.length} data-connection-style={resolvedConnectionStyle ?? connectionStyle} data-tool={tool}>
    {dimensionMode&&<div className="cad-dimension-hint">{dimensionPoints.length===0?'选择尺寸起点':dimensionPoints.length===1?'选择尺寸终点':'选择尺寸线位置'} · Esc 退出</div>}
    {tool==='connect'&&<div className="cad-dimension-hint">{connectionPoints.length===0?'选择第一个未连接端点':'选择第二个未连接端点'} · {connectionStyle==='auto'?(resolvedConnectionStyle?`自动(${CONNECTION_STYLE_LABELS[resolvedConnectionStyle]})`:'自动(外折90°/直连)'):CONNECTION_STYLE_LABELS[connectionStyle]} · Space 切换 · Esc 退出</div>}
    {!['select','pan','connect'].includes(tool)&&<div className="cad-dimension-hint">{tool==='polyline'?'逐点绘制，双击或 Enter 完成':tool==='arc'?'依次点击圆心、起点、终点':tool==='circle'?'点击圆心和半径点':'点击起点和终点'} · Esc 取消</div>}
    {tool==='connect'&&openEndpoints.map((endpoint,i)=>{const xy=toScreen(endpoint.point),selected=connectionPoints.some(p=>p.entityId===endpoint.entityId&&p.point[0]===endpoint.point[0]&&p.point[1]===endpoint.point[1]);return <i key={`${endpoint.entityId}-${i}`} className={`cad-snap-point cad-open-endpoint${selected?' is-selected':''}`} style={{left:xy[0],top:xy[1]}}/>;})}
    {tool==='connect'&&snapPoint&&<i className="cad-snap-point" style={{left:toScreen(snapPoint)[0],top:toScreen(snapPoint)[1]}}/>}
    {[...dimensionPoints,...(dimensionMode&&snapPoint?[snapPoint]:[])].map((p,i)=>{const xy=toScreen(p);return <i key={i} className="cad-snap-point" style={{left:xy[0],top:xy[1]}}/>;})}
    {selectedDimension&&<div className="cad-dimension-properties"><span>几何尺寸 {dimensionMeasurement(selectedDimension).toFixed(3)} mm</span>{onDeleteDimension&&editable&&<button onClick={()=>onDeleteDimension(selectedDimension.id)}>删除尺寸</button>}</div>}
    <div className={`cad-preview-stage tool-${tool} ${placingAnnotation ? "placing-annotation" : ""}`} ref={stageRef}>
      {editable&&<nav className="cad-edit-toolbar" aria-label="CAD 编辑工具">
        <button className={tool==='select'?'active':''} aria-label="选择图元" title="选择并移动" onClick={()=>selectTool('select')}><MousePointer2/></button>
        <button className={tool==='pan'?'active':''} aria-label="平移图纸" title="平移" onClick={()=>selectTool('pan')}><Hand/></button>
        <span/>
        <button className={tool==='line'?'active':''} aria-label="绘制直线" title="直线" onClick={()=>selectTool('line')}><PenLine/></button>
        <button className={tool==='polyline'?'active':''} aria-label="绘制多段线" title="多段线" onClick={()=>selectTool('polyline')}><Waypoints/></button>
        <button className={tool==='rectangle'?'active':''} aria-label="绘制矩形" title="矩形" onClick={()=>selectTool('rectangle')}><Square/></button>
        <button className={tool==='circle'?'active':''} aria-label="绘制圆" title="圆" onClick={()=>selectTool('circle')}><Circle/></button>
        <button className={tool==='arc'?'active':''} aria-label="绘制圆弧" title="圆弧" onClick={()=>selectTool('arc')}><Spline/></button>
        <button className={tool==='connect'?'active':''} aria-label="连接端点" title="连接两个开放端点" onClick={()=>selectTool('connect')}><Link2/></button>
        <span/>
        <button aria-label="切换绘制线型" title={lineType==='CONTINUOUS'?'当前实线，点击改为虚线':'当前虚线，点击改为实线'} onClick={()=>setLineType(value=>value==='CONTINUOUS'?'DASHED':'CONTINUOUS')}>{lineType==='CONTINUOUS'?'实':'虚'}</button>
        <button aria-label="删除选中图元" title="删除选中图元" disabled={!selected||!canEditCadEntity(selected)} onClick={()=>{if(selected&&model){onEdit?.(deleteCadGeometry(model,[selected.id]),'已删除图元。');setSelectedId(undefined);}}}><Trash2/></button>
        <span/>
        <button aria-label="撤销 CAD 编辑" title="撤销 Ctrl+Z" disabled={!canUndo||!editable} onClick={onUndo}><Undo2/></button>
        <button aria-label="重做 CAD 编辑" title="重做 Ctrl+Y" disabled={!canRedo||!editable} onClick={onRedo}><Redo2/></button>
      </nav>}
      <div className="cad-preview-toolbar" role="toolbar" aria-label="CAD 预览工具">
        <div className="cad-view-switch"><button className={!layoutMode ? "active" : ""} aria-pressed={!layoutMode} title="空间轮廓" onClick={() => { setLayoutMode(false);selectTool('select');resetView(); }}>轮廓</button><button className={layoutMode ? "active" : ""} aria-pressed={layoutMode} title="完整图纸，只读" onClick={() => { setLayoutMode(true);selectTool('select');resetView(); }}>图纸</button></div>
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
        tabIndex={0}
        aria-label={connectionMode ? "CAD 端点连线画布" : dimensionMode ? "CAD 尺寸标注画布" : placingAnnotation ? `在图纸中放置标注 ${placingAnnotation.text}` : "CAD 图纸预览画布"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={finishPolyline}
        onPointerCancel={() => { dragRef.current = undefined; setAnnotationDrag(undefined);setEntityDrag(undefined); }}
        onPointerLeave={() => { hoverRef.current = undefined; link?.onHoverEntity(undefined); }}
        onKeyDown={(event) => {
          if(event.key==='Escape'){event.preventDefault();selectTool('select');return;}
          if(event.key==='Enter'&&tool==='polyline'){event.preventDefault();finishPolyline();return;}
          if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotation&&editable) {event.preventDefault();onDeleteAnnotation(selectedAnnotation.id);return;}
          if((event.key==='Delete'||event.key==='Backspace')&&selected&&editable&&canEditCadEntity(selected)&&model){event.preventDefault();onEdit?.(deleteCadGeometry(model,[selected.id]),'已删除图元。');setSelectedId(undefined);}
        }}
      />
      {placingAnnotation && <div className="cad-placement-hint" role="status"><Crosshair />点击图纸放置“{placingAnnotation.text}”<small>Esc 取消</small></div>}
      {stale && <div className="cad-preview-stale" role="status">空间或设置已变化，请更新图纸</div>}
      <div className="cad-preview-axis"><span>图纸纵向 ↑</span><span>图纸横向 →</span></div>
      {selected && !selectedDimension && <div className="cad-entity-inspector"><strong>已选图元</strong><span>{formatEntity(selected)}</span></div>}
      {selectedAnnotation && <div className="cad-annotation-inspector">
        <span><strong>{selectedAnnotation.annotation.text}</strong><small>{editable?'拖动可移动':'只读'}</small></span>
        {editable&&<button aria-label={`删除标注 ${selectedAnnotation.annotation.text}`} title="删除标注" onClick={() => onDeleteAnnotation(selectedAnnotation.id)}><Trash2 /></button>}
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
