import { describe, expect, it } from "vitest";
import { applyEdit } from "./edits";
import type { EditOperation, PointCloudData } from "./types";

const source: PointCloudData = {
  id: "edit", frameId: "map", stampNs: 0n,
  positions: new Float32Array([0, 0, 0, 1, 2, 3]),
  colors: new Uint8Array([100, 100, 100, 200, 200, 200]),
  visible: new Uint8Array([1, 1]),
};

const op = (partial: Partial<EditOperation>): EditOperation => ({ id: "op", kind: "hide", indices: [], createdAt: "2026-08-03T00:00:00Z", ...partial });

describe("非破坏编辑", () => {
  it("隐藏不会修改源点云", () => {
    const next = applyEdit(source, op({ indices: [1] }));
    expect([...next.visible]).toEqual([1, 0]);
    expect([...source.visible]).toEqual([1, 1]);
  });

  it("对选择点应用 4x4 平移", () => {
    const next = applyEdit(source, op({ kind: "transform", indices: [1], payload: { matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 4,5,6,1] } }));
    expect([...next.positions]).toEqual([0, 0, 0, 5, 7, 9]);
  });
});
