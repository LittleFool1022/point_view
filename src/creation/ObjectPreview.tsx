import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { ObjectAsset } from "./types";
import { linearColors, surfaceGeometry, surfaceMaterial } from "./materials";

export function ObjectPreview({ asset, original, resetToken, onThumbnail, lightMode = false }: { asset: ObjectAsset; original: boolean; resetToken: number; onThumbnail(data: string): void; lightMode?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onThumbnail); callbackRef.current = onThumbnail;
  const runtime = useRef<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; renderer: THREE.WebGLRenderer; object?: THREE.Mesh | THREE.Points; wake(): void; fit(): void } | undefined>(undefined);
  useEffect(() => {
    const host = hostRef.current!;
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#161a1b");
    const camera = new THREE.PerspectiveCamera(38, 1, 0.001, 10000); camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);
    const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04); scene.environment = env.texture; room.dispose(); pmrem.dispose();
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = 0.1;
    let frame = 0, frames = 0;
    const draw = () => { controls.update(); renderer.render(scene, camera); if (--frames > 0) frame = requestAnimationFrame(draw); else frame = 0; };
    const wake = () => { frames = 30; if (!frame) frame = requestAnimationFrame(draw); };
    const fit = () => {
      if (!runtime.current?.object) return;
      const box = new THREE.Box3().setFromObject(runtime.current.object), sphere = box.getBoundingSphere(new THREE.Sphere());
      const angle = Math.min(38 * Math.PI / 360, Math.atan(Math.tan(38 * Math.PI / 360) * camera.aspect));
      const distance = Math.max(sphere.radius, 0.01) / Math.sin(angle) * 1.2;
      camera.position.copy(sphere.center).add(new THREE.Vector3(1, -1.6, 0.8).normalize().multiplyScalar(distance));
      camera.near = Math.max(distance / 10000, 0.00001); camera.far = Math.max(distance * 100, 10); camera.updateProjectionMatrix();
      controls.target.copy(sphere.center); controls.update(); wake();
    };
    runtime.current = { scene, camera, controls, renderer, wake, fit };
    const resize = () => { renderer.setSize(host.clientWidth || 1, host.clientHeight || 1, false); camera.aspect = (host.clientWidth || 1) / (host.clientHeight || 1); camera.updateProjectionMatrix(); if (runtime.current?.object) fit(); else wake(); };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    controls.addEventListener("change", wake);
    return () => { observer.disconnect(); controls.dispose(); cancelAnimationFrame(frame); env.dispose(); renderer.dispose(); renderer.domElement.remove(); runtime.current = undefined; };
  }, []);
  useEffect(() => {
    const r = runtime.current; if (!r) return;
    let object: THREE.Mesh | THREE.Points;
    if (asset.mesh && !original) object = new THREE.Mesh(surfaceGeometry(asset.mesh, asset.material === "original"), surfaceMaterial(asset.material));
    else {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(asset.cloud.positions, 3));
      if (asset.cloud.attributes?.hasColor) geometry.setAttribute("color", new THREE.BufferAttribute(linearColors(asset.cloud.colors), 3));
      geometry.computeBoundingSphere();
      object = new THREE.Points(geometry, new THREE.PointsMaterial({ color: asset.cloud.attributes?.hasColor ? "#ffffff" : "#d8dcd7", size: 1, sizeAttenuation: false, vertexColors: Boolean(asset.cloud.attributes?.hasColor), toneMapped: false }));
    }
    r.scene.add(object); r.object = object; r.wake();
    const timer = setTimeout(() => {
      r.renderer.render(r.scene, r.camera);
      const thumb = document.createElement("canvas"); thumb.width = 320; thumb.height = 240;
      thumb.getContext("2d")?.drawImage(r.renderer.domElement, 0, 0, 320, 240);
      callbackRef.current(thumb.toDataURL("image/jpeg", 0.8));
    }, 300);
    return () => { clearTimeout(timer); r.scene.remove(object); object.geometry.dispose(); (object.material as THREE.Material).dispose(); };
  }, [asset.id, asset.mesh, asset.material, original]);
  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    r.scene.background = new THREE.Color(lightMode ? "#ffffff" : "#161a1b");
    if (r.object instanceof THREE.Points && !asset.cloud.attributes?.hasColor) {
      (r.object.material as THREE.PointsMaterial).color.set(lightMode ? "#465157" : "#d8dcd7");
    }
    r.wake();
  }, [lightMode, asset.id, asset.mesh, asset.material, original]);
  useEffect(() => { runtime.current?.fit(); }, [asset.id, resetToken]);
  return <div className="object-preview" ref={hostRef} aria-label="物体三维预览" data-preview-mode={asset.mesh && !original ? "surface" : "points"} data-material={asset.material} />;
}
