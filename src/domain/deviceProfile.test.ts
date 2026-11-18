import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOR_MODE,
  DEFAULT_DEVICE_PROFILE,
  cameraTopicEntries,
  pointCloudTopicEntries,
  type DeviceProfile,
} from "./types";

describe("omni DeviceProfile", () => {
  it("默认使用点云自身的 RGB 真彩颜色", () => {
    expect(DEFAULT_COLOR_MODE).toBe("rgb");
  });

  it("默认使用 omni 的三目精确彩色点云与三目压缩图像主题", () => {
    expect(DEFAULT_DEVICE_PROFILE.id).toBe("omni-mid360s-tricamera");
    expect(DEFAULT_DEVICE_PROFILE.wsUrl).toBe("ws://10.42.0.1:8765");
    expect(DEFAULT_DEVICE_PROFILE.topics.pointCloud).toBe("/cloud_registered");
    expect(DEFAULT_DEVICE_PROFILE.topics.mergedPointCloud).toBe("/cloud_registered/tri_precise");
    expect(DEFAULT_DEVICE_PROFILE.pointCloudSelection).toEqual(["merged"]);
    expect(DEFAULT_DEVICE_PROFILE.topics.syncStatus).toBe("/omni/sync/status");
    expect(DEFAULT_DEVICE_PROFILE.frames.world).toBe("camera_init");
    expect(cameraTopicEntries(DEFAULT_DEVICE_PROFILE)).toEqual([
      ["front", "/omni/camera/front/image/compressed"],
      ["left", "/omni/camera/left/image/compressed"],
      ["right", "/omni/camera/right/image/compressed"],
    ]);
    expect(pointCloudTopicEntries(DEFAULT_DEVICE_PROFILE)).toEqual([
      ["merged", "/cloud_registered/tri_precise"],
    ]);
    expect(DEFAULT_DEVICE_PROFILE.topics.pointClouds).toEqual({
      front: "/cloud_registered/front",
      left: "/cloud_registered/left",
      right: "/cloud_registered/right",
    });
  });

  it("兼容旧项目中的单相机 image 字段", () => {
    const legacy = {
      ...DEFAULT_DEVICE_PROFILE,
      pointCloudSelection: undefined,
      topics: {
        ...DEFAULT_DEVICE_PROFILE.topics,
        images: undefined,
        image: "/image_right0",
      },
    } as DeviceProfile;

    expect(cameraTopicEntries(legacy)).toEqual([["front", "/image_right0"]]);
  });

  it("兼容旧项目中的单路 pointCloud 字段", () => {
    const legacy = {
      ...DEFAULT_DEVICE_PROFILE,
      pointCloudSelection: undefined,
      topics: {
        ...DEFAULT_DEVICE_PROFILE.topics,
        mergedPointCloud: undefined,
        pointClouds: undefined,
      },
    } as DeviceProfile;

    expect(pointCloudTopicEntries(legacy)).toEqual([["front", "/cloud_registered"]]);
  });

  it("三目合并主题缺失时回退到前左右独立主题", () => {
    const profile = {
      ...DEFAULT_DEVICE_PROFILE,
      pointCloudSelection: undefined,
      topics: { ...DEFAULT_DEVICE_PROFILE.topics, mergedPointCloud: undefined },
    };
    expect(pointCloudTopicEntries(profile)).toEqual([
      ["front", "/cloud_registered/front"],
      ["left", "/cloud_registered/left"],
      ["right", "/cloud_registered/right"],
    ]);
  });

  it("允许选择多个独立诊断点云且不包含合并点云", () => {
    const profile = {
      ...DEFAULT_DEVICE_PROFILE,
      pointCloudSelection: ["front", "right"],
    } as DeviceProfile;
    expect(pointCloudTopicEntries(profile)).toEqual([
      ["front", "/cloud_registered/front"],
      ["right", "/cloud_registered/right"],
    ]);
  });
});
