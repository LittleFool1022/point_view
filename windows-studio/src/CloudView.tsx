import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PointCloudData } from "../../src/domain/types";

import type { BrushStroke } from "./domain/brush";
import { pointInClip, type ClipRule } from "./domain/cleaning";
import { candidateContainsPoint, supportOutline, type PairedFocus } from "./domain/pairedReview";
import { BrushIndex } from "./pipeline/brushSelection";
import type { SourceUnit } from "./pipeline/analysis";
import { tryPickPreviewPoint, type CloudMeasuredPoint, type CloudPointRay } from './domain/measurement';

/** 独立测量预览器；显示抽样与后台完整分析分离。 */
interface CloudViewProps {
  cloud?: PointCloudData; busy?: boolean; onClip?: (rule: ClipRule) => void;
  /** 正在排队的画笔：保存/出图仍锁定，但导航与继续涂擦可用。 */
  editing?: boolean; onBrush?: (stroke: BrushStroke) => Promise<boolean>;onPickPoint?: (ray:CloudPointRay)=>Promise<CloudMeasuredPoint>;
  /** 进入/退出点云编辑工具，供外层让点云成为主画布。 */
  onEditActive?: (active: boolean) => void;
  canUndo?: boolean; canRedo?: boolean; clipCount?: number;
  onUndo?: () => void; onRedo?: () => void; onRestore?: () => void;
  review?: PairedFocus; readOnly?: boolean;
  autoCleanPreview?: { mode: "after" | "before" | "candidates"; beforeVisible?: Uint8Array; highlightMask?: Uint8Array };
  units?: SourceUnit; onUnitsChange?: (units: SourceUnit) => void;
  onImport?: () => void; onDeviceImport?: () => void; onDemo?: () => void;
}
type Tool = "none" | "erase" | "select" | "measure";
type MeasurementState={a:CloudMeasuredPoint;b?:CloudMeasuredPoint;distanceM?:number};
type ScreenPoint = [number, number];
type MeasureOverlayState = {
  a?: ScreenPoint;
  b?: ScreenPoint;
  snap?: { point: ScreenPoint; index: number };
  cursor?: ScreenPoint;
  distanceM?: number;
  liveDistanceM?: number;
};
type ViewName = "top" | "front" | "side" | "iso";
const MIN_RADIUS = 4, MAX_RADIUS = 160;
const clampRadius = (v: number) => Math.round(Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, v)));
function computeLabelPos(a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len >= 72 || len < 1) return [mx, my];
  return [mx - (dy / len) * 22, my + (dx / len) * 22];
}

export function CloudView({ cloud, busy, editing, onBrush, onPickPoint, onEditActive, onClip, canUndo, canRedo, clipCount = 0, onUndo, onRedo, onRestore, review, readOnly, autoCleanPreview, units, onUnitsChange, onImport, onDeviceImport, onDemo }: CloudViewProps) {
  const reviewRef = useRef(review); reviewRef.current = review;
  const autoCleanPreviewRef = useRef(autoCleanPreview); autoCleanPreviewRef.current = autoCleanPreview;
  const reviewPoseKeyRef = useRef<string | undefined>(undefined);
  const cloudRef = useRef(cloud); cloudRef.current = cloud;
  const updateReview = useRef<(focus?: PairedFocus, move?: boolean) => void>(() => {});
  const [reviewPoints, setReviewPoints] = useState(0);
  const [tool, setTool] = useState<Tool>("none");
  const [selMode, setSelMode] = useState<"remove" | "keep">("remove");
  const [radius, setRadius] = useState(24);
  const [depth, setDepth] = useState<"surface" | "through">("surface");
  const [thickness, setThickness] = useState(0.05);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selection, setSelection] = useState<{ rule: ClipRule; count: number }>();
  const [measurement,setMeasurement]=useState<MeasurementState>(),[measureError,setMeasureError]=useState(''),[picking,setPicking]=useState(false);
  const [measureOverlay, setMeasureOverlay] = useState<MeasureOverlayState>();
  const measurementRef=useRef<MeasurementState|undefined>(undefined),pickingRef=useRef(false),measureSequence=useRef(0);
  const measureRenderRef=useRef<(value?:MeasurementState)=>void>(()=>{});
  const measureSyncRef=useRef<()=>void>(()=>{});
  const measureHoverClearRef=useRef<()=>void>(()=>{});
  const updateMeasurement=(value?:MeasurementState)=>{measurementRef.current=value;setMeasurement(value);measureRenderRef.current(value);};
  const clearMeasurement=()=>{measureSequence.current++;pickingRef.current=false;setPicking(false);setMeasureError('');updateMeasurement(undefined);};
  const clearMeasurementRef=useRef(clearMeasurement);clearMeasurementRef.current=clearMeasurement;
  const [sliceMin, setSliceMin] = useState(0), [sliceMax, setSliceMax] = useState(3);
  const [pointSize, setPointSize] = useState(1);
  const [box, setBox] = useState<[number, number, number, number]>();
  const activeTool: Tool = readOnly ? "none" : tool;
  const canEdit = !readOnly && (!busy || !!editing);

  const highlightRef = useRef<(rule?: ClipRule) => number>(() => 0);
  const sizeRef = useRef<(size: number) => void>(() => {});
  const applyVisibleRef = useRef<() => void>(() => {});
  const cancelStrokeRef = useRef<() => boolean>(() => false);
  const cancelDragRef = useRef<() => void>(() => {});
  const cancelInteractionRef = useRef<() => void>(() => {});
  const viewRef = useRef<(view: ViewName) => void>(() => {});
  const controlsRef = useRef<OrbitControls | undefined>(undefined);
  const ringRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const pose = useRef<{ id: string; position: THREE.Vector3; target: THREE.Vector3; zoom: number } | undefined>(undefined);
  const interaction = useRef({ tool: activeTool, selMode, radius, depth, thickness, busy, editing, pointSize, readOnly });
  interaction.current = { tool: activeTool, selMode, radius, depth, thickness, busy, editing, pointSize, readOnly };
  const onBrushRef = useRef(onBrush); onBrushRef.current = onBrush;
  const onPickPointRef=useRef(onPickPoint);onPickPointRef.current=onPickPoint;
  const radiusSetter = useRef(setRadius); radiusSetter.current = setRadius;
  const onEditActiveRef = useRef(onEditActive); onEditActiveRef.current = onEditActive;

  function clearSelection() { setSelection(undefined); setBox(undefined); highlightRef.current(); }
  const clearRef = useRef(clearSelection); clearRef.current = clearSelection;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") cancelInteractionRef.current(); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => { sizeRef.current(pointSize); }, [pointSize]);
  useEffect(() => { onEditActiveRef.current?.(activeTool !== "none"); }, [activeTool]);
  useEffect(() => {
    if (activeTool !== "measure" || busy) measureHoverClearRef.current();
    else measureSyncRef.current();
  }, [activeTool, busy]);
  useEffect(() => () => onEditActiveRef.current?.(false), []);
  useEffect(() => {
    const controls = controlsRef.current; if (!controls) return;
    // 编辑工具占用左键；右键旋转、中键平移始终可用，滚轮围绕光标缩放。
    controls.mouseButtons = { LEFT: activeTool === "none" ? THREE.MOUSE.ROTATE : (null as unknown as THREE.MOUSE), MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.enabled = true;
  }, [activeTool, cloud?.id, cloud?.positions]);

  useEffect(() => {
    const initial = cloudRef.current;
    if (!host.current || !initial) return;
    clearRef.current();clearMeasurementRef.current();
    const node = host.current, scene = new THREE.Scene(); scene.background = new THREE.Color("#20282c");
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); node.append(renderer.domElement);
    const camera = readOnly ? new THREE.PerspectiveCamera(48, 1, .001, 10000) : new THREE.OrthographicCamera(-1, 1, 1, -1, .001, 10000); camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = false; controls.zoomToCursor = true; controlsRef.current = controls;
    controls.mouseButtons = { LEFT: interaction.current.tool === "none" ? THREE.MOUSE.ROTATE : (null as unknown as THREE.MOUSE), MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

    // 抽样点缓冲在源件内保持稳定；visible 变化只更新绘制索引，不重建渲染器与相机。
    const total = initial.visible.length, stride = Math.max(1, Math.ceil(total / 120000)), sampleCount = Math.ceil(total / stride);
    const slotOf = new Int32Array(total).fill(-1), srcOf = new Uint32Array(sampleCount);
    const samplePositions = new Float32Array(sampleCount * 3), baseColors = new Float32Array(sampleCount * 3), colorArray = new Float32Array(sampleCount * 3);
    const bounds = new THREE.Box3(), tmp = new THREE.Vector3(), fill = new THREE.Color();
    for (let s = 0; s < sampleCount; s++) {
      const i = s * stride; srcOf[s] = i; slotOf[i] = s;
      samplePositions[s * 3] = initial.positions[i * 3]!; samplePositions[s * 3 + 1] = initial.positions[i * 3 + 1]!; samplePositions[s * 3 + 2] = initial.positions[i * 3 + 2]!;
      if (initial.attributes?.hasColor) fill.setRGB(initial.colors[i * 3]! / 255, initial.colors[i * 3 + 1]! / 255, initial.colors[i * 3 + 2]! / 255, THREE.SRGBColorSpace); else fill.set("#c7d9cd");
      baseColors[s * 3] = fill.r; baseColors[s * 3 + 1] = fill.g; baseColors[s * 3 + 2] = fill.b;
      if (initial.visible[i]) bounds.expandByPoint(tmp.set(samplePositions[s * 3]!, samplePositions[s * 3 + 1]!, samplePositions[s * 3 + 2]!));
    }
    colorArray.set(baseColors);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(samplePositions, 3));
    const colorAttr = new THREE.BufferAttribute(colorArray, 3); colorAttr.setUsage(THREE.DynamicDrawUsage); geometry.setAttribute("color", colorAttr);
    const drawIndex = new THREE.BufferAttribute(new Uint32Array(sampleCount), 1); drawIndex.setUsage(THREE.DynamicDrawUsage); geometry.setIndex(drawIndex);
    if (bounds.isEmpty()) bounds.expandByPoint(new THREE.Vector3());
    const radiusW = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, .1), center = bounds.getCenter(new THREE.Vector3());
    const material = new THREE.PointsMaterial({ vertexColors: true, size: (readOnly ? Math.max(radiusW / 280, .004) : 1.5) * interaction.current.pointSize, sizeAttenuation: true });
    const points = new THREE.Points(geometry, material); points.frustumCulled = false; scene.add(points);
    const outlineGeometry = new THREE.BufferGeometry(), outlineMaterial = new THREE.LineBasicMaterial({ color: "#ffbd59", depthTest: false });
    const outline = new THREE.Line(outlineGeometry, outlineMaterial); outline.renderOrder = 2; scene.add(outline);
    camera.position.copy(center).add(new THREE.Vector3(radiusW * 1.25, -radiusW * 1.65, radiusW * 1.5)); camera.far = Math.max(100, radiusW * 30); controls.target.copy(center);
    if (pose.current?.id === initial.id) { camera.position.copy(pose.current.position); controls.target.copy(pose.current.target); camera.zoom = pose.current.zoom; camera.updateProjectionMatrix(); }
    controls.update();

    let disposed = false;
    const render = () => { if (!disposed) renderer.render(scene, camera); };
    let hoverCursor: ScreenPoint | undefined, hoverSnap: CloudMeasuredPoint | undefined, hoverRaf = 0;
    const tmpProj = new THREE.Vector3();
    const buildPickRay = (p: ScreenPoint): CloudPointRay | undefined => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return undefined;
      camera.updateMatrixWorld();
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2((p[0] / rect.width) * 2 - 1, 1 - (p[1] / rect.height) * 2), camera);
      const toleranceM = camera instanceof THREE.OrthographicCamera
        ? ((camera.right - camera.left) / camera.zoom / rect.width) * 10
        : (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.distanceTo(controls.target) / rect.height) * 10;
      if (!(toleranceM > 0) || !Number.isFinite(toleranceM)) return undefined;
      return {
        origin: raycaster.ray.origin.toArray() as [number, number, number],
        direction: raycaster.ray.direction.toArray() as [number, number, number],
        toleranceM,
      };
    };
    const projectPoint = (pos: [number, number, number]): ScreenPoint | undefined => {
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      if (!(w > 0 && h > 0)) return undefined;
      camera.updateMatrixWorld();
      tmpProj.set(pos[0], pos[1], pos[2]).applyMatrix4(camera.matrixWorldInverse);
      if (camera instanceof THREE.PerspectiveCamera && tmpProj.z >= -camera.near) return undefined;
      tmpProj.applyMatrix4(camera.projectionMatrix);
      if (!Number.isFinite(tmpProj.x) || !Number.isFinite(tmpProj.y)) return undefined;
      return [(tmpProj.x * 0.5 + 0.5) * w, (0.5 - tmpProj.y * 0.5) * h];
    };
    const refreshHoverSnap = () => {
      const current = cloudRef.current;
      if (!hoverCursor || !current || interaction.current.tool !== "measure" || interaction.current.readOnly || interaction.current.busy || pickingRef.current) {
        hoverSnap = undefined;
        return;
      }
      const ray = buildPickRay(hoverCursor);
      hoverSnap = ray ? tryPickPreviewPoint(samplePositions, srcOf, current.visible, ray) : undefined;
    };
    const syncMeasureOverlay = () => {
      if (disposed) return;
      const measured = measurementRef.current;
      const isMeasure = interaction.current.tool === "measure" && !interaction.current.readOnly;
      if (!measured && (!isMeasure || (!hoverSnap && !hoverCursor))) {
        setMeasureOverlay(prev => (prev ? undefined : prev));
        return;
      }
      const a = measured ? projectPoint(measured.a.position) : undefined;
      const b = measured?.b ? projectPoint(measured.b.position) : undefined;
      const snapPoint = isMeasure && hoverSnap ? projectPoint(hoverSnap.position) : undefined;
      const snap = isMeasure && hoverSnap && snapPoint ? { point: snapPoint, index: hoverSnap.index } : undefined;
      const cursor = isMeasure ? hoverCursor : undefined;
      const liveDistanceM = measured && !measured.b && isMeasure && hoverSnap
        ? Math.hypot(
            hoverSnap.position[0] - measured.a.position[0],
            hoverSnap.position[1] - measured.a.position[1],
            hoverSnap.position[2] - measured.a.position[2]
          )
        : undefined;
      setMeasureOverlay({ a, b, snap, cursor, distanceM: measured?.distanceM, liveDistanceM });
    };
    const clearHover = () => {
      if (hoverRaf) { window.cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
      hoverCursor = undefined; hoverSnap = undefined;
      syncMeasureOverlay();
    };
    measureSyncRef.current = syncMeasureOverlay;
    measureHoverClearRef.current = clearHover;
    measureRenderRef.current = () => { syncMeasureOverlay(); render(); };
    // 着色通道：笔刷预测 > 框选 > 自动清理候选 > 关键帧候选 > 原色。
    const brushMark = new Uint16Array(sampleCount), boxMark = new Uint8Array(sampleCount), cleanMark = new Uint8Array(sampleCount), reviewMark = new Uint8Array(sampleCount);
    const setColor = (s: number) => {
      let r = baseColors[s * 3]!, g = baseColors[s * 3 + 1]!, b = baseColors[s * 3 + 2]!;
      if (reviewMark[s]) { r = 1; g = .62; b = .16; }
      if (cleanMark[s] === 1) { r = 1; g = .56; b = .16; }
      else if (cleanMark[s] === 2) { r = 1; g = .26; b = .38; }
      if (boxMark[s]) { r = 1; g = .52; b = .18; }
      if (brushMark[s]) { r = 1; g = .2; b = .18; }
      colorArray[s * 3] = r; colorArray[s * 3 + 1] = g; colorArray[s * 3 + 2] = b;
    };
    const paint = (index: number, on: boolean) => {
      const s = slotOf[index]!; if (s < 0) return;
      if (on) brushMark[s]!++; else if (brushMark[s]) brushMark[s]!--;
      setColor(s);
    };
    const applyVisible = () => {
      const current = cloudRef.current; if (!current || disposed) return;
      const visible = current.visible;
      const cleanOverlay = autoCleanPreviewRef.current;
      const useBefore = (cleanOverlay?.mode === "before" || cleanOverlay?.mode === "candidates") && cleanOverlay.beforeVisible?.length === visible.length;
      const displayVisible = useBefore ? cleanOverlay.beforeVisible! : visible;
      const highlight = (cleanOverlay?.mode === "before" || cleanOverlay?.mode === "candidates") ? cleanOverlay.highlightMask : undefined;
      let count = 0; const arr = drawIndex.array as Uint32Array;
      for (let s = 0; s < sampleCount; s++) {
        const srcIdx = srcOf[s]!;
        if (displayVisible[srcIdx]) arr[count++] = s;
        const nextMark = highlight?.length === visible.length ? highlight[srcIdx]! : 0;
        if (cleanMark[s] !== nextMark) { cleanMark[s] = nextMark; setColor(s); }
      }
      drawIndex.needsUpdate = true; geometry.setDrawRange(0, count);
      colorAttr.needsUpdate = true;
      if (previewCloud && previewCloud.visible.length === visible.length) previewCloud.visible.set(visible);
      const measured=measurementRef.current;if(measured&&(!visible[measured.a.index]||(measured.b&&!visible[measured.b.index])))clearMeasurementRef.current();
      refreshHoverSnap();
      syncMeasureOverlay();
      clearSettled();
      render();
    };
    applyVisibleRef.current = applyVisible;

    // 本地命中预览：与权威 mask 一致的副本，仅用于高亮。
    let previewIndex: BrushIndex | undefined, previewCloud: PointCloudData | undefined;
    const getIndex = () => {
      if (previewIndex) return previewIndex;
      const c = cloudRef.current; if (!c) return undefined;
      const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < total; i++) for (let a = 0; a < 3; a++) { const v = c.positions[i * 3 + a]!; if (v < min[a]!) min[a] = v; if (v > max[a]!) max[a] = v; }
      previewCloud = { ...c, visible: new Uint8Array(c.visible) };
      previewIndex = new BrushIndex(previewCloud, { min, max }); return previewIndex;
    };

    // 笔画状态
    interface Live { pid: number; path: Array<[number, number]>; matrix: number[]; viewMatrix: number[]; viewport: [number, number]; radiusPx: number; depth: "surface" | "through"; thicknessM: number; hits: Set<number>; done: number }
    let live: Live | undefined, boxStart: [number, number] | undefined;
    let settled: Array<Set<number>> = [], settleTimer = 0;
    function unpaint(hits: Set<number>) { hits.forEach(i => paint(i, false)); colorAttr.needsUpdate = true; }
    function clearSettled() { window.clearTimeout(settleTimer); if (!settled.length) return; settled.forEach(unpaint); settled = []; render(); }
    const local = (e: PointerEvent): [number, number] => { const r = renderer.domElement.getBoundingClientRect(); return [Math.max(0, Math.min(r.width, e.clientX - r.left)), Math.max(0, Math.min(r.height, e.clientY - r.top))]; };
    const ring = (e: PointerEvent | undefined) => {
      const el = ringRef.current; if (!el) return;
      if (!e || interaction.current.tool !== "erase" || interaction.current.readOnly) { el.classList.remove("is-on"); return; }
      const r = renderer.domElement.getBoundingClientRect();
      el.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px) translate(-50%, -50%)`; el.classList.add("is-on");
    };
    const previewFrom = (st: Live, from: number) => {
      const index = getIndex(); if (!index) return;
      try {
        const hits = index.select({ matrix: st.matrix, viewMatrix: st.viewMatrix, viewport: st.viewport, path: st.path.slice(Math.max(0, from - 1)), radiusPx: st.radiusPx, depth: st.depth, thicknessM: st.thicknessM });
        for (let k = 0; k < hits.length; k++) { const i = hits[k]!; if (!st.hits.has(i)) { st.hits.add(i); paint(i, true); } }
        colorAttr.needsUpdate = true; render();
      } catch { /* 预览失败不影响提交 */ }
    };
    const endLive = (e?: PointerEvent) => {
      if (!live) return; const pid = live.pid; live = undefined; controls.enabled = true;
      if (e && renderer.domElement.hasPointerCapture(pid)) renderer.domElement.releasePointerCapture(pid);
    };
    cancelStrokeRef.current = () => {
      if (!live) return false; const st = live; endLive(); unpaint(st.hits); render(); return true;
    };
    const down = (e: PointerEvent) => {
      node.focus({ preventScroll: true }); setSettingsOpen(false);
      const it = interaction.current;
      if (e.button !== 0) { clearHover(); return; }
      if (it.readOnly || it.tool === "none") return;
      if (it.tool === 'measure') {
        if (it.busy || pickingRef.current) return;
        const submit = onPickPointRef.current; if (!submit) { setMeasureError('测距分析尚未就绪。'); return; }
        const p = local(e); hoverCursor = p;
        const ray = buildPickRay(p); if (!ray) return;
        const sequence = ++measureSequence.current; pickingRef.current = true; setPicking(true); setMeasureError('');
        void submit(ray).then(point => {
          if (disposed || sequence !== measureSequence.current) return;
          const current = measurementRef.current;
          if (!current || current.b) updateMeasurement({ a: point });
          else updateMeasurement({ a: current.a, b: point, distanceM: Math.hypot(point.position[0] - current.a.position[0], point.position[1] - current.a.position[1], point.position[2] - current.a.position[2]) });
        }).catch(error => { if (sequence === measureSequence.current) setMeasureError(error instanceof Error ? error.message : String(error)); }).finally(() => {
          if (sequence === measureSequence.current) {
            pickingRef.current = false; setPicking(false);
            refreshHoverSnap(); syncMeasureOverlay();
          }
        });
        return;
      }
      if (it.tool === "erase") {
        if (it.busy && !it.editing) return;
        camera.updateMatrixWorld(); const r = renderer.domElement.getBoundingClientRect(), p = local(e);
        const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        live = { pid: e.pointerId, path: [p], matrix: projection.toArray(), viewMatrix: camera.matrixWorldInverse.toArray(), viewport: [r.width, r.height], radiusPx: it.radius, depth: it.depth, thicknessM: it.thickness, hits: new Set(), done: 0 };
        controls.enabled = false; renderer.domElement.setPointerCapture(e.pointerId); previewFrom(live, 0); live.done = 1;
      } else {
        if (it.busy) return;
        clearRef.current(); boxStart = local(e); renderer.domElement.setPointerCapture(e.pointerId); setBox([boxStart[0], boxStart[1], boxStart[0], boxStart[1]]);
      }
    };
    const move = (e: PointerEvent) => {
      ring(e);
      if (interaction.current.tool === "measure" && !interaction.current.readOnly) {
        if (e.buttons !== 0 || interaction.current.busy || pickingRef.current) {
          if (hoverCursor || hoverSnap) clearHover();
        } else {
          hoverCursor = local(e);
          if (!hoverRaf) {
            hoverRaf = window.requestAnimationFrame(() => {
              hoverRaf = 0;
              if (disposed || !hoverCursor || interaction.current.tool !== "measure" || interaction.current.readOnly) return;
              refreshHoverSnap();
              syncMeasureOverlay();
            });
          }
        }
      }
      if (live) {
        const st = live, events = e.getCoalescedEvents?.() ?? [e], before = st.path.length;
        for (const ev of events) {
          const p = local(ev), last = st.path[st.path.length - 1]!;
          if (st.path.length < 8192 && Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1) st.path.push(p);
        }
        if (st.path.length > before) previewFrom(st, before);
      } else if (boxStart) {
        const end = local(e); setBox([Math.min(boxStart[0], end[0]), Math.min(boxStart[1], end[1]), Math.max(boxStart[0], end[0]), Math.max(boxStart[1], end[1])]);
      }
    };
    const up = (e: PointerEvent) => {
      if (live && e.button === 0) {
        const st = live; endLive(e);
        const stroke: BrushStroke = { matrix: st.matrix, viewMatrix: st.viewMatrix, viewport: st.viewport, path: st.path, radiusPx: st.radiusPx, depth: st.depth, thicknessM: st.thicknessM };
        const submit = onBrushRef.current;
        if (!submit || (interaction.current.busy && !interaction.current.editing)) { unpaint(st.hits); render(); return; }
        const finish = (ok: boolean) => {
          if (disposed) return;
          if (!ok) { unpaint(st.hits); render(); return; }
          settled.push(st.hits); window.clearTimeout(settleTimer); settleTimer = window.setTimeout(clearSettled, 180);
        };
        submit(stroke).then(finish, () => finish(false));
        return;
      }
      if (!boxStart || interaction.current.tool !== "select") { boxStart = undefined; return; } const end = local(e), begin = boxStart; boxStart = undefined;
      if (Math.abs(end[0] - begin[0]) < 5 || Math.abs(end[1] - begin[1]) < 5 || interaction.current.busy) { clearRef.current(); return; }
      camera.updateMatrixWorld(); const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray();
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      const rule: ClipRule = { matrix, mode: interaction.current.selMode === "keep" ? "keep" : "remove", rect: [Math.min(begin[0], end[0]) / w * 2 - 1, 1 - Math.max(begin[1], end[1]) / h * 2, Math.max(begin[0], end[0]) / w * 2 - 1, 1 - Math.min(begin[1], end[1]) / h * 2] };
      setSelection({ rule, count: highlightRef.current(rule) });
    };
    const cancelDrag = () => { if (live) cancelStrokeRef.current(); boxStart = undefined; clearRef.current(); clearHover(); };
    cancelDragRef.current = cancelDrag;
    const abort = () => { cancelDrag(); if (measurementRef.current && !measurementRef.current.b) clearMeasurementRef.current(); };
    cancelInteractionRef.current = abort;
    const leave = () => { ring(undefined); clearHover(); };
    const context = (e: Event) => e.preventDefault();
    const wheel = (e: WheelEvent) => {
      if (!e.altKey || interaction.current.tool !== "erase" || interaction.current.readOnly) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!live) radiusSetter.current(r => clampRadius(r * (e.deltaY < 0 ? 1.12 : 1 / 1.12) + (e.deltaY < 0 ? 1 : -1) * .5));
    };
    const el = renderer.domElement;
    el.addEventListener("wheel", wheel, { capture: true, passive: false });
    el.addEventListener("pointerdown", down); el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", abort); el.addEventListener("pointerleave", leave); el.addEventListener("contextmenu", context);

    updateReview.current = (focus, move = false) => {
      let count = 0; const visible = cloudRef.current?.visible;
      for (let s = 0; s < sampleCount; s++) {
        const selected = !!focus && !!visible?.[srcOf[s]!] && candidateContainsPoint(samplePositions.subarray(s * 3, s * 3 + 3) as unknown as number[], focus);
        reviewMark[s] = selected ? 1 : 0; if (selected) count++; setColor(s);
      }
      colorAttr.needsUpdate = true; setReviewPoints(count);
      outlineGeometry.setFromPoints((focus ? supportOutline(focus) : []).map(p => new THREE.Vector3(p[0], p[1], p[2])));
      outlineGeometry.computeBoundingSphere();
      if (focus && move) {
        const t = focus.frame.TWorldCamera;
        camera.position.set(t[3]!, t[7]!, t[11]!); camera.up.set(-t[1]!, -t[5]!, -t[9]!);
        controls.target.copy(camera.position).add(new THREE.Vector3(t[2], t[6], t[10]).multiplyScalar(Math.max(1, radiusW)));
        if (camera instanceof THREE.PerspectiveCamera) camera.fov = 2 * Math.atan(focus.camera.height / (2 * focus.camera.intrinsics[1]!)) * 180 / Math.PI;
        camera.updateProjectionMatrix(); controls.update();
      }
      render();
    };
    highlightRef.current = rule => {
      let count = 0; const visible = cloudRef.current?.visible;
      for (let s = 0; s < sampleCount; s++) {
        const selected = !!rule && !!visible?.[srcOf[s]!] && pointInClip(samplePositions[s * 3]!, samplePositions[s * 3 + 1]!, samplePositions[s * 3 + 2]!, rule);
        boxMark[s] = selected ? 1 : 0; if (selected) count++; setColor(s);
      }
      colorAttr.needsUpdate = true; render(); return count;
    };
    sizeRef.current = size => { material.size = (readOnly ? Math.max(radiusW / 280, .004) : 1.5) * size; render(); };
    viewRef.current = view => {
      const offset = view === "top" ? new THREE.Vector3(0, -.0001, radiusW * 2.7) : view === "front" ? new THREE.Vector3(0, -radiusW * 2.7, 0) : view === "side" ? new THREE.Vector3(radiusW * 2.7, 0, 0) : new THREE.Vector3(radiusW * 1.25, -radiusW * 1.65, radiusW * 1.5);
      camera.up.set(0, 0, 1); camera.zoom = 1; camera.updateProjectionMatrix(); camera.position.copy(center).add(offset); controls.target.copy(center); controls.update(); render();
    };
    // 窗口缩放只更新视锥，不重置相机；仅作废依赖旧视口的选区与未提交笔画。
    const resize = () => {
      if (live) cancelStrokeRef.current(); boxStart = undefined; clearRef.current(); clearHover();
      const w = Math.max(1, node.clientWidth), h = Math.max(1, node.clientHeight), aspect = w / h;
      renderer.setSize(w, h);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = aspect;
      } else {
        const span = radiusW * 1.15;
        if (aspect >= 1) { camera.left = -span * aspect; camera.right = span * aspect; camera.top = span; camera.bottom = -span; }
        else { camera.left = -span; camera.right = span; camera.top = span / aspect; camera.bottom = -span / aspect; }
      }
      camera.updateProjectionMatrix();
      if (reviewRef.current) updateReview.current(reviewRef.current);
      syncMeasureOverlay();
      render();
    };
    applyVisible();
    const onControlsChange = () => { render(); refreshHoverSnap(); syncMeasureOverlay(); };
    const observer = new ResizeObserver(resize); observer.observe(node); controls.addEventListener("change", onControlsChange); resize();
    return () => {
      disposed = true; window.clearTimeout(settleTimer); if (hoverRaf) window.cancelAnimationFrame(hoverRaf); reviewPoseKeyRef.current = undefined;
      updateReview.current = () => {}; highlightRef.current = () => 0; sizeRef.current = () => {}; applyVisibleRef.current = () => {}; cancelStrokeRef.current = () => false; cancelDragRef.current = () => {}; cancelInteractionRef.current = () => {}; measureSyncRef.current = () => {}; measureHoverClearRef.current = () => {}; controlsRef.current = undefined;
      pose.current = { id: initial.id, position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom };
      el.removeEventListener("wheel", wheel, { capture: true }); el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", abort); el.removeEventListener("pointerleave", leave); el.removeEventListener("contextmenu", context);
      controls.removeEventListener("change", onControlsChange);
      observer.disconnect(); controls.dispose(); outlineGeometry.dispose(); outlineMaterial.dispose(); measureRenderRef.current = () => {}; geometry.dispose(); material.dispose(); renderer.dispose(); renderer.domElement.remove();
    };
  }, [cloud?.id, cloud?.positions, readOnly]);
  const reviewSpatialKey = review ? JSON.stringify([cloud?.id, review.frame.id, review.frame.TWorldCamera, review.camera, review.candidate?.id, review.candidate?.box, review.candidate?.envelope, review.wall]) : "";
  const reviewPoseKey = review ? `${cloud?.id ?? ""}:${review.frame.id}:${review.candidate?.id ?? ""}` : "";
  // 权威 mask 变化：只更新绘制索引。
  useEffect(() => { applyVisibleRef.current(); if (reviewRef.current) updateReview.current(reviewRef.current); }, [cloud?.visible, autoCleanPreview]);
  useEffect(() => {
    const move = !!reviewPoseKey && reviewPoseKey !== reviewPoseKeyRef.current;
    reviewPoseKeyRef.current = reviewPoseKey || undefined;
    updateReview.current(reviewRef.current, move);
  }, [reviewSpatialKey, reviewPoseKey, cloud?.id, cloud?.positions]);

  function chooseTool(next: Exclude<Tool, "none">) {
    if (next === "measure") cancelDragRef.current();
    else cancelInteractionRef.current();
    measureSequence.current++; pickingRef.current = false; setPicking(false); setMeasureError('');
    setTool(prev => prev === next ? "none" : next);
  }
  function observe() { cancelDragRef.current(); measureSequence.current++; pickingRef.current = false; setPicking(false); setTool("none"); }
  function applySelection() { if (!selection || busy) return; const rule = selection.rule; clearSelection(); onClip?.(rule); }
  function changeView(value: string) { if (!value) return; cancelDragRef.current(); viewRef.current(value as ViewName); if (review) updateReview.current(review); }
  function onKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "delete" && selection?.rule.mode === "remove" && !readOnly && !busy) { e.preventDefault(); e.stopPropagation(); applySelection(); return; }
      if (k === "1") { e.preventDefault(); changeView("front"); return; }
      if (k === "2") { e.preventDefault(); changeView("side"); return; }
      if (k === "3") { e.preventDefault(); changeView("top"); return; }
      if (k === "0" || k === "f") { e.preventDefault(); changeView("iso"); return; }
      if (!readOnly && !busy) {
        if (k === "v") { e.preventDefault(); observe(); return; }
        if (k === "e" && canEdit) { e.preventDefault(); chooseTool("erase"); return; }
        if (k === "b") { e.preventDefault(); chooseTool("select"); return; }
        if (k === "m") { e.preventDefault(); chooseTool("measure"); return; }
      }
      return;
    }
    if (readOnly) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase(), redo = key === "y" || (key === "z" && e.shiftKey), undo = key === "z" && !e.shiftKey;
    if (!undo && !redo) return;
    e.preventDefault(); e.stopPropagation();
    if (busy) return;
    if (undo && canUndo) { clearSelection(); onUndo?.(); } else if (redo && canRedo) { clearSelection(); onRedo?.(); }
  }
  const sliceOk = Number.isFinite(sliceMin) && Number.isFinite(sliceMax) && sliceMin < sliceMax;
  return <div className={`cloud-view tool-${activeTool} ${canEdit ? "" : "is-locked"}`} ref={host} tabIndex={-1} onKeyDown={onKeyDown} aria-label="测量点云三维视图" data-review-candidate={review?.candidate?.id} data-review-points={reviewPoints} data-measure-points={measurement?.b?2:measurement?1:0} data-measure-distance={measurement?.distanceM} data-autoclean-view={autoCleanPreview?.mode ?? "after"}>
    {cloud && <>
      <div className="cloud-tools" role="toolbar" aria-label="点云工具">
        {!readOnly && <>
          <div className="cloud-seg">
            <button aria-pressed={tool === "none"} title="观察 (V)：左键旋转，中键平移，滚轮缩放" onClick={observe}>观察</button>
            <button aria-pressed={tool === "erase"} disabled={!canEdit} title="橡皮擦 (E)：左键涂擦，Esc 取消本笔" onClick={() => chooseTool("erase")}>橡皮擦</button>
            <button aria-pressed={tool === "select"} disabled={!!busy} title="框选 (B)：拖框选择后确认，V 返回观察" onClick={() => chooseTool("select")}>选区</button>
            <button aria-pressed={tool === "measure"} disabled={!!busy} title="测距 (M)：依次点击两个实际点云点" onClick={() => chooseTool("measure")}>测距</button>
          </div>
          <div className="cloud-seg">
            <button disabled={!canUndo || !!busy} title="撤销 Ctrl+Z" onClick={() => { clearSelection(); onUndo?.(); }}>撤销</button>
            <button disabled={!canRedo || !!busy} title="重做 Ctrl+Y" onClick={() => { clearSelection(); onRedo?.(); }}>重做</button>
          </div>
        </>}
        <select className="cloud-view-select" aria-label="视角" title="切换视角 (1正视 / 2侧视 / 3俯视 / 0斜视)" value="" onChange={e => changeView(e.target.value)}>
          <option value="" disabled>视角</option><option value="iso">斜视</option><option value="top">俯视</option><option value="front">正视</option><option value="side">侧视</option>
        </select>
        {review && <><button onClick={() => updateReview.current(review, true)}>关键帧视角</button><span>框内墙带预览点 {reviewPoints.toLocaleString()}</span></>}
        <button aria-expanded={settingsOpen} aria-controls="point-cloud-settings" title="显示与范围设置" onClick={() => setSettingsOpen(v => !v)}>设置</button>
      </div>
      {!readOnly && activeTool !== "none" && <div className="cloud-options" role="group" aria-label={activeTool === "erase" ? "橡皮擦选项" : activeTool==='select'?'选区选项':'点云测距选项'}>
        {activeTool==='measure'?<div className="cloud-selection" role="status" aria-label="点云测距结果">
          {picking?<span>拾取源点中…</span>:measureError?<span>{measureError}</span>:measurement?.b?<><span>距离 <strong>{measurement.distanceM!.toFixed(3)} m</strong></span><small>{(measurement.distanceM!*1000).toFixed(1)} mm</small></>:<span>{measurement?'已定 A 点 · 请选择第二个点':'请选择第一个点'}</span>}
          <button disabled={!measurement} onClick={clearMeasurement}>清除测线</button>
        </div>:activeTool === "erase" ? <>
          <label className="cloud-opt" title="Alt+滚轮可调整半径">半径<input aria-label="笔刷半径" type="range" min={MIN_RADIUS} max={MAX_RADIUS} step="1" value={radius} onChange={e => setRadius(clampRadius(Number(e.target.value)))}/><output>{radius}px</output></label>
          <div className="cloud-seg" role="group" aria-label="擦除深度">
            <button aria-pressed={depth === "surface"} title="只擦光标下最靠近视线的表面" onClick={() => setDepth("surface")}>表面</button>
            <button aria-pressed={depth === "through"} title="擦除光标范围内所有深度" onClick={() => setDepth("through")}>穿透</button>
          </div>
          {depth === "surface" && <label className="cloud-opt" title="表面向后的擦除深度">深度<input aria-label="表面深度厚度 米" type="range" min="0.01" max="1" step="0.01" value={thickness} onChange={e => setThickness(Math.max(.01, Math.min(1, Number(e.target.value))))}/><output>{thickness.toFixed(2)} m</output></label>}
        </> : <>
          <div className="cloud-seg" role="group" aria-label="框选方式">
            <button aria-pressed={selMode === "remove"} onClick={() => { clearSelection(); setSelMode("remove"); }}>剔除框内</button>
            <button aria-pressed={selMode === "keep"} onClick={() => { clearSelection(); setSelMode("keep"); }}>保留框内</button>
          </div>
          {selection
            ? <div className="cloud-selection" role="status"><span>已选 <strong>{selection.count.toLocaleString()}</strong> 点</span>
                <button className={selection.rule.mode === "keep" ? "primary" : "delete-selection"} disabled={!!busy} aria-keyshortcuts={selection.rule.mode === "remove" ? "Delete" : undefined} title={selection.rule.mode === "remove" ? "删除选中 (Delete)" : "确认保留框内点云"} onClick={applySelection}>{selection.rule.mode === "keep" ? "确认保留" : "删除选中"}</button>
                <button onClick={clearSelection}>取消</button></div>
            : <small className="cloud-hint">拖框选择 · 右键旋转</small>}
        </>}
      </div>}
      {settingsOpen && <aside className="point-cloud-settings" id="point-cloud-settings" aria-label="点云显示设置">
        <label className="point-size">显示点大小 <span>{pointSize.toFixed(1)}×</span><input aria-label="显示点大小" type="range" min="0.5" max="3" step="0.25" value={pointSize} onChange={e => setPointSize(Number(e.target.value))}/></label>
        {!readOnly && <>
          <fieldset disabled={!!busy}><legend>高度范围</legend>
            <label>Z 下限 m<input aria-label="剖切下限 m" type="number" step=".01" value={sliceMin} onChange={e => setSliceMin(Number(e.target.value))}/></label>
            <label>Z 上限 m<input aria-label="剖切上限 m" type="number" step=".01" value={sliceMax} onChange={e => setSliceMax(Number(e.target.value))}/></label>
            <button disabled={!sliceOk} onClick={() => { clearSelection(); onClip?.({ axis: "z", rangeM: [sliceMin, sliceMax], mode: "keep" }); }}>保留高度范围</button>
          </fieldset>
          <button disabled={!!busy || !clipCount} onClick={() => { clearSelection(); onRestore?.(); }}>恢复全部源点</button>
        </>}
      </aside>}
      <div className="brush-ring" ref={ringRef} data-depth={depth} style={{ width: radius * 2, height: radius * 2 }} aria-hidden="true"/>
      {measureOverlay && <div className="measure-hud" aria-hidden="true">
        <svg className="measure-overlay">
          {measureOverlay.a && measureOverlay.b && (
            <g data-measure-line="fixed">
              <line className="measure-line-casing" x1={measureOverlay.a[0]} y1={measureOverlay.a[1]} x2={measureOverlay.b[0]} y2={measureOverlay.b[1]} />
              <line className="measure-line-core" x1={measureOverlay.a[0]} y1={measureOverlay.a[1]} x2={measureOverlay.b[0]} y2={measureOverlay.b[1]} />
            </g>
          )}
          {measureOverlay.a && !measureOverlay.b && (measureOverlay.snap?.point ?? measureOverlay.cursor) && (() => {
            const target = measureOverlay.snap?.point ?? measureOverlay.cursor!;
            const snapped = !!measureOverlay.snap;
            return (
              <g data-measure-line="dynamic" data-snapped={snapped ? "true" : "false"}>
                <line className="measure-line-casing is-dynamic" x1={measureOverlay.a[0]} y1={measureOverlay.a[1]} x2={target[0]} y2={target[1]} />
                <line className={`measure-line-core is-dynamic ${snapped ? "is-snapped" : ""}`} x1={measureOverlay.a[0]} y1={measureOverlay.a[1]} x2={target[0]} y2={target[1]} />
              </g>
            );
          })()}
          {measureOverlay.snap && (
            <g className="measure-snap-reticle" data-measure-snap="true" data-snap-index={measureOverlay.snap.index} transform={`translate(${measureOverlay.snap.point[0]}, ${measureOverlay.snap.point[1]})`}>
              <circle className="measure-snap-halo" r={8.5} />
              <circle className="measure-snap-ring" r={8.5} />
              <circle className="measure-snap-dot" r={2.5} />
            </g>
          )}
          {measureOverlay.a && (
            <g className="measure-endpoint is-a" data-measure-marker="A" transform={`translate(${measureOverlay.a[0]}, ${measureOverlay.a[1]})`}>
              <circle className="measure-endpoint-halo" r={12.5} />
              <circle className="measure-endpoint-circle" r={10.5} />
              <text y={0.5} textAnchor="middle" dominantBaseline="central">A</text>
            </g>
          )}
          {measureOverlay.b && (
            <g className="measure-endpoint is-b" data-measure-marker="B" transform={`translate(${measureOverlay.b[0]}, ${measureOverlay.b[1]})`}>
              <circle className="measure-endpoint-halo" r={12.5} />
              <circle className="measure-endpoint-circle" r={10.5} />
              <text y={0.5} textAnchor="middle" dominantBaseline="central">B</text>
            </g>
          )}
        </svg>
        {measureOverlay.a && measureOverlay.b && measureOverlay.distanceM !== undefined && (() => {
          const [lx, ly] = computeLabelPos(measureOverlay.a, measureOverlay.b);
          return (
            <div className="measure-midpoint-label" data-measure-midpoint-label="fixed" style={{ left: lx, top: ly }}>
              {measureOverlay.distanceM.toFixed(3)} m
            </div>
          );
        })()}
        {measureOverlay.a && !measureOverlay.b && measureOverlay.snap && measureOverlay.liveDistanceM !== undefined && (() => {
          const [lx, ly] = computeLabelPos(measureOverlay.a, measureOverlay.snap.point);
          return (
            <div className="measure-midpoint-label is-dynamic" data-measure-midpoint-label="dynamic" style={{ left: lx, top: ly }}>
              {measureOverlay.liveDistanceM.toFixed(3)} m
            </div>
          );
        })()}
      </div>}
    </>}
    {box && <div className="clip-box" style={{ left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1] }}/>}
    {!cloud && <div className="empty-view">
      <span className="empty-badge">PCD · PLY · LAS · LAZ</span>
      <strong>导入测量成果</strong>
      {!readOnly && (onImport || onDemo || onDeviceImport) ? <>
        <span>导入点云文件或打开示例开始整理与出图</span>
        <div className="empty-actions">
          {onImport && <button className="primary" disabled={!!busy} onClick={onImport}>导入测量成果</button>}
          {onDeviceImport && <button disabled={!!busy} onClick={onDeviceImport}>从设备接收</button>}
          {onDemo && <button disabled={!!busy} onClick={onDemo}>打开示例</button>}
        </div>
        {units && onUnitsChange && <label className="empty-unit">导入单位<select aria-label="源文件坐标单位" disabled={!!busy} value={units} onChange={e => onUnitsChange(e.target.value as SourceUnit)}><option value="m">米</option><option value="mm">毫米</option></select></label>}
      </> : <span>使用菜单导入测量成果或打开示例</span>}
    </div>}
  </div>;
}
