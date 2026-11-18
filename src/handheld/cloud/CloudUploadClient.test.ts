import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadPointCloud, validateCloudEndpoint, type UploadFile } from "./CloudUploadClient";
const file: UploadFile = { projectId: "project", name: "本地验收", fileName: "sample.pcd", bytes: 6, sha256: "a".repeat(64), points: 1 };
const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])]);
const config = { endpoint: "https://example.invalid", token: "test-token" };
const receipt = { state: "completed", objectId: "object-a", bytes: file.bytes, sha256: file.sha256, completedAt: "2026-10-14T00:00:00Z" };
afterEach(() => vi.unstubAllGlobals());
describe("云文件上传契约", () => {
  it("允许 HTTPS 和内网调试地址，拒绝明文公网、凭证 URL 和伪装内网的域名", () => {
    expect(validateCloudEndpoint("https://example.invalid/root/")).toBe("https://example.invalid/root");
    expect(validateCloudEndpoint("http://192.168.240.1:8788")).toBe("http://192.168.240.1:8788");
    for (const value of ["http://example.invalid", "http://10.example.invalid", "http://127.0.0.1.evil.invalid", "https://user:pass@example.invalid", "https://example.invalid?token=x"]) expect(() => validateCloudEndpoint(value)).toThrow();
  });
  it("从服务端已确认偏移续传原始字节，完成后才接受回执", async () => {
    const sent: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent.push(init);
      return new Response(JSON.stringify(sent.length === 1 ? { uploadId: "upload1", offset: 2, chunkSize: 2 }
        : sent.length === 2 ? { uploadId: "upload1", offset: 4 } : sent.length === 3 ? { uploadId: "upload1", offset: 6 } : receipt));
    }));
    const phases: string[] = [];
    const result = await uploadPointCloud(config, file, blob, new AbortController().signal, (phase, p) => phases.push(`${phase}:${p}`));
    expect(result.sha256).toBe(file.sha256); expect(result.endpoint).toBe(config.endpoint);
    expect([...new Uint8Array(await (sent[1]!.body as Blob).arrayBuffer())]).toEqual([3, 4]);
    expect((sent[1]!.headers as Record<string, string>)["Content-Range"]).toBe("bytes 2-3/6");
    expect(sent.every(s => s.redirect === "error" && s.credentials === "omit")).toBe(true);
    expect(phases.at(-1)).toBe("verifying:100"); expect(sent).toHaveLength(4);
  });
  it("相同内容已有完成回执时不重新发送文件", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ receipt })));
    vi.stubGlobal("fetch", fetch);
    await expect(uploadPointCloud(config, file, blob, new AbortController().signal, () => {})).resolves.toMatchObject({ state: "completed" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("不能把错误摘要的完成回执显示为已上云", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ receipt: { ...receipt, sha256: "b".repeat(64) } }))));
    await expect(uploadPointCloud(config, file, blob, new AbortController().signal, () => {})).rejects.toThrow("回执校验不一致");
  });
  it("暂停后终止请求并保留可继续的错误类型", async () => {
    const abort = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError"))))));
    const check = expect(uploadPointCloud(config, file, blob, abort.signal, () => {})).rejects.toMatchObject({ name: "AbortError" });
    abort.abort(); await check;
  });
  it("不接受错误偏移的分块确认", async () => {
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(++count === 1 ? { uploadId: "upload1", offset: 0, chunkSize: 6 } : { uploadId: "upload1", offset: 5 }))));
    await expect(uploadPointCloud(config, file, blob, new AbortController().signal, () => {})).rejects.toThrow("进度确认无效");
  });
});
