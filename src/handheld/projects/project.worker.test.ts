import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const count = 1_000_005;
const scope = {
  onmessage: undefined as undefined | ((event: { data: { blob: Blob; id: string; expectedSha?: string; maxPoints?: number | null } }) => Promise<void>),
  postMessage: vi.fn(),
};
let blob: Blob;

beforeAll(async () => {
  const header = `VERSION .7\nFIELDS x y z rgb intensity\nSIZE 4 4 4 4 4\nTYPE F F F U F\nCOUNT 1 1 1 1 1\nWIDTH ${count}\nHEIGHT 1\nPOINTS ${count}\nDATA binary\n`;
  const data = new ArrayBuffer(count * 20);
  const view = new DataView(data);
  view.setFloat32((count - 1) * 20, count - 1, true);
  blob = new Blob([header, data]);
  vi.stubGlobal("self", scope);
  await import("./project.worker");
});
afterAll(() => vi.unstubAllGlobals());

describe("本机项目显示点量", () => {
  it("默认读取 100 万点，并保留原始点量和首尾对应关系", async () => {
    scope.postMessage.mockClear();
    await scope.onmessage!({ data: { blob, id: "local" } });
    const [result, options] = scope.postMessage.mock.calls[0]!;
    expect(result.cloud.visible.length).toBe(1_000_000);
    expect(result.cloud.sourcePointCount).toBe(count);
    expect(result.cloud.positions.at(-3)).toBe(count - 1);
    expect(options.transfer).toContain(result.cloud.intensities.buffer);
    expect(options.transfer).toContain(result.cloud.sourcePointIndices.buffer);
    expect(blob.size).toBeGreaterThan(count * 20);
  });

  it("全部点不再受 12 万点或默认 100 万点上限限制", async () => {
    scope.postMessage.mockClear();
    await scope.onmessage!({ data: { blob, id: "full", maxPoints: null } });
    const [result] = scope.postMessage.mock.calls[0]!;
    expect(result.cloud.visible.length).toBe(count);
    expect(result.cloud.sourcePointIndices).toBeUndefined();
  });

  it("切换点量不能绕过完整文件 SHA256 校验", async () => {
    scope.postMessage.mockClear();
    await scope.onmessage!({ data: { blob, id: "full", maxPoints: null, expectedSha: "0".repeat(64) } });
    expect(scope.postMessage.mock.calls[0]![0]).toMatchObject({ error: "文件校验失败，请重新下载" });
  });
});
