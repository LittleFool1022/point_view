import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseLasOrLaz } from "../src/domain/las";

const fixture = process.env.LAZ_FIXTURE;

describe("LAZ WASM 解码", () => {
  it.skipIf(!fixture)("解码 loaders.gl 官方 indoor.laz", async () => {
    const bytes = await readFile(fixture!);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const cloud = await parseLasOrLaz(buffer, "official-laz");
    expect(cloud.positions.length).toBe(808_042 * 3);
    expect(cloud.visible.length).toBe(808_042);
    expect(cloud.colors.length).toBe(808_042 * 3);
  });
});
