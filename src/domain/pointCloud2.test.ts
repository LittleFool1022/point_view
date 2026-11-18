import { describe, expect, it } from "vitest";
import { decodePointCloud2, type RosPointCloud2 } from "./pointCloud2";

describe("decodePointCloud2", () => {
  it("解码 little-endian XYZ 与 packed RGB，并过滤 NaN", () => {
    const data = new Uint8Array(32);
    const view = new DataView(data.buffer);
    view.setFloat32(0, 1, true); view.setFloat32(4, 2, true); view.setFloat32(8, 3, true);
    view.setUint32(12, 0x00112233, true);
    view.setFloat32(16, Number.NaN, true); view.setFloat32(20, 8, true); view.setFloat32(24, 9, true);
    view.setUint32(28, 0x00ffffff, true);
    const message: RosPointCloud2 = {
      header: { frame_id: "camera_init", stamp: { sec: 4, nanosec: 5 } },
      height: 1, width: 2, is_bigendian: false, point_step: 16, row_step: 32, data,
      fields: [
        { name: "x", offset: 0, datatype: 7, count: 1 },
        { name: "y", offset: 4, datatype: 7, count: 1 },
        { name: "z", offset: 8, datatype: 7, count: 1 },
        { name: "rgb", offset: 12, datatype: 7, count: 1 },
      ],
    };
    const cloud = decodePointCloud2(message, "test");
    expect([...cloud.positions]).toEqual([1, 2, 3]);
    expect([...cloud.colors]).toEqual([0x11, 0x22, 0x33]);
    expect(cloud.stampNs).toBe(4_000_000_005n);
    expect(cloud.attributes?.frameIdDeclared).toBe(true);
    expect(decodePointCloud2({ ...message, header: undefined }).attributes?.frameIdDeclared).toBe(false);
    expect(decodePointCloud2({ ...message, header: { frame_id: "   " } }).attributes?.frameIdDeclared).toBe(false);
  });
});
