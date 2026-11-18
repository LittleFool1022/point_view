import { describe, expect, it } from "vitest";
import { exportLas, parseLas } from "./las";
import type { PointCloudData } from "./types";

describe("LAS 交换格式", () => {
  it("LAS 1.2 format 2 round-trip 保持毫米坐标和 RGB", () => {
    const cloud: PointCloudData = {
      id: "las", frameId: "map", stampNs: 0n,
      positions: new Float32Array([100.125, -20.25, 3.5, 101, -21, 4]),
      colors: new Uint8Array([1, 128, 255, 20, 30, 40]),
      intensities: new Float32Array([0.5, 1]), visible: new Uint8Array([1, 0]),
    };
    const bytes = exportLas(cloud);
    const result = parseLas(bytes.buffer as ArrayBuffer, "decoded");
    expect(result.positions[0]).toBeCloseTo(100.125, 3);
    expect(result.positions[1]).toBeCloseTo(-20.25, 3);
    expect([...result.colors]).toEqual([1, 128, 255]);
  });
});
