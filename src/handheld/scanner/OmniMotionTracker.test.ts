import { describe, expect, it } from "vitest";
import { OmniMotionTracker } from "./OmniMotionTracker";
const sample = (timestamp: number, x: number, y = 0, z = 0, frameId = "camera_init") => ({ timestamp, position: { x, y, z }, frameId });
describe("OMNI 定位速度", () => {
  it("使用 ROS 时间和三维位移计算速度，静止为真实零值", () => {
    const tracker = new OmniMotionTracker();
    expect(tracker.sample(sample(10, 0))).toMatchObject({ speed: null });
    expect(tracker.sample(sample(10.1, 0.06))).toBeNull();
    expect(tracker.sample(sample(10.5, 0.3, 0.4))?.speed).toBeCloseTo(1);
    expect(tracker.sample(sample(11, 0.3, 0.4))?.speed).toBe(0);
  });
  it("重复消息不能刷新速度；时间回退、断流及坐标系切换重新等待两帧", () => {
    const tracker = new OmniMotionTracker();
    tracker.sample(sample(1, 0));tracker.sample(sample(1.5, 1));
    expect(tracker.sample(sample(1.5, 2))).toBeNull();
    expect(tracker.sample(sample(1.4, 20))?.speed).toBeNull();
    expect(tracker.sample(sample(5, 20))?.speed).toBeNull();
    expect(tracker.sample(sample(5.5, 21, 0, 0, "new"))?.speed).toBeNull();
    tracker.reset();expect(tracker.sample(sample(6, 100))?.speed).toBeNull();
  });
  it("非法坐标与时间不产生 NaN 读数", () => {
    const tracker = new OmniMotionTracker();tracker.sample(sample(0, 0));
    expect(tracker.sample(sample(0.5, NaN))?.speed).toBeNull();
    expect(tracker.sample(sample(Infinity, 0))?.speed).toBeNull();
  });
});
