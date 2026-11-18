import type { PointCloudData } from "../domain/types";
import type { ObjectAsset } from "./types";

export function pointBounds(cloud: PointCloudData, indices?: Iterable<number>) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const i of indices ?? cloud.visible.keys()) {
    if (!cloud.visible[i]) continue;
    const p = cloud.positions.subarray(i * 3, i * 3 + 3);
    if (p.length !== 3 || !p.every(Number.isFinite)) continue;
    count++;
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a]!, p[a]!); max[a] = Math.max(max[a]!, p[a]!); }
  }
  return { min, max, count, center: min.map((v, i) => (v + max[i]!) / 2) as [number, number, number], size: min.map((v, i) => max[i]! - v) as [number, number, number] };
}

/** 分位范围只用于默认取景，不裁剪数据；范围相近时仍展示完整点云。 */
export function subjectBounds(cloud: PointCloudData, full = pointBounds(cloud)) {
  const axes: [number[], number[], number[]] = [[], [], []];
  const stride = Math.max(1, Math.ceil(cloud.visible.length / 65_536));
  for (let i = 0; i < cloud.visible.length; i += stride) {
    if (!cloud.visible[i]) continue;
    const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!, z = cloud.positions[i * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    axes[0].push(x); axes[1].push(y); axes[2].push(z);
  }
  if (axes[0].length < 100) return full;
  const min: [number, number, number] = [0, 0, 0], max: [number, number, number] = [0, 0, 0];
  axes.forEach((values, axis) => {
    values.sort((a, b) => a - b);
    min[axis] = values[Math.floor((values.length - 1) * 0.01)]!;
    max[axis] = values[Math.ceil((values.length - 1) * 0.99)]!;
  });
  const size = min.map((value, axis) => max[axis]! - value) as [number, number, number];
  const diagonal = Math.hypot(...size);
  if (diagonal === 0 || Math.hypot(...full.size) <= diagonal * 2) return full;
  return { min, max, size, count: full.count, center: min.map((value, axis) => (value + max[axis]!) / 2) as [number, number, number] };
}

/** 完整内存数据选取，与 GPU 点数预算无关；深度由 clipW 排除相机背面。 */
export function projectedSelection(cloud: PointCloudData, matrix: readonly number[], rect: readonly number[], start = 0, end = cloud.visible.length): number[] {
  const hits: number[] = [];
  for (let i = start; i < end; i++) {
    if (!cloud.visible[i]) continue;
    const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!, z = cloud.positions[i * 3 + 2]!;
    const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
    if (!(w > 0)) continue;
    const px = (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / w;
    const py = (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / w;
    const pz = (matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!) / w;
    if (pz >= -1 && pz <= 1 && px >= rect[0]! && px <= rect[1]! && py >= rect[2]! && py <= rect[3]!) hits.push(i);
  }
  return hits;
}

export function createObject(cloud: PointCloudData, selected: Iterable<number>, sourceName: string): ObjectAsset {
  const indices = [...selected].filter(i => cloud.visible[i] && cloud.positions.subarray(i * 3, i * 3 + 3).every(Number.isFinite));
  const bounds = pointBounds(cloud, indices);
  if (bounds.count < 3) throw new Error("请至少选择三个有效点，再保存物体。");
  const positions = new Float32Array(indices.length * 3), colors = new Uint8Array(indices.length * 3);
  const intensities = cloud.intensities ? new Float32Array(indices.length) : undefined;
  indices.forEach((i, target) => {
    for (let a = 0; a < 3; a++) positions[target * 3 + a] = cloud.positions[i * 3 + a]! - bounds.center[a]!;
    colors.set(cloud.colors.subarray(i * 3, i * 3 + 3), target * 3);
    if (intensities) intensities[target] = cloud.intensities![i]!;
  });
  const id = crypto.randomUUID();
  return {
    version: 1, id, name: "我的第一件物体", createdAt: new Date().toISOString(),
    source: { id: cloud.id, name: sourceName, frameId: cloud.frameId, sampled: (cloud.sourcePointCount ?? cloud.visible.length) > cloud.visible.length, pointCount: cloud.sourcePointCount ?? cloud.visible.length, stampNs: cloud.stampNs.toString() },
    origin: bounds.center, sourceIndices: Uint32Array.from(indices.map(i => cloud.sourcePointIndices?.[i] ?? i)),
    cloud: { id, frameId: cloud.frameId, stampNs: cloud.stampNs, attributes: cloud.attributes, positions, colors, intensities, visible: new Uint8Array(indices.length).fill(1) },
    material: cloud.attributes?.hasColor ? "original" : "plaster", metersPerUnit: 1,
  };
}
