import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/** 概览页独立的金属形体；不参与点云数据、导出或工作台渲染。 */
export function SpatialSculpture({ paused }: { paused: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pauseRef = useRef(paused);
  const wakeRef = useRef<(() => void) | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    pauseRef.current = paused;
    wakeRef.current?.();
  }, [paused]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x101113, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 40);
    camera.position.set(0, 0, 8.7);
    const environment = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environmentMap = pmrem.fromScene(environment, 0.04);
    scene.environment = environmentMap.texture;
    environment.dispose();
    pmrem.dispose();

    // 扭转椭圆管的连续曲面：大块反射和收窄的内孔形成雕塑的空间张力。
    const geometry = new THREE.TorusGeometry(1.52, 0.57, 64, 180);
    const positions = geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      const angle = Math.atan2(y, x);
      const wave = 1 + 0.13 * Math.sin(angle * 3);
      positions.setXYZ(i, x * wave * 0.88, y * wave * 1.14, z + 0.48 * Math.sin(angle * 2));
    }
    geometry.computeVertexNormals();
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xc7ced2, metalness: 1, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.16,
    });
    const sculpture = new THREE.Group();
    sculpture.add(new THREE.Mesh(geometry, material));
    sculpture.rotation.set(0.16, -0.42, -0.3);
    scene.add(sculpture);

    // 让一段外轮廓离散成点，与应用的空间采集主题建立直接联系。
    const samples: number[] = [];
    for (let i = 0; i < positions.count; i += 3) {
      if (positions.getX(i) < 0.35) continue;
      samples.push(positions.getX(i) * 1.06, positions.getY(i) * 1.06, positions.getZ(i) * 1.06);
    }
    const pointsGeometry = new THREE.BufferGeometry();
    pointsGeometry.setAttribute("position", new THREE.Float32BufferAttribute(samples, 3));
    const pointsMaterial = new THREE.PointsMaterial({ color: 0xd5bfa6, size: 0.012, transparent: true, opacity: 0.58, depthWrite: false });
    sculpture.add(new THREE.Points(pointsGeometry, pointsMaterial));
    const keyLight = new THREE.DirectionalLight(0xe6efff, 3);
    keyLight.position.set(-3, 5, 4);
    const rimLight = new THREE.DirectionalLight(0xe3bda3, 2);
    rimLight.position.set(4, -2, 2);
    scene.add(keyLight, rimLight);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastTime = 0;
    let phase = 0;
    let lost = false;
    const pointer = new THREE.Vector2();
    const render = (now: number) => {
      frame = 0;
      if (document.hidden || lost) return;
      const moving = !pauseRef.current && !reducedMotion.matches;
      if (now - lastTime >= 32 || !moving) {
        if (moving) {
          phase += Math.min((now - lastTime) / 1000, 0.05);
          sculpture.rotation.y += (-0.42 + Math.sin(phase * 0.23) * 0.3 + pointer.x * 0.22 - sculpture.rotation.y) * 0.055;
          sculpture.rotation.x += (0.16 + pointer.y * 0.16 - sculpture.rotation.x) * 0.055;
          sculpture.position.y = Math.sin(phase * 0.45) * 0.06;
        }
        renderer.render(scene, camera);
        lastTime = now;
      }
      if (moving) frame = requestAnimationFrame(render);
    };
    const wake = () => {
      if (!frame && !document.hidden && !lost) frame = requestAnimationFrame(render);
    };
    wakeRef.current = wake;
    const resize = () => {
      const width = Math.max(host.clientWidth, 1), height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.position.z = camera.aspect < 0.9 ? 10.2 : 8.7;
      camera.updateProjectionMatrix();
      wake();
    };
    const move = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width - 0.5, (event.clientY - rect.top) / rect.height - 0.5);
    };
    const leave = () => pointer.set(0, 0);
    const visibility = () => {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
      else wake();
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      cancelAnimationFrame(frame);
      frame = 0;
      setUnavailable(true);
    };
    const contextRestored = () => { lost = false; setUnavailable(false); wake(); };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    renderer.domElement.addEventListener("webglcontextrestored", contextRestored);
    document.addEventListener("visibilitychange", visibility);
    reducedMotion.addEventListener("change", wake);
    resize();

    return () => {
      wakeRef.current = undefined;
      cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", visibility);
      reducedMotion.removeEventListener("change", wake);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.domElement.removeEventListener("webglcontextrestored", contextRestored);
      geometry.dispose();
      material.dispose();
      pointsGeometry.dispose();
      pointsMaterial.dispose();
      environmentMap.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  return <div className={`spatial-sculpture ${unavailable ? "unavailable" : ""}`} ref={hostRef} role="img" aria-label="银色扭转环形雕塑，边缘逐渐离散为空间采样点">
    {unavailable && <div className="sculpture-fallback"><span>POINT / VIEW</span><p>当前环境无法显示三维雕塑，可直接导入数据或进入工作台。</p></div>}
  </div>;
}
