import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCapture } from "./CaptureViews";

// 使用 Python 打包验收真实输出，跨语言检查契约而非另造一份理想清单。
const fixture = () => JSON.parse(readFileSync(new URL("../../tests/fixtures/capture.views.json", import.meta.url), "utf8"));

describe("capture bundle contract", () => {
  it("accepts the Python bundle and retains nanosecond strings and raw pose status", () => {
    const manifest = fixture();
    manifest.views[0].stamp_ns = "1788854400123456789";
    const capture = parseCapture(manifest);
    expect(capture.views).toHaveLength(2);
    expect(capture.views[0]!.stamp_ns).toBe("1788854400123456789");
    expect(capture.pose_space).toBe("raw");
  });
  it.each(["images/../front_4.png", "https://example.com/front_4.png", "/front_4.png"])("rejects unsafe image reference %s", path => {
    const manifest = fixture(); manifest.views[0].image = path;
    expect(() => parseCapture(manifest)).toThrow();
  });
  it("rejects duplicate image names", () => {
    const manifest = fixture(); manifest.views.push(manifest.views[0]);
    expect(() => parseCapture(manifest)).toThrow();
  });
  it("rejects invalid poses and lossy numeric timestamps", () => {
    const manifest = fixture(); manifest.views[0].quaternion_xyzw = [0, 0, 0, 0];
    expect(() => parseCapture(manifest)).toThrow();
    const timestamp = fixture(); timestamp.views[0].stamp_ns = 1788854400123456789;
    expect(() => parseCapture(timestamp)).toThrow();
  });
  it("rejects unsupported calibration and invalid PCD hashes", () => {
    const manifest = fixture(); manifest.calibration.model = "unknown";
    expect(() => parseCapture(manifest)).toThrow();
    const hash = fixture(); hash.pcd.sha256 = "abc";
    expect(() => parseCapture(hash)).toThrow();
  });
  it("enforces the shared view count budget", () => {
    const manifest = fixture(); manifest.views = Array(513).fill(manifest.views[0]);
    expect(() => parseCapture(manifest)).toThrow();
  });
});
