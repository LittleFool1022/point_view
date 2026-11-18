import type { PointCloudData } from "../../domain/types";

export const SCAN_POINT_BUDGET = 100_000;
export const SCAN_SNAPSHOT_MS = 200;
export const SCAN_INTERACTION_BUDGET = 10_000;

export type ScanWorkerInput =
  | { type: "reset"; token: string }
  | { type: "frame"; token: string; cloud: PointCloudData }
  | { type: "ack"; token: string };
export type ScanWorkerOutput =
  | { type: "consumed"; token: string }
  | { type: "snapshot"; token: string; cloud: PointCloudData };

interface Cell {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  intensity: number;
  seen: number;
}

/** 只累计已经接收的预览；空间粗化保留远处区域，不按时间淘汰旧区域。 */
export class ScanPreviewAccumulator {
  private cells = new Map<string, Cell>();
  private voxel = 0.05;
  private revision = 0;
  private last?: PointCloudData;

  constructor(private budget = SCAN_POINT_BUDGET) {}

  private key(point: Cell) {
    return `${Math.floor(point.x / this.voxel)},${Math.floor(point.y / this.voxel)},${Math.floor(point.z / this.voxel)}`;
  }

  private coarsen() {
    while (this.cells.size > this.budget) {
      this.voxel *= 2;
      const coarse = new Map<string, Cell>();
      for (const point of this.cells.values()) {
        const key = this.key(point);
        const previous = coarse.get(key);
        if (!previous || point.seen >= previous.seen) coarse.set(key, point);
      }
      this.cells = coarse;
    }
  }

  add(cloud: PointCloudData) {
    this.last = cloud;
    this.revision++;
    const count = cloud.positions.length / 3;
    const stride = Math.max(1, Math.ceil(count / 120_000));
    for (let i = 0; i < count; i += stride) {
      if (!cloud.visible[i]) continue;
      const offset = i * 3;
      const [x, y, z] = cloud.positions.subarray(offset, offset + 3);
      if (![x, y, z].every(Number.isFinite)) continue;
      const point: Cell = { x, y, z, r: cloud.colors[offset], g: cloud.colors[offset + 1], b: cloud.colors[offset + 2],
        intensity: cloud.intensities?.[i] ?? 0.5, seen: this.revision };
      // 同体素采用最新观测，几何与颜色始终取自同一个点。
      this.cells.set(this.key(point), point);
      if (this.cells.size > this.budget) this.coarsen();
    }
    // 不保留输入的大数组，只保留展示所需的头信息。
    this.last = { ...cloud, positions: new Float32Array(), colors: new Uint8Array(), visible: new Uint8Array(), intensities: undefined };
  }

  snapshot(token: string): PointCloudData | undefined {
    if (!this.last || !this.cells.size) return;
    const count = this.cells.size;
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 3);
    const displayColors = new Uint8Array(count * 3);
    const intensities = new Float32Array(count);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const stride = Math.max(1, Math.ceil(count / SCAN_INTERACTION_BUDGET));
    const groupSize = Math.floor(count / stride), extra = count % stride;
    let i = 0;
    for (const point of this.cells.values()) {
      // 按余数分组，首组均匀跨越整张地图；拖动降采样也不会只剩早期区域。
      const group = i % stride;
      const rendered = group * groupSize + Math.min(group, extra) + Math.floor(i / stride);
      const offset = rendered * 3;
      positions.set([point.x, point.y, point.z], offset);
      colors.set([point.r, point.g, point.b], offset);
      const brightness = point.seen === this.revision ? 1 : 0.55;
      displayColors.set([point.r * brightness, point.g * brightness, point.b * brightness], offset);
      intensities[rendered] = point.intensity;
      i++;
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], positions[offset + axis]);
        max[axis] = Math.max(max[axis], positions[offset + axis]);
      }
    }
    const center = min.map((value, axis) => (value + max[axis]) / 2) as [number, number, number];
    return { ...this.last, id: `scan:${token}:${this.revision}`, positions, colors, intensities,
      visible: new Uint8Array(count).fill(1),
      scanPreview: { token, displayColors, center, radius: Math.max(0.5, Math.hypot(...max.map((value, axis) => value - min[axis])) / 2),
        voxelSize: this.voxel, interactionCount: Math.ceil(count / stride) },
    };
  }
}
