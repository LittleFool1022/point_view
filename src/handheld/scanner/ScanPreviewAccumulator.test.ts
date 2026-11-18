import { describe, expect, it } from "vitest";
import { ScanPreviewAccumulator } from "./ScanPreviewAccumulator";
import type { PointCloudData } from "../../domain/types";

function frame(points: number[], stamp = 1n): PointCloudData {
  return { id: "fixture", frameId: "camera_init", stampNs: stamp, positions: new Float32Array(points),
    colors: new Uint8Array(points.length).fill(200), visible: new Uint8Array(points.length / 3).fill(1),
    intensities: new Float32Array(points.length / 3).fill(0.7) };
}

describe("扫描空间累计", () => {
  it("交互前缀不超过一万点并覆盖全域，颜色和强度在重排后仍对齐", () => {
    const model = new ScanPreviewAccumulator();
    const cloud = frame(Array.from({ length: 20_003 }, (_, i) => [i * 0.1, 1, 1]).flat());
    for (let i = 0; i < cloud.visible.length; i++) { cloud.colors[i * 3] = i % 255; cloud.intensities![i] = i; }
    model.add(cloud);
    const output = model.snapshot("lod")!;
    const count = output.scanPreview!.interactionCount;
    expect(count).toBeLessThanOrEqual(10_000);
    expect(output.positions[(count - 1) * 3]).toBeGreaterThan(1999);
    for (let i = 0; i < count; i++) {
      const original = Math.round(output.positions[i * 3] / 0.1);
      expect(output.colors[i * 3]).toBe(original % 255);
      expect(output.intensities![i]).toBe(original);
    }
  });

  it("保留旧区域、同体素取最新观测，并只降低历史点的显示亮度", () => {
    const model = new ScanPreviewAccumulator();
    model.add(frame([0, 0, 0, 1, 0, 0]));
    model.add(frame([1.01, 0, 0, 2, 0, 0], 2n));
    const result = model.snapshot("A")!;
    expect([...result.positions]).toEqual([0, 0, 0, expect.closeTo(1.01), 0, 0, 2, 0, 0]);
    expect([...result.colors]).toEqual(new Array(9).fill(200));
    expect([...result.scanPreview!.displayColors]).toEqual([110, 110, 110, 200, 200, 200, 200, 200, 200]);
    expect(result.scanPreview!.center).toEqual([1, 0, 0]);
    expect(result.scanPreview!.radius).toBe(1);
    expect(result.intensities![0]).toBeCloseTo(0.7);
  });

  it("超预算进行空间粗化，仍保留两端区域，输出 buffer 转移不会破坏累计状态", () => {
    const model = new ScanPreviewAccumulator(8);
    const positions = Array.from({ length: 200 }, (_, i) => [i * 0.1, 1, 1]).flat();
    model.add(frame(positions));
    const first = model.snapshot("A")!;
    expect(first.visible.length).toBeLessThanOrEqual(8);
    expect(first.scanPreview!.voxelSize).toBeGreaterThan(0.05);
    expect(Math.min(...first.positions.filter((_, i) => i % 3 === 0))).toBeLessThan(5);
    expect(Math.max(...first.positions.filter((_, i) => i % 3 === 0))).toBeGreaterThan(15);
    structuredClone(first.positions, { transfer: [first.positions.buffer] });
    model.add(frame([40, 1, 1], 3n));
    const next = model.snapshot("A")!;
    expect(next.positions.length).toBe(next.colors.length);
    expect(next.visible.length).toBe(next.intensities!.length);
    expect(next.positions.length).toBeGreaterThan(3);
    expect(next.scanPreview!.center[0]).toBeGreaterThan(15);
  });
});
