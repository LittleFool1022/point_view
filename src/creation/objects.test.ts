import { describe, expect, it } from "vitest";
import { createObject, pointBounds, projectedSelection, subjectBounds } from "./objects";
import { parsePcd } from "../domain/pcd";
import type { PointCloudData } from "../domain/types";
import { linearColors, surfaceGeometry } from "./materials";
import type { SurfaceMesh } from "./types";
import { exportObjectPly } from "./ply";

const makeCloud = (positions: number[]): PointCloudData => ({ id: "source", stampNs: 0n, frameId: "map", positions: Float32Array.from(positions), colors: new Uint8Array(positions.length).fill(128), visible: new Uint8Array(positions.length / 3).fill(1), attributes: { hasColor: true, hasIntensity: false } });
describe("物体数据契约", () => {
  it("主体取景不被少量远处点拉远，仍保留全部点及源坐标", () => {
    const positions = Array.from({ length: 1000 }, (_, i) => [i % 10, Math.floor(i / 10) % 10, Math.floor(i / 100)]).flat();
    positions.push(1000, 2000, 3000);
    const cloud = makeCloud(positions), before = cloud.positions.slice();
    const full = pointBounds(cloud), subject = subjectBounds(cloud, full);
    expect(subject.center).toEqual([4.5, 4.5, 4.5]);
    expect(full.max).toEqual([1000, 2000, 3000]);
    expect(cloud.visible.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(cloud.positions).toEqual(before);
  });
  it("连续场景和退化点云使用完整边界，不产生无效取景", () => {
    const cloud = makeCloud(Array.from({ length: 1000 }, (_, i) => [i, 0, 0]).flat());
    const full = pointBounds(cloud);
    expect(subjectBounds(cloud, full)).toBe(full);
    const coincident = makeCloud(Array(300).fill(3)), bounds = pointBounds(coincident);
    expect(subjectBounds(coincident, bounds)).toBe(bounds);
  });
  it("无颜色原貌附件不写占位 RGB，保留源索引与坐标信息", () => {
    const cloud = makeCloud([10,20,30, 12,20,30, 10,24,36]);
    cloud.attributes!.hasColor = false;
    const asset = createObject(cloud, [0,1,2], "raw.pcd");
    const bytes = exportObjectPly(asset), text = new TextDecoder().decode(bytes);
    expect(text).toContain("property uint source_index");
    expect(text).toContain('"originZUp":[11,22,33]');
    expect(text).not.toContain("property uchar red");
    const headerSize = new TextEncoder().encode(text.split("end_header\n")[0] + "end_header\n").length;
    expect(new DataView(bytes.buffer).getUint32(headerSize + 16 + 12, true)).toBe(1);
  });
  it("完整投影选取包含未渲染点，排除隐藏、非有限与视锥外点", () => {
    const cloud = makeCloud([0,0,0, .2,.2,.2, .3,.3,.3, 0,0,2, NaN,0,0]); cloud.visible[2] = 0;
    const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    expect(projectedSelection(cloud, identity, [-.5,.5,-.5,.5])).toEqual([0,1]);
    expect([...projectedSelection(cloud, identity, [-.5,.5,-.5,.5],0,1), ...projectedSelection(cloud, identity, [-.5,.5,-.5,.5],1,5)]).toEqual([0,1]);
  });
  it("局部原点和源索引可恢复世界位置，不更改原始数据", () => {
    const cloud = makeCloud([10,20,30, 12,20,30, 10,24,36, NaN,0,0]);
    cloud.sourcePointIndices = Uint32Array.from([2,4,8,9]); cloud.sourcePointCount = 10;
    const object = createObject(cloud, [0,1,2,3], "scan.pcd");
    expect(object.origin).toEqual([11,22,33]); expect([...object.sourceIndices]).toEqual([2,4,8]);
    expect(object.source.sampled).toBe(true);
    for (let i=0;i<9;i++) expect(object.cloud.positions[i]! + object.origin[i%3]!).toBe(cloud.positions[i]);
    object.cloud.positions[0] = 0; expect(cloud.positions[0]).toBe(10);
  });
  it("PCD 超限采样保留可重放的原文件点号", () => {
    const text = "VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 5\nHEIGHT 1\nPOINTS 5\nDATA ascii\n0 0 0\n1 0 0\n2 0 0\n3 0 0\n4 0 0\n";
    const cloud = parsePcd(new TextEncoder().encode(text).buffer, "test", { maxPoints: 3 });
    expect([...cloud.sourcePointIndices!]).toEqual([0,2,4]);
    expect(cloud.attributes?.hasColor).toBe(false);
  });
  it("纯色材质副本无 COLOR_0，原始颜色仍保留并按 sRGB 转线性", () => {
    const mesh = { positions: new Float32Array(9), normals: new Float32Array(9), colors: new Uint8Array(9).fill(128), indices: Uint32Array.from([0,1,2]) } as SurfaceMesh;
    const solid = surfaceGeometry(mesh, false), original = surfaceGeometry(mesh, true);
    expect(solid.hasAttribute("color")).toBe(false); expect(original.getAttribute("color").getX(0)).toBeCloseTo(.21586,4);
    expect(mesh.colors[0]).toBe(128); expect(linearColors(Uint8Array.from([0,255]))).toEqual(Float32Array.from([0,1]));
    solid.dispose(); original.dispose();
  });
});
