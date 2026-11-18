import type { PointCloudData } from "./types";

/** 无设备时提供可交互的彩色室内点云，便于验证渲染与编辑链路。 */
export function createDemoCloud(count = 180_000): PointCloudData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const intensities = new Float32Array(count);
  let seed = 0x1f2e3d4c;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < count; i++) {
    const surface = i % 5;
    let x = (random() - 0.5) * 16;
    let y = (random() - 0.5) * 10;
    let z = random() * 5;
    if (surface === 0) z = random() * 0.06;
    if (surface === 1) z = 4.8 + random() * 0.06;
    if (surface === 2) x = -7.5 + random() * 0.06;
    if (surface === 3) y = 4.6 + random() * 0.06;
    if (surface === 4 && i % 11 === 0) {
      x = 2 + (random() - 0.5) * 2.2;
      y = 1 + (random() - 0.5) * 1.6;
      z = random() * 2.4;
    }
    const dst = i * 3;
    positions[dst] = x; positions[dst + 1] = y; positions[dst + 2] = z;
    colors[dst] = Math.round(35 + 180 * (x / 16 + 0.5));
    colors[dst + 1] = Math.round(80 + 170 * (z / 5));
    colors[dst + 2] = Math.round(245 - 130 * (y / 10 + 0.5));
    intensities[i] = random();
  }
  return { id: "demo-indoor", frameId: "camera_init", stampNs: 0n, positions, colors, intensities, visible: new Uint8Array(count).fill(1) };
}
