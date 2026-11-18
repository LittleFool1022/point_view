import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import type { MaterialPreset, ObjectAsset, SurfaceMesh } from "./types";

export const MATERIALS: Record<MaterialPreset, { label: string; color: string; metalness: number; roughness: number; copy: string }> = {
  original: { label: "采集原色", color: "#ffffff", metalness: 0, roughness: 0.85, copy: "保留扫描颜色，光照可能与采集时不同。" },
  plaster: { label: "石膏", color: "#e4dfd5", metalness: 0, roughness: 0.92, copy: "柔和的反光，让形体与细节先被看见。" },
  metal: { label: "银色金属", color: "#bcc5ca", metalness: 1, roughness: 0.24, copy: "形状没变，光线的反射方式变了。" },
  ceramic: { label: "青釉陶瓷", color: "#8ba89c", metalness: 0, roughness: 0.18, copy: "光滑的青釉表面，为空间记忆换一种表达。" },
};
export function linearColors(bytes: Uint8Array): Float32Array {
  return Float32Array.from(bytes, value => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}
export function surfaceGeometry(mesh: SurfaceMesh, original: boolean): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  // GLB 中 COLOR_0 会乘材质底色；纯色材质的副本不携带顶点色。
  if (original) geometry.setAttribute("color", new THREE.BufferAttribute(linearColors(mesh.colors), 3));
  return geometry;
}
export function surfaceMaterial(preset: MaterialPreset) {
  const value = MATERIALS[preset];
  const material = new THREE.MeshStandardMaterial({ color: value.color, metalness: value.metalness, roughness: value.roughness, vertexColors: preset === "original", side: THREE.DoubleSide });
  material.name = preset;
  return material;
}
export async function exportObjectGlb(asset: ObjectAsset): Promise<Uint8Array> {
  if (!asset.mesh?.indices.length) throw new Error("请先生成有效表面，再导出 Blender 模型。");
  if (!(asset.metersPerUnit > 0) || !Number.isFinite(asset.metersPerUnit)) throw new Error("请核对模型尺寸与单位。");
  const geometry = surfaceGeometry(asset.mesh, asset.material === "original");
  const material = surfaceMaterial(asset.material);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = asset.name;
  // 本地 Z-up 转 glTF Y-up，只在导出根节点施加一次；局部原点便于继续编辑。
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.setScalar(asset.metersPerUnit);
  mesh.userData = { pointView: { version: 1, source: asset.source, originZUp: asset.origin, createdAt: asset.createdAt, metersPerSourceUnit: asset.metersPerUnit, material: asset.material, reconstruction: asset.mesh.report } };
  try {
    const buffer = await new GLTFExporter().parseAsync(mesh, { binary: true, onlyVisible: true });
    if (!(buffer instanceof ArrayBuffer)) throw new Error("GLB 导出未返回二进制结果。");
    return new Uint8Array(buffer);
  } finally { geometry.dispose(); material.dispose(); }
}
