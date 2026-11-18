import { describe, expect, it } from "vitest";
import type { PointCloudData } from "./types";
import { exportPcd, parsePcd } from "./pcd";
import { exportPly, parsePly } from "./ply";

const cloud = (): PointCloudData => ({
  id: "formats", frameId: "camera_init", stampNs: 0n,
  positions: new Float32Array([1.25, -2.5, 3.75, 9, 8, 7]),
  colors: new Uint8Array([17, 34, 51, 200, 201, 202]),
  visible: new Uint8Array([1, 0]),
});

function binaryCompressedPcd(): ArrayBuffer {
  const pointCount = 3;
  const fieldMajor = new Uint8Array(pointCount * 4 * 4);
  const view = new DataView(fieldMajor.buffer);
  const fields = [
    [1, 2, 3],
    [10, 20, 30],
    [-1, -2, -3],
  ];
  fields.forEach((values, field) => values.forEach((value, point) => {
    view.setFloat32((field * pointCount + point) * 4, value, true);
  }));
  [0x112233, 0x445566, 0x778899].forEach((value, point) => {
    view.setUint32((3 * pointCount + point) * 4, value, true);
  });

  // 测试夹具只使用 LZF literal 块，足以覆盖 PCD 的解压和字段重排路径。
  const compressed = new Uint8Array(fieldMajor.length + Math.ceil(fieldMajor.length / 32));
  let source = 0;
  let target = 0;
  while (source < fieldMajor.length) {
    const length = Math.min(32, fieldMajor.length - source);
    compressed[target++] = length - 1;
    compressed.set(fieldMajor.subarray(source, source + length), target);
    source += length;
    target += length;
  }
  const payload = compressed.subarray(0, target);
  const header = new TextEncoder().encode(
    `VERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH 3\nHEIGHT 1\nPOINTS 3\nDATA binary_compressed\n`,
  );
  const output = new Uint8Array(header.length + 8 + payload.length);
  output.set(header);
  const sizes = new DataView(output.buffer, header.length, 8);
  sizes.setUint32(0, payload.length, true);
  sizes.setUint32(4, fieldMajor.length, true);
  output.set(payload, header.length + 8);
  return output.buffer;
}

describe("点云交换格式", () => {
  it("PCD binary round-trip 只保留可见点", () => {
    const decoded = parsePcd(exportPcd(cloud()).buffer as ArrayBuffer, "pcd");
    expect([...decoded.positions]).toEqual([1.25, -2.5, 3.75]);
    expect([...decoded.colors]).toEqual([17, 34, 51]);
  });

  it("解析 PCL binary_compressed 并恢复 field-major 数据", () => {
    const decoded = parsePcd(binaryCompressedPcd(), "compressed");
    expect([...decoded.positions]).toEqual([1, 10, -1, 2, 20, -2, 3, 30, -3]);
    expect([...decoded.colors]).toEqual([17, 34, 51, 68, 85, 102, 119, 136, 153]);
    expect(decoded.sourcePointCount).toBe(3);
  });

  it("移动端点数预算对压缩 PCD 均匀采样并保留首尾", () => {
    const decoded = parsePcd(binaryCompressedPcd(), "sampled", { maxPoints: 2 });
    expect([...decoded.positions]).toEqual([1, 10, -1, 3, 30, -3]);
    expect([...decoded.colors]).toEqual([17, 34, 51, 119, 136, 153]);
    expect(decoded.visible).toEqual(new Uint8Array([1, 1]));
    expect(decoded.sourcePointCount).toBe(3);
  });

  it("PLY binary round-trip 只保留可见点", () => {
    const bytes = exportPly(cloud());
    const decoded = parsePly(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "ply");
    expect([...decoded.positions]).toEqual([1.25, -2.5, 3.75]);
    expect([...decoded.colors]).toEqual([17, 34, 51]);
  });
});
