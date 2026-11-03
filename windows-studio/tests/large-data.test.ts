import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, readdir, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCloud } from "../src/pipeline/binaryPcd";
const { SourceStore } = createRequire(import.meta.url)("../electron/source-store.cjs");

describe("大文件读取与流式工程", () => {
  it("DATA 行结束后保留全部二进制空白字节，兼容 LF/CRLF 与非 ASCII 注释", async () => {
    for (const ending of ['\n','\r\n']) for (const bits of [0x3f80000a,0x3f800a0d,0x3f0a0920]) {
      const header=Buffer.from(['# 实测点云','VERSION .7','FIELDS x y z','SIZE 4 4 4','TYPE F F F','COUNT 1 1 1','WIDTH 1','HEIGHT 1','POINTS 1','DATA binary  ', ''].join(ending));
      const payload=Buffer.alloc(12);payload.writeUInt32LE(bits,0);payload.writeFloatLE(2,4);payload.writeFloatLE(3,8);
      const bytes=Uint8Array.from(Buffer.concat([header,payload])).buffer;
      const decoded=await readCloud({name:'whitespace.pcd',bytes},'m',async(o,n)=>bytes.slice(o,o+n),()=>{});
      expect([...decoded.cloud.positions]).toEqual([payload.readFloatLE(0),2,3]);
      const truncated=bytes.slice(0,-1);
      await expect(readCloud({name:'truncated.pcd',bytes:truncated},'m',async(o,n)=>truncated.slice(o,o+n),()=>{})).rejects.toThrow('载荷不完整');
    }
  });
  it("按字段布局读取二进制 PCD，保留全部点和原始 packed RGB", async () => {
    const header = Buffer.from("VERSION .7\nFIELDS x y z rgb normal_x\nSIZE 4 4 4 4 4\nTYPE F F F U F\nCOUNT 1 1 1 1 1\nWIDTH 3\nHEIGHT 1\nPOINTS 3\nDATA binary\n");
    const payload = Buffer.alloc(60);
    for (let i = 0; i < 3; i++) { payload.writeFloatLE(i * 1000, i * 20); payload.writeFloatLE(2000, i * 20 + 4); payload.writeFloatLE(3000, i * 20 + 8); payload.writeUInt32LE(0xff0044 + i, i * 20 + 12); }
    const bytes = Buffer.concat([header, payload]);
    const value = await readCloud({ name: "test.pcd", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, "mm", async (offset, size) => bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + size), () => {});
    expect(value.cloud.visible.length).toBe(3); expect([...value.cloud.positions]).toEqual([0, 2, 3, 1, 2, 3, 2, 2, 3]); expect([...value.preview.colors]).toEqual([255, 0, 68, 255, 0, 69, 255, 0, 70]);
    await expect(readCloud({ name: "bad.pcd", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - 1) }, "m", async (offset, size) => bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + size), () => {})).rejects.toThrow("不完整");
  });
  it("流式工程保留原件哈希/扩展字段，拒绝损坏；取消保存不覆盖旧目标", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "survey-stream-test-")), store = new SourceStore();
    try {
      const original = path.join(folder, "source.pcd"), project = path.join(folder, "data.pvplan");
      const bytes = Buffer.alloc(17 * 1024 ** 2, 83); bytes.write("all original fields retained", 0); await writeFile(original, bytes);
      const source = await store.register(original);
      expect((await store.read(source.token, bytes.length - 4, 4)).byteLength).toBe(4);
      await expect(store.read(source.token, 0, 9 * 1024 ** 2)).rejects.toThrow("无效");
      const state = { source: { units: "m", synthetic: false }, projection: "xy", settings: {}, annotations: [] };
      await store.saveProject(source.token, project, state);
      const restored = await store.openProject(project);
      expect(restored.native.sha256).toBe(source.sha256); expect(restored.native.size).toBe(bytes.length);
      expect(Buffer.from(await store.read(restored.native.token, 0, 28)).toString()).toContain("all original fields");
      const keep = path.join(folder, "keep.pvplan"); await writeFile(keep, "previous verified project");
      const abort = new AbortController();
      await expect(store.saveProject(source.token, keep, state, { signal: abort.signal, progress: () => abort.abort() })).rejects.toThrow();
      expect(await readFile(keep, "utf8")).toBe("previous verified project"); expect((await readdir(folder)).some((f: string) => f.endsWith(".part"))).toBe(false);
      await store.release(restored.native.token);
      const file = await open(project, "r+"); const stat = await file.stat(); await file.write(Buffer.from([0]), 0, 1, stat.size - 1); await file.close();
      await expect(store.openProject(project)).rejects.toThrow("SHA256");
      await expect(store.saveProject(source.token, original, state)).rejects.toThrow("覆盖");
    } finally { await store.close(); await rm(folder, { recursive: true, force: true }); }
  });
});
