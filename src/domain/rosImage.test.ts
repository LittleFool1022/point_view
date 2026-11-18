import { describe, expect, it } from "vitest";
import { decodeRosImage, detectEncodedImageMime } from "./rosImage";

describe("decodeRosImage", () => {
  it("将 Handbot2 bgr8 图像按 step 转换为 RGBA", () => {
    const rgba = decodeRosImage({
      width: 2,
      height: 1,
      step: 8,
      encoding: "bgr8",
      data: Uint8Array.from([30, 20, 10, 60, 50, 40, 0, 0]),
    });
    expect([...rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it("拒绝数据长度不足的原始图像", () => {
    expect(() => decodeRosImage({
      width: 2,
      height: 2,
      step: 6,
      encoding: "rgb8",
      data: new Uint8Array(6),
    })).toThrow("数据不完整");
  });

  it("识别 Handbot2 填入 Image.data 的 JPEG 字节", () => {
    expect(detectEncodedImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });
});
