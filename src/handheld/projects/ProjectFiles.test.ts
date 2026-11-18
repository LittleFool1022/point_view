import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProject } from "./ProjectFiles";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("项目完整文件下载", () => {
  it("明确区分未部署接口和项目文件不存在", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "接口不存在" }), { status: 404 })));
    await expect(fetchProject("http://device", "scan", false, new AbortController().signal, () => {})).rejects.toThrow("设备下载服务尚未就绪");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "项目文件不可用" }), { status: 404 })));
    await expect(fetchProject("http://device", "scan", false, new AbortController().signal, () => {})).rejects.toThrow("设备上未找到该项目文件");
  });

  it("下载进度来自真实字节，完整文件内容不被采样", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5, 6])); controller.close();
    } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "Content-Length": "6" } })));
    const progress = vi.fn();
    const blob = await fetchProject("http://device", "scan", false, new AbortController().signal, progress);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.mock.calls).toEqual([[50, 3, 6], [100, 6, 6]]);
  });

  it("等待响应超时后提供可读提示", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
    })));
    const check = expect(fetchProject("http://device", "scan", false, new AbortController().signal, () => {})).rejects.toThrow("设备响应超时");
    await vi.advanceTimersByTimeAsync(10000); await check;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("有数据到达时可继续下载超过 20 秒的大文件", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        options.signal.addEventListener("abort", () => { if (options.signal.aborted) { try { controller.error(new DOMException("cancelled", "AbortError")); } catch {} } });
        for (let i = 1; i <= 3; i++) setTimeout(() => controller.enqueue(new Uint8Array([i])), i * 9000);
        setTimeout(() => controller.close(), 36000);
      } });
      return Promise.resolve(new Response(stream, { headers: { "Content-Length": "3" } }));
    }));
    const result = fetchProject("http://device", "scan", false, new AbortController().signal, () => {});
    await vi.advanceTimersByTimeAsync(36000);
    expect([...new Uint8Array(await (await result).arrayBuffer())]).toEqual([1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("用户取消正在接收的文件后立即停止传输并清除等待计时器", async () => {
    vi.useFakeTimers();
    const cancel = new AbortController();
    let stopped = false;
    vi.stubGlobal("fetch", vi.fn((_url, options) => Promise.resolve(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1]));
      options.signal.addEventListener("abort", () => { stopped = true; controller.error(new DOMException("cancelled", "AbortError")); });
    } }), { headers: { "Content-Length": "2" } }))));
    const check = expect(fetchProject("http://device", "scan", false, cancel.signal, () => cancel.abort())).rejects.toMatchObject({ name: "AbortError" });
    await check;
    expect(stopped).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("流停滞 20 秒后结束等待并允许重试", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options) => Promise.resolve(new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener("abort", () => controller.error(new DOMException("cancelled", "AbortError")));
    } }), { headers: { "Content-Length": "1" } }))));
    const check = expect(fetchProject("http://device", "scan", false, new AbortController().signal, () => {})).rejects.toThrow("下载长时间无进展");
    await vi.advanceTimersByTimeAsync(20000); await check;
    expect(vi.getTimerCount()).toBe(0);
  });
});
