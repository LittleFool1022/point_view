import { describe, expect, it } from "vitest";
import type { PointCloudData } from "../domain/types";
import { analyzeStaticPointCloud, buildQualityReport, createStableQualitySample } from "./analyze";

function planeCloud(size = 40): PointCloudData {
  const positions = new Float32Array(size * size * 3);
  const colors = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      positions[index * 3] = x * 0.1;
      positions[index * 3 + 1] = y * 0.1;
      positions[index * 3 + 2] = Math.sin(x * 0.2) * 0.002;
      colors.set([120, 130, 140], index * 3);
    }
  }
  return {
    id: "plane", frameId: "camera_init", stampNs: 0n, sourcePointCount: size * size,
    attributes: { hasColor: true, hasIntensity: false, frameIdDeclared: false, timestampDeclared: false },
    positions, colors, visible: new Uint8Array(size * size).fill(1),
  };
}

describe("静态 PCD 质量分析", () => {
  it("固定种子稳定采样限制为 2 万点", () => {
    const cloud = planeCloud(142);
    const first = createStableQualitySample(cloud);
    const second = createStableQualitySample(cloud);
    expect(first.positions.length / 3).toBe(20_000);
    expect(first.positions).toEqual(second.positions);
    expect(first.colors).toEqual(second.colors);
  });

  it("对规则彩色平面输出稳定的几何和颜色证据", () => {
    const first = analyzeStaticPointCloud(planeCloud(), "good.pcd");
    const second = analyzeStaticPointCloud(planeCloud(), "good.pcd");
    expect(first.geometry).toEqual(second.geometry);
    expect(first.geometry.finiteRatio).toBe(1);
    expect(first.geometry.outlierRatio).toBeLessThan(0.03);
    expect(first.geometry.roughnessP90M).toBeLessThan(0.01);
    expect(first.color.rgbCoverageRatio).toBe(1);

    const report = buildQualityReport(first, "metric-map");
    expect(report.dimensions.geometry.score).toBeGreaterThanOrEqual(80);
    expect(report.dimensions.registration.status).toBe("unavailable");
    expect(report.deliveryStatus.status).toBe("partial");
  });

  it("有限坐标不足 99% 时触发硬门禁，缺颜色不冒充满分", () => {
    const cloud = planeCloud(10);
    cloud.attributes = { hasColor: false, hasIntensity: false };
    for (let index = 0; index < 3; index++) cloud.positions[index * 3] = Number.NaN;
    const evidence = analyzeStaticPointCloud(cloud, "bad.pcd");
    const report = buildQualityReport(evidence, "metric-map");
    expect(evidence.geometry.finiteRatio).toBe(0.97);
    expect(evidence.color.rgbCoverageRatio).toBeNull();
    expect(report.hardGates.find((gate) => gate.id === "finite-coordinates")?.status).toBe("fail");
    expect(report.deliveryStatus.status).toBe("fail");
  });

  it("3DGS Profile 对缺失图片、位姿和标定明确判失败", () => {
    const report = buildQualityReport(analyzeStaticPointCloud(planeCloud(), "map.pcd"), "3dgs-ready");
    expect(report.hardGates.filter((gate) => gate.status === "fail").map((gate) => gate.id)).toEqual([
      "3dgs-images", "3dgs-poses", "3dgs-calibration",
    ]);
    expect(report.deliveryStatus.reason).toContain("3DGS 原始图片");
  });

  it("2 万点上限的静态分析保持有界", () => {
    const startedAt = performance.now();
    const evidence = analyzeStaticPointCloud(planeCloud(141), "20k.pcd");
    expect(evidence.source.analyzedPointCount).toBe(19_881);
    expect(evidence.geometry.roughnessP90M).not.toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });
});
