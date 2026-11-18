import { describe, expect, it } from "vitest";
import { binaryPcdPointCount } from "../scripts/real-fixture";


describe("验证脚本的真实点数来源", () => {
  it("从实际 binary PCD 头读取 POINTS", () => {
    const header = new TextEncoder().encode("VERSION .7\r\nPOINTS 2\r\nDATA binary\r\n"), bytes = new Uint8Array(header.length + 32);bytes.set(header);
    expect(binaryPcdPointCount(bytes.buffer)).toBe(2);
  });

  it("拒绝 ASCII、缺少 POINTS 和空源数据，不伪造点数", () => {
    const bytes = (text: string) => Uint8Array.from(new TextEncoder().encode(text)).buffer;
    expect(() => binaryPcdPointCount(bytes("POINTS 2\nDATA ascii\n"))).toThrow("不是受支持的 binary PCD");
    expect(() => binaryPcdPointCount(bytes("WIDTH 2\nDATA binary\n"))).toThrow("POINTS");
    expect(() => binaryPcdPointCount(undefined)).toThrow("source.bytes");
  });
});
