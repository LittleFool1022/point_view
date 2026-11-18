import type { PointCloudData } from "./types";

export interface TimedPointCloud {
  receivedAt: number;
  cloud: PointCloudData;
}

/** 按消散时间和内存点预算裁剪历史帧；最新一帧始终保留。 */
export function pruneDecayFrames(
  frames: TimedPointCloud[],
  now: number,
  decayMs: number,
  maxPoints: number,
): TimedPointCloud[] {
  if (decayMs <= 0) return frames.length ? [frames[frames.length - 1]!] : [];
  const kept = frames.filter((frame) => now - frame.receivedAt <= decayMs);
  let total = kept.reduce((sum, frame) => sum + frame.cloud.positions.length / 3, 0);
  while (kept.length > 1 && total > maxPoints) {
    total -= kept.shift()!.cloud.positions.length / 3;
  }
  return kept;
}

/** 将时间窗内的点云帧拼接为一次 GPU 更新，保留每帧的 RGB、强度和可见掩码。 */
export function mergeDecayFrames(frames: TimedPointCloud[]): PointCloudData {
  const latest = frames[frames.length - 1]?.cloud;
  const pointCount = frames.reduce((sum, frame) => sum + frame.cloud.positions.length / 3, 0);
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 3);
  const visible = new Uint8Array(pointCount);
  const hasIntensity = frames.some((frame) => frame.cloud.intensities !== undefined);
  const intensities = hasIntensity ? new Float32Array(pointCount) : undefined;
  let pointOffset = 0;

  for (const { cloud } of frames) {
    positions.set(cloud.positions, pointOffset * 3);
    colors.set(cloud.colors, pointOffset * 3);
    visible.set(cloud.visible, pointOffset);
    if (intensities && cloud.intensities) intensities.set(cloud.intensities, pointOffset);
    pointOffset += cloud.positions.length / 3;
  }

  return {
    id: latest ? `${latest.id}:decay:${frames.length}` : "decay-empty",
    frameId: latest?.frameId ?? "map",
    stampNs: latest?.stampNs ?? 0n,
    positions,
    colors,
    intensities,
    visible,
  };
}

/** 合并三路点云前强制校验公共坐标系，避免把未标定数据叠在一起。 */
export function mergeCommonFrameClouds(frames: TimedPointCloud[]): PointCloudData {
  const frameIds = new Set(frames.map(({ cloud }) => cloud.frameId));
  if (frameIds.size > 1) throw new Error(`三路点云坐标系不一致: ${[...frameIds].join(", ")}`);
  return mergeDecayFrames(frames);
}
