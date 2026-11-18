import { afterEach, describe, expect, it, vi } from "vitest";
import { controlUrlFromPreview, OmniControlClient, UNKNOWN_DEVICE_STATUS, updateScanPointTotal } from "./OmniControlClient";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("扫描累计点数", () => {
  const active = { ...UNKNOWN_DEVICE_STATUS, reachable: true, session: "scan_a" };
  it("以主机地图总量更新，不把连续状态重复相加", () => {
    const first = updateScanPointTotal({ session: null, points: null }, { ...active, accumulatedPoints: 100_000 });
    expect(updateScanPointTotal(first, { ...active, accumulatedPoints: 100_000 }).points).toBe(100_000);
    expect(updateScanPointTotal(first, { ...active, accumulatedPoints: 200_000 }).points).toBe(200_000);
  });
  it("同会话断线或缺报保留统计，下一会话缺报不能沿用旧数量", () => {
    const previous = { session: "scan_a", points: 100_000 };
    expect(updateScanPointTotal(previous, { ...active, reachable: false, accumulatedPoints: 0 })).toEqual(previous);
    expect(updateScanPointTotal(previous, active)).toEqual(previous);
    expect(updateScanPointTotal(previous, { ...active, session: "scan_b" })).toEqual({ session: "scan_b", points: null });
  });
  it("零点有效，缺失与非法统计不会伪造总量", () => {
    expect(updateScanPointTotal({ session: null, points: null }, { ...active, accumulatedPoints: 0 }).points).toBe(0);
    expect(updateScanPointTotal({ session: null, points: null }, { ...active, accumulatedPoints: -1 }).points).toBeNull();
  });
  it("新扫描预检阶段忽略残留状态目录的旧点数", () => {
    const reset = { session: null, points: 0 };
    expect(updateScanPointTotal(reset, { ...active, accumulatedPoints: 999_999,
      job: { id: "new", action: "start", expected_session: null, state: "running", started_at_ms: 1, finished_at_ms: null, exit_code: null, message: "启动中" } })).toEqual(reset);
  });
});

describe("OMNI 控制地址", () => {
  it("从预览主机派生独立控制端口", () => {
    expect(controlUrlFromPreview("ws://10.42.0.1:8765/")).toBe("http://10.42.0.1:8766");
    expect(controlUrlFromPreview("wss://omni.example/bridge")).toBe("https://omni.example:8766");
  });

  it("开发代理保持同源并切换到控制路径", () => {
    expect(controlUrlFromPreview("ws://127.0.0.1:5174/omni-preview")).toBe("http://127.0.0.1:5174/omni-control");
  });
});

describe("Waydroid 只读验收", () => {
  it("等待主机超过 5 秒的状态响应", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { search: "?readonly=1" });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("请求超时")));
      setTimeout(() => resolve({ ok: true, json: async () => UNKNOWN_DEVICE_STATUS }), 5500);
    })));
    const result = new OmniControlClient().status("http://10.42.0.1:8766");
    const assertion = expect(result).resolves.toMatchObject({ state: "unknown" });
    await vi.advanceTimersByTimeAsync(5500);
    await assertion;
  });

  it("状态请求无响应时在 6.5 秒释放，动作请求仍保留 20 秒窗口", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("请求超时")));
    })));
    const client = new OmniControlClient();
    const status = expect(client.status("http://device:8766")).rejects.toThrow("请求超时");
    const action = expect(client.action("http://device:8766", "start")).rejects.toThrow("请求超时");
    await vi.advanceTimersByTimeAsync(6500);
    await status;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(13500);
    await action;
  });

  it("禁止发送任何设备动作", async () => {
    vi.stubGlobal("location", { search: "?readonly=1" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new OmniControlClient();
    for (const action of ["start", "pcd", "stop"] as const) {
      await expect(client.action("http://10.42.0.1:8766", action)).rejects.toThrow("只读连接测试");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("保留真实状态并关闭自动启动条件", async () => {
    vi.stubGlobal("location", { search: "?readonly=1" });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...UNKNOWN_DEVICE_STATUS, reachable: true, state: "idle", actionsAllowed: true }),
    }));
    const status = await new OmniControlClient().status("http://10.42.0.1:8766");
    expect(status).toMatchObject({ reachable: true, state: "idle", actionsAllowed: false });
  });
});
