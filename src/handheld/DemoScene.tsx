import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

interface Props {
  mode?: "points" | "solid";
  top?: boolean;
  optical?: boolean;
  opticalSeconds?: number;
  lens?: "front" | "left" | "right" | "panorama";
  heightColor?: boolean;
  pointSize?: number;
  progress?: number;
  reset?: number;
  slice?: { height: number; thickness: number };
  picking?: boolean;
  onPick?(point: [number, number, number]): void;
}

/** 参数化搭建的示例工作室；所有点和材质均在本机生成。 */
export function DemoScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [failed, setFailed] = useState(false);
  const runtime = useRef<{ points: THREE.Points; solid: THREE.Group; material: THREE.PointsMaterial; camera: THREE.PerspectiveCamera; controls: OrbitControls; geometry: THREE.BufferGeometry; rgb: Float32Array; elevation: Float32Array; count: number; renderer: THREE.WebGLRenderer; markers: THREE.Group; grid: THREE.GridHelper; enclosure: THREE.Group; wake(): void } | undefined>(undefined);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setFailed(true); return; }
    const applyPixelRatio = () => renderer.setPixelRatio(Math.min(Number(document.documentElement.dataset.omniPixelRatio) || Math.min(window.devicePixelRatio, 1.6), 2));
    applyPixelRatio();
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0xe8eeec, 0);
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(13, 12, 15);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.6, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 5;
    controls.maxDistance = 33;
    controls.maxPolarAngle = Math.PI / 2.03;
    controls.enablePan = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8eaba4, 2.5));
    const sun = new THREE.DirectionalLight(0xfff4df, 3);
    sun.position.set(5, 12, 6); scene.add(sun);
    const solid = new THREE.Group(); scene.add(solid);
    // 轴测模型开放的侧面在相机视图中补齐，避免环视露出背景空洞。
    const enclosure = new THREE.Group(); scene.add(enclosure);
    for (const [x, y, z, w, h, d, color] of [
      [5, 1.5, 0, 0.12, 3, 6, 0xd7d4c7],
      [0, 1.5, 3, 10, 3, 0.12, 0xd7d4c7],
      [0, 3.05, 0, 10, 0.12, 6, 0xe5e7e2],
    ]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({color, roughness: 1}));
      wall.position.set(x, y, z); enclosure.add(wall);
    }
    const positions: number[] = [], colors: number[] = [], elevation: number[] = [];
    let seed = 98;
    const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
    function box(x: number, y: number, z: number, w: number, h: number, d: number, color: number, density = 120) {
      const geometry = new THREE.BoxGeometry(w, h, d);
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z); solid.add(mesh);
      const base = new THREE.Color(color);
      const count = Math.ceil(2 * (w * h + h * d + d * w) * density);
      for (let i = 0; i < count; i++) {
        let px = random() - 0.5, py = random() - 0.5, pz = random() - 0.5;
        const face = Math.floor(random() * 3);
        const sign = random() > 0.5 ? 0.5 : -0.5;
        if (face === 0) px = sign; else if (face === 1) py = sign; else pz = sign;
        const vy = y + py * h;
        positions.push(x + px * w, vy, z + pz * d);
        const shade = 0.64 + random() * 0.34;
        colors.push(base.r * shade, base.g * shade, base.b * shade);
        const c = new THREE.Color().setHSL(0.44 - Math.min(1, vy / 3) * 0.32, 0.42, 0.4 + random() * 0.14);
        elevation.push(c.r, c.g, c.b);
      }
    }
    box(0, -0.1, 0, 10, 0.16, 6, 0xc9d3cb, 130);
    box(0, 1.5, -3, 10, 3, 0.12, 0xd7d4c7);
    box(-5, 1.5, 0, 0.12, 3, 6, 0xc0c9bf);
    box(1, 1.3, -1.9, 0.13, 2.6, 2.2, 0xb6c7bd);
    box(1, 0.55, 1.8, 0.13, 1.1, 2.4, 0xb6c7bd);
    // 靠墙书架与木质层板。
    for (let i = 0; i < 4; i++) {
      box(-3.5, 0.35 + i * 0.66, -2.64, 2.4, 0.09, 0.6, 0xb39571);
      for (let j = 0; j < 5; j++) box(-4.3 + j * 0.38, 0.58 + i * 0.66, -2.65, 0.2, 0.38, 0.35, [0x607d73, 0xb3a791, 0x889e9a, 0xd6cbb7][j % 4], 75);
    }
    // 会议桌、桌腿、椅子与休闲沙发。
    box(-1.7, 0.8, 0.3, 3.1, 0.14, 1.35, 0xc1a37e, 200);
    for (const x of [-2.8, -0.6]) for (const z of [-0.12, 0.72]) box(x, 0.38, z, 0.07, 0.76, 0.07, 0x567269);
    for (const x of [-2.65, -1.6, -0.55]) for (const z of [-0.85, 1.48]) {
      box(x, 0.46, z, 0.62, 0.12, 0.6, 0x678b7d);
      box(x, 0.85, z + (z < 0 ? -0.25 : 0.25), 0.62, 0.65, 0.09, 0x678b7d);
      for (const dx of [-0.22, 0.22]) box(x + dx, 0.21, z, 0.04, 0.42, 0.44, 0x61786e, 80);
    }
    box(3.3, 0.4, -1.9, 2.8, 0.65, 1.05, 0xc9bca4, 210);
    box(3.3, 0.88, -2.3, 2.8, 0.6, 0.24, 0xcec5b3);
    box(3.1, 0.34, 0, 1.7, 0.1, 0.8, 0x9c8569);
    box(3.1, 0.15, 0, 0.12, 0.3, 0.5, 0x899487);
    box(3.8, 0.34, 2.2, 0.55, 0.65, 0.55, 0xb9a185);
    for (let i = 0; i < 13; i++) box(3.8 + (random() - 0.5) * 0.75, 0.8 + random() * 1.1, 2.2 + (random() - 0.5) * 0.75, 0.32, 0.12, 0.45, 0x62866b, 100);
    for (let i = 0; i < 3; i++) box(2 + i, 1.9, -2.89, 0.7, 0.82, 0.03, [0xa4b6a2, 0xc9aa7b, 0x6f9287][i]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const rgb = new Float32Array(colors), heights = new Float32Array(elevation);
    geometry.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
    const material = new THREE.PointsMaterial({ size: 0.035, vertexColors: true, sizeAttenuation: true });
    const points = new THREE.Points(geometry, material); scene.add(points);
    const grid = new THREE.GridHelper(20, 40, 0x475569, 0x334155);
    grid.position.y = -0.21; scene.add(grid);
    const markers = new THREE.Group(); scene.add(markers);
    // 全景将同一相机位置的六面采样投影为 360° 等距柱状图。
    const cubeTarget = new THREE.WebGLCubeRenderTarget(256);
    const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeTarget);
    const panoramaScene = new THREE.Scene();
    const panoramaMaterial = new THREE.ShaderMaterial({
      uniforms: { panorama: { value: cubeTarget.texture } },
      vertexShader: `varying vec2 uvScreen; void main(){uvScreen=uv;gl_Position=vec4(position.xy,0.,1.);}`,
      fragmentShader: `uniform samplerCube panorama; varying vec2 uvScreen;
        void main(){float lon=(uvScreen.x-.5)*6.2831853;float lat=(uvScreen.y-.5)*3.14159265;
        vec3 direction=vec3(sin(lon)*cos(lat),sin(lat),-cos(lon)*cos(lat));
        gl_FragColor=textureCube(panorama,direction);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
    });
    const panoramaGeometry = new THREE.PlaneGeometry(2, 2);
    panoramaScene.add(new THREE.Mesh(panoramaGeometry, panoramaMaterial));
    const panoramaCamera = new THREE.Camera();
    let frame = 0, ticks = 0, disposed = false;
    function draw() {
      if (disposed) return;
      if (controls.enabled) controls.update();
      if (latest.current.optical && latest.current.lens === "panorama") {
        cubeCamera.position.copy(camera.position); cubeCamera.update(renderer, scene);
        renderer.render(panoramaScene, panoramaCamera);
      } else renderer.render(scene, camera);
      if (++ticks < 80) frame = requestAnimationFrame(draw); else frame = 0;
    }
    const wake = () => { ticks = 0; if (!frame) frame = requestAnimationFrame(draw); };
    controls.addEventListener("change", wake);
    const resize = () => {
      const width = container.clientWidth, height = container.clientHeight;
      renderer.setSize(width, height, false); camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix(); wake();
    };
    const observer = new ResizeObserver(resize); observer.observe(container); resize();
    const onBudget = () => { applyPixelRatio(); resize(); };
    window.addEventListener("omni:render-budget", onBudget);
    let down = { x: 0, y: 0 };
    const pointerDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const pointerUp = (e: PointerEvent) => {
      if (!latest.current.picking || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
      const point = new THREE.Vector3();
      if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point) || Math.abs(point.x) > 5 || Math.abs(point.z) > 3) return;
      latest.current.onPick?.([point.x, 0, point.z]);
      if (markers.children.length >= 2) { for (const object of [...markers.children]) { markers.remove(object); (object as THREE.Mesh).geometry.dispose(); ((object as THREE.Mesh).material as THREE.Material).dispose(); } }
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 12), new THREE.MeshBasicMaterial({ color: 0x0f766e, depthTest: false }));
      dot.position.copy(point); dot.position.y = 0.08; markers.add(dot); wake();
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    runtime.current = { points, solid, material, camera, controls, geometry, rgb, elevation: heights, count: positions.length / 3, renderer, markers, grid, enclosure, wake };
    wake();
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      window.removeEventListener("omni:render-budget", onBudget);
      renderer.domElement.removeEventListener("pointerdown", pointerDown); renderer.domElement.removeEventListener("pointerup", pointerUp);
      scene.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          for (const m of Array.isArray(object.material) ? object.material : [object.material]) m.dispose();
        }
      });
      cubeTarget.dispose(); panoramaMaterial.dispose(); panoramaGeometry.dispose();
      renderer.dispose(); renderer.domElement.remove(); runtime.current = undefined;
    };
  }, []);

  useEffect(() => {
    const r = runtime.current; if (!r) return;
    r.points.visible = !props.optical && props.mode !== "solid"; r.solid.visible = !!props.optical || props.mode === "solid";
    r.grid.visible = !props.optical; r.enclosure.visible = !!props.optical;
    r.material.size = props.pointSize ?? 0.035;
    r.geometry.setAttribute("color", new THREE.BufferAttribute(props.heightColor ? r.elevation : r.rgb, 3));
    r.geometry.setDrawRange(0, Math.max(1, Math.floor(r.count * (props.progress ?? 1))));
    r.renderer.clippingPlanes = props.slice ? [
      new THREE.Plane(new THREE.Vector3(0, -1, 0), props.slice.height + props.slice.thickness / 2),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -props.slice.height + props.slice.thickness / 2),
    ] : [];
    r.wake();
  }, [props.mode, props.heightColor, props.pointSize, props.progress, props.slice, props.optical]);

  useEffect(() => {
    const r = runtime.current; if (!r) return;
    // 可见光演示采用人眼高度的固定相机，与俯瞰的实体预览区分。
    // 用采集进度驱动轻微运动，暂停或断线时沿用冻结的进度。
    if (props.optical) {
      const elapsed = props.opticalSeconds ?? 0;
      r.controls.enabled = false;
      r.camera.fov = 72;
      r.camera.position.set(0.2 + Math.sin(elapsed / 12) * 0.35, 1.65, 2.6);

      r.camera.updateProjectionMatrix(); r.wake(); return;
    }
    r.controls.enabled = true; r.camera.fov = 36; r.camera.updateProjectionMatrix();
    r.camera.position.set(props.top ? 0.01 : 13, props.top ? 22 : 12, props.top ? 0.01 : 15);
    r.controls.target.set(0, 0.6, 0); r.controls.update(); r.wake();
  }, [props.top, props.reset, props.optical]);

  useEffect(() => {
    const r = runtime.current; if (!r || !props.optical) return;
    const elapsed = props.opticalSeconds ?? 0;
    r.camera.position.set(0.2 + Math.sin(elapsed / 12) * 0.35, 1.65, 2.6);
    const yaw = -0.35 + (props.lens === "left" ? -Math.PI / 2.4 : props.lens === "right" ? Math.PI / 2.4 : 0);
    r.camera.lookAt(r.camera.position.x + Math.sin(yaw) * 5, 1.25, r.camera.position.z - Math.cos(yaw) * 5); r.wake();
  }, [props.optical, props.opticalSeconds, props.lens]);

  useEffect(() => {
    const r = runtime.current;
    if (!r || props.picking) return;
    for (const object of [...r.markers.children]) { r.markers.remove(object); (object as THREE.Mesh).geometry.dispose(); ((object as THREE.Mesh).material as THREE.Material).dispose(); }
    r.wake();
  }, [props.picking]);

  return <div className={`demo-scene ${props.picking ? "is-picking" : ""}`} ref={host} aria-label={props.optical ? "模拟可见光相机画面" : "程序生成的工作室三维示例，可拖动旋转、双指缩放"}>{failed && <div className="scene-fallback"><strong>当前浏览器无法显示三维场景</strong><span>请开启硬件加速后重新打开，其他演示流程仍可使用。</span></div>}</div>;
}
