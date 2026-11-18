import { describe, expect, it } from "vitest";
import { PreviewDiscoveryBudget } from "./PreviewDiscoveryBudget";

describe("启动预览发现预算", () => {
  it("session 已重连时计作首次，最多安排一次补充发现", () => {
    const budget = new PreviewDiscoveryBudget();
    const seed = { sourceReconnected: true, connectionGeneration: 4 };
    expect(budget.observe("A", seed, 4, "connecting")).toBe("wait");
    expect(budget.observe("A", seed, 4, "connected")).toBe("check");
    expect(budget.observe("A", seed, 6, "connected")).toBe("wait");
    expect(budget.observe("A", { sourceReconnected: false, connectionGeneration: 6 }, 6, "connected")).toBe("wait");
  });

  it("没有 source 不计费，后续正常自动连接可作为首次", () => {
    const budget = new PreviewDiscoveryBudget();
    const seed = { sourceReconnected: false, connectionGeneration: 1 };
    expect(budget.observe("A", seed, 1, "offline")).toBe("discover");
    expect(budget.observe("A", seed, 1, "offline")).toBe("discover");
    expect(budget.observe("A", seed, 3, "connecting")).toBe("wait");
    expect(budget.observe("A", seed, 3, "connected")).toBe("check");
    budget.cancel();
    expect(budget.observe("A", seed, 5, "connected")).toBe("wait");
    expect(budget.observe("B", seed, 5, "connected")).toBe("check");
    expect(budget.matches("A")).toBe(false);
  });

  it("显式发现只计一次，取消不重新补预算", () => {
    const budget = new PreviewDiscoveryBudget();
    const seed = { sourceReconnected: false, connectionGeneration: 1 };
    expect(budget.observe("A", seed, 1, "offline")).toBe("discover");
    budget.created();
    expect(budget.observe("A", seed, 3, "connected")).toBe("check");
    budget.cancel();
    expect(budget.observe("A", seed, 5, "connected")).toBe("wait");
  });
});
