import { expect, it } from "vitest";
import type { PointCloudData } from "../../src/domain/types";
import { applyClips, type ClipRule } from "../src/domain/cleaning";
import { fitWallLines } from "../src/pipeline/wallLines";
import { encodeProject, decodeProject } from "../src/domain/project";
import { demoRoom } from "../src/domain/demo";
const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
it("清理作用于全部源点，撤销恢复；工程保留规则且拒绝非法投影", async () => {
  const cloud: PointCloudData = { id: "test", frameId: "source", stampNs: 0n, positions: new Float32Array([-.8,0,0, 0,0,0, .8,0,0, 0,0,3]), colors: new Uint8Array(12), visible: new Uint8Array(4).fill(1) };
  const keep: ClipRule = { matrix: identity, rect: [-.5,-.5,.5,.5], mode: "keep" };
  expect(applyClips(cloud, [keep])).toBe(1); expect([...cloud.visible]).toEqual([0,1,0,0]);
  expect(applyClips(cloud, [])).toBe(4);
  expect(applyClips(cloud, [{ ...keep, mode: "remove" }])).toBe(3);
  expect(() => applyClips(cloud, [{ ...keep, matrix: [NaN] }])).toThrow("清理记录无效");
  const archive = await encodeProject({ source: { name: "test.pcd", units: "m", synthetic: true, bytes: demoRoom(), clips: [keep] }, annotations: [], settings: {}, projection: "xy" });
  expect((await decodeProject(archive.slice().buffer as ArrayBuffer)).source.clips).toEqual([keep]);
});
it("旋转房间的直线拟合满足已知尺寸，门洞不被强制封闭；移除范围不参与拟合", async () => {
  const p: number[] = [], angle = .23, cs = Math.cos(angle), sn = Math.sin(angle);
  const add = (x: number, y: number, z: number) => p.push(x * cs - y * sn, x * sn + y * cs, z);
  for (let t = 0; t <= 8; t += .025) for (let z = 0; z < 3; z += .08) { if (t < 3 || t > 4) add(t, 0, z); add(t, 6, z); }
  for (let t = 0; t <= 6; t += .025) for (let z = 0; z < 3; z += .08) { add(0, t, z); add(8, t, z); }
  const cloud: PointCloudData = { id: "known", frameId: "source", stampNs: 0n, positions: Float32Array.from(p), colors: new Uint8Array(p.length), visible: new Uint8Array(p.length / 3).fill(1) };
  const result = await fitWallLines(cloud, () => {});
  const lengths = result.segments.map(s => Math.hypot(s.b[0]-s.a[0],s.b[1]-s.a[1]));
  expect(lengths.some(l => Math.abs(l - 8) < .12)).toBe(true);
  expect(lengths.filter(l => Math.abs(l - 6) < .12).length).toBe(2);
  expect(result.segments).toHaveLength(5);
  expect(lengths.filter(l => l > 2.8 && l < 4.2)).toHaveLength(2);
  expect(result.segments.every(s => s.rmsM < .04)).toBe(true);
});

it("尺寸链与全量来源摘要一致，闭合标准房间保留8m/6m已知尺寸", async () => {
  const { decodeSource } = await import("../src/pipeline/analysis");
  const { generateWallDrawing } = await import("../src/pipeline/wallLines");
  const { validateDrawingModel } = await import("../../src/cad/model");
  const cloud = await decodeSource("room.pcd", demoRoom(), "m");
  const model = await generateWallDrawing(cloud, "room.pcd", {}, () => {});
  const labels = model.entities.filter(e => e.layer === "DIM" && e.type === "text").map(e => e.type === "text" ? Number(e.text) : 0);
  expect(labels.some(n => Math.abs(n-8000) < 60)).toBe(true);
  expect(labels.some(n => Math.abs(n-6000) < 60)).toBe(true);
  expect(model.sourceSummary.pointCount).toBe(cloud.visible.length);
  expect(model.sourceSummary.height).toBeCloseTo(2.4, 5);
  expect((model.parameters as any).openEndpoints).toBe(0);
  expect(model.statistics.observedWallEntities).toBe(4);
  expect(validateDrawingModel(model).valid).toBe(true);
});

it("建筑主轴旋正保持实测墙长和可逆坐标，尺寸使用水平垂直方向", async () => {
  const {generateWallDrawing}=await import('../src/pipeline/wallLines');
  const p:number[]=[],angle=.23,cs=Math.cos(angle),sn=Math.sin(angle);
  const add=(x:number,y:number,z:number)=>p.push(x*cs-y*sn,x*sn+y*cs,z);
  for(let t=0;t<=8;t+=.025)for(let z=0;z<3;z+=.08){if(t<3||t>4)add(t,0,z);add(t,6,z);}
  for(let t=0;t<=6;t+=.025)for(let z=0;z<3;z+=.08){add(0,t,z);add(8,t,z);}
  const cloud:PointCloudData={id:'rotated',frameId:'source',stampNs:0n,positions:Float32Array.from(p),colors:new Uint8Array(p.length),visible:new Uint8Array(p.length/3).fill(1)};
  const source=await generateWallDrawing(cloud,'rotated.pcd',{alignToPrincipalAxis:false},()=>{});
  const aligned=await generateWallDrawing(cloud,'rotated.pcd',{alignToPrincipalAxis:true},()=>{});
  const lines=(m:typeof source)=>m.entities.filter(e=>e.category==='wall'&&e.type==='line');
  const raw=lines(source),wall=lines(aligned),rotation=aligned.parameters.planAlignment!.angleRadians;
  expect(rotation).toBeCloseTo(-angle,2);expect(aligned.parameters.alignToPrincipalAxis).toBe(true);
  for(let i=0;i<raw.length;i++){
    const a=raw[i]!,b=wall[i]!;if(a.type!=='line'||b.type!=='line')throw Error('missing wall');
    expect(Math.hypot(b.end[0]-b.start[0],b.end[1]-b.start[1])).toBeCloseTo(Math.hypot(a.end[0]-a.start[0],a.end[1]-a.start[1]),7);
    const restore=(p:number[])=>[p[0]!*Math.cos(rotation)+p[1]!*Math.sin(rotation),-p[0]!*Math.sin(rotation)+p[1]!*Math.cos(rotation)];
    expect(restore(b.start)[0]).toBeCloseTo(a.start[0],7);expect(restore(b.start)[1]).toBeCloseTo(a.start[1],7);
  }
  const longest=wall.sort((a,b)=>a.type==='line'&&b.type==='line'?Math.hypot(b.end[0]-b.start[0],b.end[1]-b.start[1])-Math.hypot(a.end[0]-a.start[0],a.end[1]-a.start[1]):0)[0]!;
  if(longest.type!=='line')throw Error('missing wall');expect(Math.min(Math.abs(longest.end[0]-longest.start[0]),Math.abs(longest.end[1]-longest.start[1]))).toBeLessThan(1e-6);
  expect(aligned.dimensions!.every(d=>d.kind==='horizontal'||d.kind==='vertical')).toBe(true);
  expect(aligned.statistics.observedWallEntities).toBe(source.statistics.observedWallEntities);
});
