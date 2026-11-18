import type { PointCloudData } from "../../../src/domain/types";

export interface CloudPointRay {
  origin: [number, number, number];
  direction: [number, number, number];
  toleranceM: number;
  surfaceBandM?: number;
}

export interface CloudMeasuredPoint {
  index: number;
  position: [number, number, number];
  rayDistanceM: number;
}

function validateRay(ray: CloudPointRay) {
  if (![...ray.origin, ...ray.direction, ray.toleranceM].every(Number.isFinite) || ray.toleranceM <= 0) {
    throw Error("测距射线无效。");
  }
  if (ray.surfaceBandM !== undefined && (!Number.isFinite(ray.surfaceBandM) || ray.surfaceBandM <= 0)) {
    throw Error("测距表面厚度无效。");
  }
  const length = Math.hypot(...ray.direction);
  if (!(length > 0)) throw Error("测距方向无效。");
  return {
    dx: ray.direction[0] / length,
    dy: ray.direction[1] / length,
    dz: ray.direction[2] / length,
    band: ray.surfaceBandM ?? Math.min(0.2, Math.max(0.03, ray.toleranceM * 1.5)),
  };
}

/** 先锁定视线前方可见表面带，再在该带内匹配垂直射线距离最小的源点。 */
function pickCloudPointCore(
  positions: Float32Array,
  count: number,
  isVisible: (slot: number) => boolean,
  sourceIndexOf: (slot: number) => number,
  ray: CloudPointRay
): CloudMeasuredPoint | undefined {
  const { dx, dy, dz, band } = validateRay(ray);
  const [ox, oy, oz] = ray.origin;
  const tolSq = ray.toleranceM * ray.toleranceM;
  const limit = Math.min(count, Math.floor(positions.length / 3));
  let minAlong = Infinity;
  const candSlot: number[] = [];
  const candAlong: number[] = [];
  const candDistSq: number[] = [];

  for (let slot = 0; slot < limit; slot++) {
    if (!isVisible(slot)) continue;
    const base = slot * 3;
    const vx = positions[base]! - ox, vy = positions[base + 1]! - oy, vz = positions[base + 2]! - oz;
    const along = vx * dx + vy * dy + vz * dz;
    if (along < 0 || along > minAlong + band) continue;
    const distSq = vx * vx + vy * vy + vz * vz - along * along;
    if (distSq > tolSq) continue;
    if (along < minAlong) minAlong = along;
    candSlot.push(slot);
    candAlong.push(along);
    candDistSq.push(distSq);
  }

  if (!candSlot.length) return undefined;
  const maxAlong = minAlong + band;
  let bestSlot = -1, bestDistSq = Infinity, bestAlong = Infinity;
  for (let k = 0; k < candSlot.length; k++) {
    const along = candAlong[k]!;
    if (along > maxAlong) continue;
    const distSq = candDistSq[k]!;
    if (distSq < bestDistSq - 1e-12 || (Math.abs(distSq - bestDistSq) <= 1e-12 && along < bestAlong)) {
      bestSlot = candSlot[k]!;
      bestDistSq = distSq;
      bestAlong = along;
    }
  }

  if (bestSlot < 0) return undefined;
  const base = bestSlot * 3;
  return {
    index: sourceIndexOf(bestSlot),
    position: [positions[base]!, positions[base + 1]!, positions[base + 2]!],
    rayDistanceM: Math.sqrt(Math.max(0, bestDistSq)),
  };
}

/** 在当前可见的完整源点中拾取原件点号；不使用预览采样点或屏幕距离作为测量几何。 */
export function pickCloudPoint(cloud: PointCloudData, ray: CloudPointRay): CloudMeasuredPoint {
  const hit = pickCloudPointCore(cloud.positions, cloud.visible.length, i => !!cloud.visible[i], i => i, ray);
  if (!hit) throw Error("未命中可见点云，请放大后点击实际点位。");
  return hit;
}

/** 悬停阶段在预览采样点中快速锁定前表面吸附点，用于点击前视觉反馈。 */
export function tryPickPreviewPoint(
  positions: Float32Array,
  sourceIndices: Uint32Array,
  visible: Uint8Array,
  ray: CloudPointRay
): CloudMeasuredPoint | undefined {
  return pickCloudPointCore(
    positions,
    sourceIndices.length,
    slot => !!visible[sourceIndices[slot]!],
    slot => sourceIndices[slot]!,
    ray
  );
}
