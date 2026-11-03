import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PointCloudData } from "../../src/domain/types";

import type { BrushStroke } from "./domain/brush";
import { pointInClip, type ClipRule } from "./domain/cleaning";
import { candidateContainsPoint, supportOutline, type PairedFocus } from "./domain/pairedReview";
import { BrushIndex } from "./pipeline/brushSelection";

/** 独立测量预览器；显示抽样与后台完整分析分离。 */
interface CloudViewProps {
  cloud?: PointCloudData; busy?: boolean; onClip?: (rule: ClipRule) => void;
  /** 正在排队的画笔：保存/出图仍锁定，但导航与继续涂擦可用。 */
  editing?: boolean; onBrush?: (stroke: BrushStroke) => Promise<boolean>;
  /** 进入/退出点云编辑工具，供外层让点云成为主画布。 */
  onEditActive?: (active: boolean) => void;
  canUndo?: boolean; canRedo?: boolean; clipCount?: number;
  onUndo?: () => void; onRedo?: () => void; onRestore?: () => void;
  review?: PairedFocus; readOnly?: boolean;
}
type Tool = "none" | "erase" | "select";
type ViewName = "top" | "front" | "side" | "iso";
const MIN_RADIUS = 4, MAX_RADIUS = 160;
const clampRadius = (v: number) => Math.round(Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, v)));

export function CloudView({ cloud, busy, editing, onBrush, onEditActive, onClip, canUndo, canRedo, clipCount = 0, onUndo, onRedo, onRestore, review, readOnly }: CloudViewProps) {
  const reviewRef = useRef(review); reviewRef.current = review;
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
  const [sliceMin, setSliceMin] = useState(0), [sliceMax, setSliceMax] = useState(3);
  const [pointSize, setPointSize] = useState(1);
  const [box, setBox] = useState<[number, number, number, number]>();
  const activeTool: Tool = readOnly ? "none" : tool;
  const canEdit = !readOnly && (!busy || !!editing);

  const highlightRef = useRef<(rule?: ClipRule) => number>(() => 0);
  const sizeRef = useRef<(size: number) => void>(() => {});
  const applyVisibleRef = useRef<() => void>(() => {});
  const cancelStrokeRef = useRef<() => boolean>(() => false);
  const viewRef = useRef<(view: ViewName) => void>(() => {});
  const controlsRef = useRef<OrbitControls | undefined>(undefined);
  const ringRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const pose = useRef<{ id: string; position: THREE.Vector3; target: THREE.Vector3; zoom: number } | undefined>(undefined);
  const interaction = useRef({ tool: activeTool, selMode, radius, depth, thickness, busy, editing, pointSize, readOnly });
  interaction.current = { tool: activeTool, selMode, radius, depth, thickness, busy, editing, pointSize, readOnly };
  const onBrushRef = useRef(onBrush); onBrushRef.current = onBrush;
  const radiusSetter = useRef(setRadius); radiusSetter.current = setRadius;
  const onEditActiveRef = useRef(onEditActive); onEditActiveRef.current = onEditActive;

  function clearSelection() { setSelection(undefined); setBox(undefined); highlightRef.current(); }
  const clearRef = useRef(clearSelection); clearRef.current = clearSelection;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !cancelStrokeRef.current()) clearRef.current(); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => { sizeRef.current(pointSize); }, [pointSize]);
  useEffect(() => { onEditActiveRef.current?.(activeTool !== "none"); }, [activeTool]);
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
    clearRef.current();
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
    // 着色通道：笔刷预测 > 框选 > 关键帧候选 > 原色。
    const brushMark = new Uint16Array(sampleCount), boxMark = new Uint8Array(sampleCount), reviewMark = new Uint8Array(sampleCount);
    const setColor = (s: number) => {
      let r = baseColors[s * 3]!, g = baseColors[s * 3 + 1]!, b = baseColors[s * 3 + 2]!;
      if (reviewMark[s]) { r = 1; g = .62; b = .16; }
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
      const visible = current.visible; let count = 0; const arr = drawIndex.array as Uint32Array;
      for (let s = 0; s < sampleCount; s++) if (visible[srcOf[s]!]) arr[count++] = s;
      drawIndex.needsUpdate = true; geometry.setDrawRange(0, count);
      if (previewCloud && previewCloud.visible.length === visible.length) previewCloud.visible.set(visible);
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
      if (it.readOnly || e.button !== 0 || it.tool === "none") return;
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
      if (!boxStart) return; const end = local(e), begin = boxStart; boxStart = undefined;
      if (Math.abs(end[0] - begin[0]) < 5 || Math.abs(end[1] - begin[1]) < 5 || interaction.current.busy) { clearRef.current(); return; }
      camera.updateMatrixWorld(); const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray();
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      const rule: ClipRule = { matrix, mode: interaction.current.selMode === "keep" ? "keep" : "remove", rect: [Math.min(begin[0], end[0]) / w * 2 - 1, 1 - Math.max(begin[1], end[1]) / h * 2, Math.max(begin[0], end[0]) / w * 2 - 1, 1 - Math.min(begin[1], end[1]) / h * 2] };
      setSelection({ rule, count: highlightRef.current(rule) });
    };
    const abort = () => { if (live) cancelStrokeRef.current(); boxStart = undefined; clearRef.current(); };
    const leave = () => ring(undefined);
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
      if (live) cancelStrokeRef.current(); boxStart = undefined; clearRef.current();
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
      render();
    };
    applyVisible();
    const observer = new ResizeObserver(resize); observer.observe(node); controls.addEventListener("change", render); resize();
    return () => {
      disposed = true; window.clearTimeout(settleTimer);
      updateReview.current = () => {}; highlightRef.current = () => 0; sizeRef.current = () => {}; applyVisibleRef.current = () => {}; cancelStrokeRef.current = () => false; controlsRef.current = undefined;
      pose.current = { id: initial.id, position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom };
      el.removeEventListener("wheel", wheel, { capture: true }); el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", abort); el.removeEventListener("pointerleave", leave); el.removeEventListener("contextmenu", context);
      observer.disconnect(); controls.dispose(); outlineGeometry.dispose(); outlineMaterial.dispose(); geometry.dispose(); material.dispose(); renderer.dispose(); renderer.domElement.remove();
    };
  }, [cloud?.id, cloud?.positions, readOnly]);
  // 权威 mask 变化：只更新绘制索引。
  useEffect(() => { applyVisibleRef.current(); if (reviewRef.current) updateReview.current(reviewRef.current); }, [cloud?.visible]);
  useEffect(() => { updateReview.current(review, true); }, [review, cloud?.id, cloud?.positions]);

  function chooseTool(next: Exclude<Tool, "none">) { clearSelection(); setTool(prev => prev === next ? "none" : next); }
  function applySelection() { if (!selection || busy) return; const rule = selection.rule; clearSelection(); onClip?.(rule); }
  function changeView(value: string) { if (!value) return; clearSelection(); viewRef.current(value as ViewName); if (review) updateReview.current(review); }
  function onKeyDown(e: React.KeyboardEvent) {
    if (readOnly) return;
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase(), redo = key === "y" || (key === "z" && e.shiftKey), undo = key === "z" && !e.shiftKey;
    if (!undo && !redo) return;
    e.preventDefault(); e.stopPropagation();
    if (busy) return;
    if (undo && canUndo) { clearSelection(); onUndo?.(); } else if (redo && canRedo) { clearSelection(); onRedo?.(); }
  }
  const sliceOk = Number.isFinite(sliceMin) && Number.isFinite(sliceMax) && sliceMin < sliceMax;
  return <div className={`cloud-view tool-${activeTool} ${canEdit ? "" : "is-locked"}`} ref={host} tabIndex={-1} onKeyDown={onKeyDown} aria-label="测量点云三维视图" data-review-candidate={review?.candidate?.id} data-review-points={reviewPoints}>
    {cloud && <>
      <div className="cloud-tools" role="toolbar" aria-label="点云工具">
        {!readOnly && <>
          <div className="cloud-seg">
            <button aria-pressed={tool === "erase"} disabled={!canEdit} title="橡皮擦：左键涂擦，Esc 取消本笔" onClick={() => chooseTool("erase")}>橡皮擦</button>
            <button aria-pressed={tool === "select"} disabled={!!busy} title="框选：拖框选择后确认" onClick={() => chooseTool("select")}>选区</button>
          </div>
          <div className="cloud-seg">
            <button disabled={!canUndo || !!busy} title="撤销 Ctrl+Z" onClick={() => { clearSelection(); onUndo?.(); }}>撤销</button>
            <button disabled={!canRedo || !!busy} title="重做 Ctrl+Y" onClick={() => { clearSelection(); onRedo?.(); }}>重做</button>
          </div>
        </>}
        <select className="cloud-view-select" aria-label="视角" value="" onChange={e => changeView(e.target.value)}>
          <option value="" disabled>视角</option><option value="iso">斜视</option><option value="top">俯视</option><option value="front">正视</option><option value="side">侧视</option>
        </select>
        {review && <><button onClick={() => updateReview.current(review, true)}>关键帧视角</button><span>框内墙带预览点 {reviewPoints.toLocaleString()}</span></>}
        <button aria-expanded={settingsOpen} aria-controls="point-cloud-settings" title="显示与范围设置" onClick={() => setSettingsOpen(v => !v)}>设置</button>
      </div>
      {!readOnly && activeTool !== "none" && <div className="cloud-options" role="group" aria-label={activeTool === "erase" ? "橡皮擦选项" : "选区选项"}>
        {activeTool === "erase" ? <>
          <label className="cloud-opt" title="Alt+滚轮可调整半径">半径<input aria-label="笔刷半径" type="range" min={MIN_RADIUS} max={MAX_RADIUS} step="1" value={radius} onChange={e => setRadius(clampRadius(Number(e.target.value)))}/><output>{radius}px</output></label>
          <div className="cloud-seg" role="group" aria-label="擦除深度">
            <button aria-pressed={depth === "surface"} title="只擦光标下最靠近视线的表面" onClick={() => setDepth("surface")}>表面</button>
            <button aria-pressed={depth === "through"} title="擦除光标范围内所有深度" onClick={() => setDepth("through")}>穿透</button>
          </div>
          {depth === "surface" && <label className="cloud-opt" title="表面向后的擦除深度">深度<input aria-label="表面深度厚度 米" type="range" min="0.01" max="1" step="0.01" value={thickness} onChange={e => setThickness(Math.max(.01, Math.min(1, Number(e.target.value))))}/><output>{thickness.toFixed(2)} m</output></label>}
          <small className="cloud-hint">左键涂擦 · 右键旋转 · 中键平移 · 滚轮缩放</small>
        </> : <>
          <div className="cloud-seg" role="group" aria-label="框选方式">
            <button aria-pressed={selMode === "remove"} onClick={() => { clearSelection(); setSelMode("remove"); }}>剔除框内</button>
            <button aria-pressed={selMode === "keep"} onClick={() => { clearSelection(); setSelMode("keep"); }}>保留框内</button>
          </div>
          {selection
            ? <div className="cloud-selection" role="status"><span>预览 <strong>{selection.count.toLocaleString()}</strong> 点</span>
                <button className={selection.rule.mode === "keep" ? "primary" : "delete-selection"} disabled={!!busy} onClick={applySelection}>{selection.rule.mode === "keep" ? "确认保留" : "删除选中"}</button>
                <button onClick={clearSelection}>取消</button></div>
            : <small className="cloud-hint">拖框选择，范围穿透全部深度 · 右键旋转</small>}
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
    </>}
    {box && <div className="clip-box" style={{ left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1] }}/>}
    {!cloud && <div className="empty-view"><span className="empty-badge">PCD · PLY · LAS · LAZ</span><strong>导入测量成果</strong><span>使用上方工具栏导入实测点云或打开合成示例</span></div>}
  </div>;
}
