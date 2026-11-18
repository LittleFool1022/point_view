import type { EditOperation, PointCloudData } from "./types";

export function applyEdit(cloud: PointCloudData, operation: EditOperation): PointCloudData {
  const next: PointCloudData = {
    ...cloud,
    positions: cloud.positions.slice(),
    colors: cloud.colors.slice(),
    visible: cloud.visible.slice(),
  };
  if (operation.kind === "hide" || operation.kind === "restore") {
    const value = operation.kind === "hide" ? 0 : 1;
    for (const index of operation.indices) if (index >= 0 && index < next.visible.length) next.visible[index] = value;
  }
  if (operation.kind === "color-gain" && operation.payload?.gain) {
    const gain = operation.payload.gain;
    for (const index of operation.indices) {
      for (let channel = 0; channel < 3; channel++) {
        const offset = index * 3 + channel;
        next.colors[offset] = Math.max(0, Math.min(255, Math.round(next.colors[offset]! * gain[channel]!)));
      }
    }
  }
  if (operation.kind === "transform" && operation.payload?.matrix?.length === 16) {
    const m = operation.payload.matrix;
    for (const index of operation.indices) {
      const offset = index * 3;
      const x = next.positions[offset]!, y = next.positions[offset + 1]!, z = next.positions[offset + 2]!;
      next.positions[offset] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      next.positions[offset + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      next.positions[offset + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    }
  }
  return next;
}

export function visibleIndices(cloud: PointCloudData): number[] {
  const result: number[] = [];
  for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i]) result.push(i);
  return result;
}
