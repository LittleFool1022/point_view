import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ColorMode, PointCloudData } from "../domain/types";
import { projectedSelection } from "../creation/objects";

export interface CloudFocusRequest {
  token: number;
  center: [number, number, number];
  radius?: number;
  fit?: boolean;
}

interface CloudInspection {
  enabled: boolean;
  highlightedIndices: readonly number[];
  hovering?: boolean;
  onHoverPoint(index?: number): void;
  onPickPoint(index?: number): void;
}

interface Props {
  cloud?: PointCloudData | null;
  colorMode: ColorMode;
  pointSize: number;
  pointBudget?: number;
  lightMode?: boolean;
  selected: Set<number>;
  selectionEnabled: boolean;
  moveEnabled: boolean;
  showReferenceGuides: boolean;
  resetToken: number;
  onTogglePoint(index: number): void;
  onSelectPoints(indices: number[]): void;
  onMoveSelected(delta: [number, number, number]): void;
  onStats(fps: number, visiblePoints: number): void;
  active?: boolean;
  inspection?: CloudInspection;
  focusRequest?: CloudFocusRequest;
  fullSelection?: boolean;
  dimUnselected?: boolean;
  onSelectionBusy?(busy: boolean): void;
}

interface RenderRuntime {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  grid: THREE.GridHelper;
  axes: THREE.AxesHelper;
  visibleOriginalIndices: number[];
  renderedPositions: Float32Array;
  selectionVersion: number;
  selectionAnimation: number;
  interacting: boolean;
  highlightGeometry: THREE.BufferGeometry;
  highlightMaterial: THREE.PointsMaterial;
  wake(frames?: number): void;
  focus(request: Omit<CloudFocusRequest, "token">, animate?: boolean): void;
  cancelFocus(): void;
  pendingCloudUpdate?: () => void;
  scanInteractionCount?: number;
}

function turbo(value: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, value));
  const r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 3)));
  const g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 2)));
  const b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 1)));
  return [r, g, b];
}

export function PointCloudCanvas(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const runtimeRef = useRef<RenderRuntime | undefined>(undefined);
  const inspectionViewRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3; far: number } | undefined>(undefined);
  const viewStateRef = useRef({ position: new THREE.Vector3(10, -13, 8), target: new THREE.Vector3(0, 0, 1.5) });

  // WebGL renderer 和交互对象只创建一次；实时点云更新仅替换 BufferGeometry。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101214);
    // 数据预览不使用距离雾，避免大范围点云取景后融入背景。
    const camera = new THREE.PerspectiveCamera(58, 1, 0.02, 2_000);
    camera.position.copy(viewStateRef.current.position);
    camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.sortObjects = false;
    const getTargetPixelRatio = () => {
      const labDpr = Number(document.documentElement.dataset.omniPixelRatio);
      return labDpr > 0 ? labDpr : Math.min(window.devicePixelRatio || 1, 1.25);
    };
    renderer.setPixelRatio(getTargetPixelRatio());
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(viewStateRef.current.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const grid = new THREE.GridHelper(30, 30, 0x555e65, 0x292f34);
    grid.rotation.x = Math.PI / 2;
    grid.visible = propsRef.current.showReferenceGuides;
    scene.add(grid);
    const axes = new THREE.AxesHelper(1.5);
    axes.visible = propsRef.current.showReferenceGuides;
    scene.add(axes);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(), 3));
    // 大小为 0 时使用固定 1 像素，保留可见性且不随透视放大。
    const material = new THREE.PointsMaterial({ size: propsRef.current.pointSize === 0 ? 1 : propsRef.current.pointSize, vertexColors: true, sizeAttenuation: propsRef.current.pointSize !== 0 });
    const points = new THREE.Points(geometry, material);
    scene.add(points);
    const highlightGeometry = new THREE.BufferGeometry();
    const highlightMaterial = new THREE.PointsMaterial({ color: 0xd5bfa6, size: 0.07, depthTest: true, depthWrite: false });
    const highlights = new THREE.Points(highlightGeometry, highlightMaterial);
    highlights.renderOrder = 1;
    scene.add(highlights);
    let transition: { started: number; fromPosition: THREE.Vector3; fromTarget: THREE.Vector3; position: THREE.Vector3; target: THREE.Vector3 } | undefined;

    const runtime: RenderRuntime = {
      scene, camera, controls, renderer, geometry, material, grid, axes,
      visibleOriginalIndices: [], renderedPositions: new Float32Array(),
      selectionVersion: 0, selectionAnimation: 0, interacting: false,
      highlightGeometry, highlightMaterial,
      wake: () => {},
      cancelFocus: () => { transition = undefined; controls.enableDamping = true; },
      focus: (request, animate = true) => {
        const target = new THREE.Vector3(...request.center);
        const offset = camera.position.clone().sub(controls.target);
        if (request.fit) {
          const angle = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
          offset.setLength(Math.max(0.5, (request.radius ?? 1) * 1.25 / Math.sin(angle)));
        }
        const position = target.clone().add(offset);
        camera.far = Math.max(2000, offset.length() * 20);
        camera.updateProjectionMatrix();
        controls.enableDamping = false;
        if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          camera.position.copy(position); controls.target.copy(target); controls.update(); controls.enableDamping = true; transition = undefined;
        } else transition = { started: performance.now(), fromPosition: camera.position.clone(), fromTarget: controls.target.clone(), position, target };
        host.dataset.focusCenter = request.center.join(",");
        runtime.wake(30);
      },
    };
    runtimeRef.current = runtime;

    const resize = () => {
      const width = host.clientWidth || 1, height = host.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      runtimeRef.current?.wake(2);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let dragStart: { x: number; y: number } | undefined;
    let moveDragStart: { world: THREE.Vector3; plane: THREE.Plane } | undefined;
    let inspectStart: { x: number; y: number } | undefined;
    let lastHover = 0;
    let hoveredIndex: number | undefined;
    const inspectPoint = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      camera.updateMatrixWorld();
      const pixelSize = 2 * camera.position.distanceTo(controls.target) * Math.tan(camera.fov * Math.PI / 360) / Math.max(rect.height, 1);
      raycaster.params.Points = { threshold: Math.max(0.015, pixelSize * 7) };
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(points, false)[0];
      return hit?.index === undefined ? undefined : runtime.visibleOriginalIndices[hit.index];
    };
    const clearHover = () => {
      hoveredIndex = undefined;
      propsRef.current.inspection?.onHoverPoint(undefined);
    };
    const selectionBox = document.createElement("div");
    selectionBox.className = "selection-box";
    host.appendChild(selectionBox);

    const selectInBox = (left: number, right: number, top: number, bottom: number, width: number, height: number) => {
      const version = ++runtime.selectionVersion;
      cancelAnimationFrame(runtime.selectionAnimation);
      camera.updateMatrixWorld();
      const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements.slice();
      const positions = runtime.renderedPositions;
      const originalIndices = runtime.visibleOriginalIndices;
      const hits: number[] = [];
      let cursor = 0;
      const fullCloud = propsRef.current.fullSelection ? propsRef.current.cloud : undefined;
      const total = fullCloud ? fullCloud.visible.length : originalIndices.length;
      propsRef.current.onSelectionBusy?.(true);

      // 每帧最多投影 2.5 万点，框选百万点时也不阻塞鼠标与渲染线程。
      const processChunk = () => {
        if (version !== runtime.selectionVersion) return;
        const end = Math.min(cursor + 25_000, total);
        if (fullCloud) {
          hits.push(...projectedSelection(fullCloud, matrix, [left / width * 2 - 1, right / width * 2 - 1, 1 - bottom / height * 2, 1 - top / height * 2], cursor, end));
          cursor = end;
        }
        for (; cursor < end; cursor++) {
          const offset = cursor * 3;
          const x = positions[offset]!, y = positions[offset + 1]!, z = positions[offset + 2]!;
          const clipX = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
          const clipY = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
          const clipZ = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;
          const clipW = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
          if (clipW <= 0) continue;
          const ndcX = clipX / clipW, ndcY = clipY / clipW, ndcZ = clipZ / clipW;
          const sx = (ndcX + 1) * width / 2;
          const sy = (1 - ndcY) * height / 2;
          if (ndcZ >= -1 && ndcZ <= 1 && sx >= left && sx <= right && sy >= top && sy <= bottom) hits.push(originalIndices[cursor]!);
        }
        if (cursor < total) runtime.selectionAnimation = requestAnimationFrame(processChunk);
        else { propsRef.current.onSelectionBusy?.(false); propsRef.current.onSelectPoints(hits); }
      };
      runtime.selectionAnimation = requestAnimationFrame(processChunk);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (propsRef.current.inspection?.enabled && event.button === 0) {
        inspectStart = { x: event.clientX, y: event.clientY };
        clearHover();
      }
      if (propsRef.current.moveEnabled && propsRef.current.selected.size > 0 && event.button === 0) {
        if (moveDragStart) return;
        const cloud = propsRef.current.cloud;
        if (!cloud || !cloud.positions.length) return;
        const center = new THREE.Vector3();
        let count = 0;
        for (const index of propsRef.current.selected) {
          const offset = index * 3;
          if (!Number.isFinite(cloud.positions[offset]) || !Number.isFinite(cloud.positions[offset + 1]) || !Number.isFinite(cloud.positions[offset + 2])) continue;
          center.x += cloud.positions[offset]!;
          center.y += cloud.positions[offset + 1]!;
          center.z += cloud.positions[offset + 2]!;
          count++;
        }
        if (count > 0) {
          center.multiplyScalar(1 / count);
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), center);
          const world = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
          if (world) {
            moveDragStart = { world, plane };
            host.dataset.moveDrag = "started";
            controls.enabled = false;
          }
        }
        return;
      }
      if (!propsRef.current.selectionEnabled || event.button !== 0) return;
      renderer.domElement.setPointerCapture(event.pointerId);
      dragStart = { x: event.offsetX, y: event.offsetY };
      controls.enabled = false;
      selectionBox.style.display = "block";
      selectionBox.style.left = `${event.offsetX}px`;
      selectionBox.style.top = `${event.offsetY}px`;
      selectionBox.style.width = "0";
      selectionBox.style.height = "0";
    };
    const onPointerMove = (event: PointerEvent) => {
      if (propsRef.current.inspection?.enabled && !event.buttons && performance.now() - lastHover > 80) {
        lastHover = performance.now();
        const index = inspectPoint(event);
        if (index !== hoveredIndex) { hoveredIndex = index; propsRef.current.inspection.onHoverPoint(index); }
      }
      if (moveDragStart) return;
      if (!dragStart) return;
      const x = Math.min(dragStart.x, event.offsetX), y = Math.min(dragStart.y, event.offsetY);
      selectionBox.style.left = `${x}px`;
      selectionBox.style.top = `${y}px`;
      selectionBox.style.width = `${Math.abs(event.offsetX - dragStart.x)}px`;
      selectionBox.style.height = `${Math.abs(event.offsetY - dragStart.y)}px`;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (inspectStart) {
        const click = Math.hypot(event.clientX - inspectStart.x, event.clientY - inspectStart.y) <= 5;
        inspectStart = undefined;
        if (click && propsRef.current.inspection?.enabled) propsRef.current.inspection.onPickPoint(inspectPoint(event));
      }
      if (moveDragStart) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const world = raycaster.ray.intersectPlane(moveDragStart.plane, new THREE.Vector3());
        if (world) {
          const delta = world.sub(moveDragStart.world);
          if (delta.lengthSq() > 0.000001) {
            propsRef.current.onMoveSelected([delta.x, delta.y, delta.z]);
            host.dataset.moveDrag = "applied";
          } else {
            host.dataset.moveDrag = "unchanged";
          }
        }
        moveDragStart = undefined;
        controls.enabled = !propsRef.current.selectionEnabled && !propsRef.current.moveEnabled;
        return;
      }
      if (!dragStart) return;
      const start = dragStart;
      dragStart = undefined;
      controls.enabled = !propsRef.current.selectionEnabled && !propsRef.current.moveEnabled;
      selectionBox.style.display = "none";
      const rect = renderer.domElement.getBoundingClientRect();
      const dragDistance = Math.hypot(event.offsetX - start.x, event.offsetY - start.y);
      if (dragDistance > 7) {
        selectInBox(
          Math.min(start.x, event.offsetX), Math.max(start.x, event.offsetX),
          Math.min(start.y, event.offsetY), Math.max(start.y, event.offsetY),
          rect.width, rect.height,
        );
        return;
      }
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.params.Points = { threshold: Math.max(propsRef.current.pointSize * 2.5, 0.08) };
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(points, false)[0];
      if (hit?.index !== undefined) propsRef.current.onTogglePoint(runtime.visibleOriginalIndices[hit.index]!);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown, true);
    renderer.domElement.addEventListener("pointermove", onPointerMove, true);
    renderer.domElement.addEventListener("pointerup", onPointerUp, true);
    const cancelInspection = () => {
      inspectStart = undefined; dragStart = undefined; moveDragStart = undefined; clearHover();
      selectionBox.style.display = "none";
      runtime.selectionVersion++; cancelAnimationFrame(runtime.selectionAnimation);
      propsRef.current.onSelectionBusy?.(false);
      controls.enabled = !propsRef.current.selectionEnabled && !propsRef.current.moveEnabled;
    };
    renderer.domElement.addEventListener("pointerleave", clearHover);
    renderer.domElement.addEventListener("pointercancel", cancelInspection);
    // 参考系/点云画布可能被上层玻璃面板改变事件路径，移动模式在 host 捕获阶段兜底。
    const onHostPointerDown = (event: PointerEvent) => { if (propsRef.current.moveEnabled) onPointerDown(event); };
    const onHostPointerMove = (event: PointerEvent) => { if (moveDragStart) onPointerMove(event); };
    const onHostPointerUp = (event: PointerEvent) => { if (moveDragStart) onPointerUp(event); };
    host.addEventListener("pointerdown", onHostPointerDown, true);
    host.addEventListener("pointermove", onHostPointerMove, true);
    host.addEventListener("pointerup", onHostPointerUp, true);

    let qualityTimer = 0;
    const onInteractionStart = () => {
      runtime.cancelFocus();
      runtime.interacting = true;
      window.clearTimeout(qualityTimer);
      geometry.setDrawRange(0, Math.min(runtime.visibleOriginalIndices.length, runtime.scanInteractionCount ?? 100_000));
      const interactionDpr = Math.min(getTargetPixelRatio(), runtime.scanInteractionCount === undefined ? 0.75 : 0.5);
      if (renderer.getPixelRatio() !== interactionDpr) { renderer.setPixelRatio(interactionDpr); resize(); }
      runtime.wake(10);
    };
    const onInteractionEnd = () => {
      qualityTimer = window.setTimeout(() => {
        runtime.interacting = false;
        const pending = runtime.pendingCloudUpdate;
        runtime.pendingCloudUpdate = undefined;
        pending?.();
        geometry.setDrawRange(0, runtime.visibleOriginalIndices.length);
        const targetDpr = getTargetPixelRatio();
        if (renderer.getPixelRatio() !== targetDpr) { renderer.setPixelRatio(targetDpr); resize(); }
        runtime.wake(5);
      }, 100);
    };
    const onControlsChange = () => { runtime.wake(2); };
    controls.addEventListener("start", onInteractionStart);
    controls.addEventListener("end", onInteractionEnd);
    controls.addEventListener("change", onControlsChange);

    const onBudget = () => {
      const dpr = getTargetPixelRatio();
      if (renderer.getPixelRatio() !== dpr) {
        renderer.setPixelRatio(dpr);
        resize();
        runtime.wake(2);
      }
    };
    window.addEventListener("omni:render-budget", onBudget);

    let animation = 0, frames = 0, lastReport = performance.now();
    let framesToRender = 0;
    const render = (now: number) => {
      animation = 0;
      if (propsRef.current.active === false || document.hidden) return;
      let needNextFrame = false;
      if (transition) {
        const t = Math.min(1, (now - transition.started) / 320);
        const eased = 1 - (1 - t) ** 3;
        camera.position.lerpVectors(transition.fromPosition, transition.position, eased);
        controls.target.lerpVectors(transition.fromTarget, transition.target, eased);
        if (t === 1) runtime.cancelFocus();
        else needNextFrame = true;
      }
      const controlsChanged = controls.update();
      if (controlsChanged || runtime.interacting) {
        needNextFrame = true;
        framesToRender = Math.max(framesToRender, 10);
      }
      renderer.render(scene, camera);
      frames++;
      if (now - lastReport >= 1_000) {
        propsRef.current.onStats(Math.round((frames * 1_000) / (now - lastReport)), runtime.visibleOriginalIndices.length);
        frames = 0;
        lastReport = now;
      }
      if (framesToRender > 0) {
        framesToRender--;
        needNextFrame = true;
      }
      if (needNextFrame) {
        animation = requestAnimationFrame(render);
      }
    };
    runtime.wake = (count = 1) => {
      framesToRender = Math.max(framesToRender, count);
      if (!animation && propsRef.current.active !== false && !document.hidden) animation = requestAnimationFrame(render);
    };
    const visibilityChanged = () => {
      if (document.hidden) { cancelAnimationFrame(animation); animation = 0; }
      else runtime.wake(2);
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    runtime.wake(2);

    return () => {
      viewStateRef.current.position.copy(camera.position);
      viewStateRef.current.target.copy(controls.target);
      cancelAnimationFrame(animation);
      cancelAnimationFrame(runtime.selectionAnimation);
      runtime.selectionVersion++;
      window.clearTimeout(qualityTimer);
      observer.disconnect();
      window.removeEventListener("omni:render-budget", onBudget);
      controls.removeEventListener("start", onInteractionStart);
      controls.removeEventListener("end", onInteractionEnd);
      controls.removeEventListener("change", onControlsChange);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown, true);
      renderer.domElement.removeEventListener("pointermove", onPointerMove, true);
      renderer.domElement.removeEventListener("pointerup", onPointerUp, true);
      renderer.domElement.removeEventListener("pointerleave", clearHover);
      renderer.domElement.removeEventListener("pointercancel", cancelInspection);
      document.removeEventListener("visibilitychange", visibilityChanged);
      host.removeEventListener("pointerdown", onHostPointerDown, true);
      host.removeEventListener("pointermove", onHostPointerMove, true);
      host.removeEventListener("pointerup", onHostPointerUp, true);
      selectionBox.remove();
      controls.dispose();
      geometry.dispose();
      material.dispose();
      highlightGeometry.dispose();
      highlightMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = undefined;
    };
  }, []);

  // 实时帧只更新 GPU buffer，不再销毁 canvas、controls 和 WebGL context。
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const updateCloud = () => {
    const { cloud, colorMode, pointSize, selected } = props;
    runtime.scanInteractionCount = cloud?.scanPreview?.interactionCount;
    if (!cloud || !cloud.positions.length) {
      runtime.geometry.setDrawRange(0, 0);
      runtime.visibleOriginalIndices = [];
      runtime.renderedPositions = new Float32Array();
      runtime.geometry.setAttribute("position", new THREE.BufferAttribute(runtime.renderedPositions, 3));
      runtime.geometry.setAttribute("color", new THREE.BufferAttribute(runtime.renderedPositions, 3));
      runtime.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
      runtime.wake(2);
      if (hostRef.current) hostRef.current.dataset.scanPoints = "0";
      return;
    }
    if (cloud.scanPreview && colorMode === "rgb" && !selected.size && !props.inspection) {
      // 扫描 Worker 已完成预算、历史着色与 bounds；主线程只拷贝有界有效前缀。
      const capacity = 100_000 * 3;
      let positions = runtime.geometry.getAttribute("position") as THREE.BufferAttribute;
      let colors = runtime.geometry.getAttribute("color") as THREE.BufferAttribute;
      if (!(colors.array instanceof Uint8Array) || positions.array.length !== capacity) {
        positions = new THREE.BufferAttribute(new Float32Array(capacity), 3).setUsage(THREE.DynamicDrawUsage);
        colors = new THREE.BufferAttribute(new Uint8Array(capacity), 3, true).setUsage(THREE.DynamicDrawUsage);
        runtime.geometry.setAttribute("position", positions);
        runtime.geometry.setAttribute("color", colors);
      }
      positions.array.set(cloud.positions);
      colors.array.set(cloud.scanPreview.displayColors);
      for (const attribute of [positions, colors]) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, cloud.positions.length);
        attribute.needsUpdate = true;
      }
      const count = cloud.positions.length / 3;
      const indices = runtime.visibleOriginalIndices;
      for (let i = indices.length; i < count; i++) indices[i] = i;
      indices.length = count;
      runtime.renderedPositions = cloud.positions;
      runtime.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...cloud.scanPreview.center), cloud.scanPreview.radius);
      runtime.geometry.setDrawRange(0, count);
      runtime.material.size = pointSize === 0 ? 1 : pointSize;
      runtime.material.sizeAttenuation = pointSize !== 0;
      if (hostRef.current) {
        hostRef.current.dataset.scanPoints = `${count}`;
        hostRef.current.dataset.scanToken = cloud.scanPreview.token;
        hostRef.current.dataset.scanCenter = cloud.scanPreview.center.join(",");
        hostRef.current.dataset.scanRadius = `${cloud.scanPreview.radius}`;
      }
      runtime.wake(2);
      return;
    }
    let visibleCount = 0;
    for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i]) visibleCount++;
    const budget = props.pointBudget ?? (props.inspection ? 120_000 : window.matchMedia("(max-width: 700px)").matches ? 250_000 : 600_000);
    const stride = Math.max(1, Math.ceil(visibleCount / budget));
    const originalIndices: number[] = [];
    let visibleOffset = 0;
    for (let i = 0; i < cloud.visible.length; i++) {
      if (!cloud.visible[i]) continue;
      if (visibleOffset % stride === 0) originalIndices.push(i);
      visibleOffset++;
    }
    const positions = new Float32Array(originalIndices.length * 3);
    const colors = new Float32Array(originalIndices.length * 3);
    let minZ = Infinity, maxZ = -Infinity, maxDistance = 0;
    for (const original of originalIndices) {
      const offset = original * 3;
      minZ = Math.min(minZ, cloud.positions[offset + 2]!);
      maxZ = Math.max(maxZ, cloud.positions[offset + 2]!);
      maxDistance = Math.max(maxDistance, Math.hypot(cloud.positions[offset]!, cloud.positions[offset + 1]!, cloud.positions[offset + 2]!));
    }
    originalIndices.forEach((original, rendered) => {
      const source = original * 3, target = rendered * 3;
      positions[target] = cloud.positions[source]!;
      positions[target + 1] = cloud.positions[source + 1]!;
      positions[target + 2] = cloud.positions[source + 2]!;
      let color: [number, number, number];
      if (selected.has(original)) color = [0.95, 0.48, 0.17];
      else if (colorMode === "rgb") color = [cloud.colors[source]! / 255, cloud.colors[source + 1]! / 255, cloud.colors[source + 2]! / 255];
      else if (colorMode === "height") color = turbo((cloud.positions[source + 2]! - minZ) / Math.max(maxZ - minZ, 0.001));
      else if (colorMode === "distance") color = turbo(Math.hypot(cloud.positions[source]!, cloud.positions[source + 1]!, cloud.positions[source + 2]!) / Math.max(maxDistance, 0.001));
      else if (colorMode === "intensity") color = turbo(cloud.intensities?.[original] ?? 0.5);
      else color = [0.15, 0.85, 1];
      if (props.dimUnselected && selected.size && !selected.has(original)) color = color.map(value => value * 0.2) as [number, number, number];
      colors.set(color, target);
    });

    runtime.selectionVersion++;
    cancelAnimationFrame(runtime.selectionAnimation);
    propsRef.current.onSelectionBusy?.(false);
    runtime.visibleOriginalIndices = originalIndices;
    runtime.renderedPositions = positions;
    runtime.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    runtime.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    if (positions.length) runtime.geometry.computeBoundingSphere();
    else runtime.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    runtime.geometry.setDrawRange(0, runtime.interacting ? Math.min(originalIndices.length, 100_000) : originalIndices.length);
    runtime.material.size = pointSize === 0 ? 1 : pointSize;
    runtime.material.sizeAttenuation = pointSize !== 0;
    runtime.material.needsUpdate = true;
    runtime.wake(2);
    };
    // 拖动期间仅保留最新快照，避免点云上传与手势渲染争抢主线程。
    if (props.cloud?.scanPreview && runtime.interacting) runtime.pendingCloudUpdate = updateCloud;
    else {
      runtime.pendingCloudUpdate = undefined;
      updateCloud();
    }
  }, [props.cloud, props.colorMode, props.pointSize, props.pointBudget, props.selected, props.dimUnselected, Boolean(props.inspection)]);

  // 同一画布进入图纸模式时保存视角，退出后回到用户原来的观察位置。
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (props.inspection) {
      inspectionViewRef.current = { position: runtime.camera.position.clone(), target: runtime.controls.target.clone(), far: runtime.camera.far };
    } else if (inspectionViewRef.current) {
      const saved = inspectionViewRef.current;
      runtime.cancelFocus();
      runtime.controls.enableDamping = false;
      runtime.controls.update();
      runtime.camera.position.copy(saved.position);
      runtime.controls.target.copy(saved.target);
      runtime.camera.far = saved.far;
      runtime.camera.updateProjectionMatrix();
      runtime.controls.update();
      runtime.controls.enableDamping = true;
      inspectionViewRef.current = undefined;
      runtime.wake();
    }
  }, [Boolean(props.inspection)]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const values: number[] = [];
    if (props.cloud && props.cloud.visible) {
      for (const index of props.inspection?.highlightedIndices ?? []) {
        const offset = index * 3;
        if (!props.cloud.visible[index]) continue;
        const point = [props.cloud.positions[offset], props.cloud.positions[offset + 1], props.cloud.positions[offset + 2]];
        if (point.every(value => Number.isFinite(value))) values.push(...point as number[]);
      }
    }
    runtime.highlightGeometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    runtime.highlightGeometry.computeBoundingSphere();
    runtime.highlightMaterial.color.set(props.lightMode ? (props.inspection?.hovering ? 0x155a74 : 0x995617) : (props.inspection?.hovering ? 0xffffff : 0xe2b97f));
    runtime.highlightMaterial.size = Math.max(props.pointSize * 1.8, 0.06);
    runtime.wake(2);
  }, [props.cloud, props.inspection?.highlightedIndices, props.inspection?.hovering, props.pointSize, props.lightMode]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const background = props.lightMode ? 0xffffff : 0x101214;
    runtime.scene.background = new THREE.Color(background);
    // 只更新显示材质，切换主题不重建点云或重置相机。
    const colors = runtime.grid.geometry.getAttribute("color");
    const major = new THREE.Color(props.lightMode ? 0x88939a : 0x555e65);
    const minor = new THREE.Color(props.lightMode ? 0xd8dde0 : 0x292f34);
    for (let i = 0; i < colors.count; i++) {
      const color = Math.floor(i / 4) === 15 ? major : minor;
      colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
    runtime.wake(2);
  }, [props.lightMode]);

  useEffect(() => { runtimeRef.current?.wake(2); }, [props.active]);
  useEffect(() => {
    if (props.focusRequest) runtimeRef.current?.focus(props.focusRequest);
    else runtimeRef.current?.cancelFocus();
  }, [props.focusRequest]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.controls.enabled = !props.selectionEnabled && !props.moveEnabled;
    runtime.renderer.domElement.style.cursor = props.selectionEnabled ? "crosshair" : props.moveEnabled ? "move" : "grab";
  }, [props.selectionEnabled, props.moveEnabled]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.grid.visible = props.showReferenceGuides;
    runtime.axes.visible = props.showReferenceGuides;
    runtime.wake(2);
  }, [props.showReferenceGuides]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // 显式取景由 focusRequest effect 处理，避免“主体/全部点”被默认相机覆盖。
    if (props.focusRequest) return;
    if (props.inspection && runtime.geometry.boundingSphere) {
      const sphere = runtime.geometry.boundingSphere;
      runtime.focus({ center: sphere.center.toArray(), radius: sphere.radius, fit: true });
      return;
    }
    runtime.camera.position.set(10, -13, 8);
    runtime.controls.target.set(0, 0, 1.5);
    viewStateRef.current.position.copy(runtime.camera.position);
    viewStateRef.current.target.copy(runtime.controls.target);
    runtime.controls.update();
    runtime.wake(2);
  }, [props.resetToken]);

  return <div className="point-cloud-canvas" data-highlight-count={props.inspection?.highlightedIndices.length ?? 0} data-reference-guides={props.showReferenceGuides ? "visible" : "hidden"} data-move-mode={props.moveEnabled ? "active" : "inactive"} ref={hostRef} />;
}
