import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisClient } from "../src/analysisClient";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  messages: object[] = [];
  terminated = false;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(data: object) { this.messages.push(data); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

describe("AnalysisClient 任务所有权", () => {
  beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); });
  afterEach(() => vi.unstubAllGlobals());

  it("取消后旧 Worker 的迟到结果不能完成新请求", async () => {
    const client = new AnalysisClient(() => {});
    const first = client.request<{ name: string }>({ action: "import" });
    client.cancel();
    await expect(first).rejects.toThrow("已取消分析");
    expect(FakeWorker.instances[0]!.terminated).toBe(true);

    let settled = false;
    const second = client.request<{ name: string }>({ action: "import" });
    void second.finally(() => { settled = true; });
    const oldWorker = FakeWorker.instances[0]!, currentWorker = FakeWorker.instances[1]!;
    oldWorker.emit({ id: 1, result: { name: "old" } });
    expect(settled).toBe(false);
    currentWorker.emit({ id: 2, result: { name: "current" } });
    await expect(second).resolves.toEqual({ name: "current" });
  });

  it("同一时刻拒绝重入，进度仅属于当前请求", async () => {
    const stages: string[] = [], client = new AnalysisClient(stage => stages.push(stage));
    const request = client.request({ action: "drawing" });
    await expect(client.request({ action: "clean" })).rejects.toThrow("已有分析任务");
    const worker = FakeWorker.instances[0]!;
    worker.emit({ id: 1, kind: "progress", stage: "提取墙线" });
    worker.emit({ id: 2, kind: "progress", stage: "过期进度" });
    expect(stages).toEqual(["提取墙线"]);
    worker.emit({ id: 1, result: { ok: true } });
    await expect(request).resolves.toEqual({ ok: true });
  });
});
