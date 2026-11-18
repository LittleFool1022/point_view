import { describe, expect, it } from "vitest";
import { mergeCommonFrameClouds, mergeDecayFrames, pruneDecayFrames, type TimedPointCloud } from "./decay";
import type { PointCloudData } from "./types";

function cloud(id: string, points: number, color: number): PointCloudData {
  return {
    id,
    frameId: "map",
    stampNs: BigInt(points),
    positions: new Float32Array(points * 3).fill(points),
    colors: new Uint8Array(points * 3).fill(color),
    visible: new Uint8Array(points).fill(1),
  };
}

describe("点云消散时间窗", () => {
  const frames: TimedPointCloud[] = [
    { receivedAt: 1_000, cloud: cloud("old", 2, 10) },
    { receivedAt: 2_000, cloud: cloud("new", 3, 20) },
  ];

  it("移除超时帧并始终保留最新帧", () => {
    expect(pruneDecayFrames(frames, 2_500, 1_000, 100).map((frame) => frame.cloud.id)).toEqual(["new"]);
    expect(pruneDecayFrames(frames, 2_500, 0, 100).map((frame) => frame.cloud.id)).toEqual(["new"]);
  });

  it("超过点预算时从最旧帧开始移除", () => {
    expect(pruneDecayFrames(frames, 2_100, 10_000, 4).map((frame) => frame.cloud.id)).toEqual(["new"]);
  });

  it("拼接时间窗内的位置、颜色和可见掩码", () => {
    const merged = mergeDecayFrames(frames);
    expect(merged.positions.length).toBe(15);
    expect([...merged.colors.slice(0, 6)]).toEqual([10, 10, 10, 10, 10, 10]);
    expect([...merged.colors.slice(6)]).toEqual(new Array(9).fill(20));
    expect(merged.visible.length).toBe(5);
    expect(merged.stampNs).toBe(3n);
  });

  it("合并三视角点云并拒绝不同坐标系", () => {
    expect(mergeCommonFrameClouds(frames).visible.length).toBe(5);
    const wrongFrame = { ...frames[1]!, cloud: { ...frames[1]!.cloud, frameId: "left_camera" } };
    expect(() => mergeCommonFrameClouds([frames[0]!, wrongFrame])).toThrow("三路点云坐标系不一致");
  });
});
