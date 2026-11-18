import { expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { strFromU8, unzipSync } from "fflate";
import { appendDimension } from "../../src/cad/dimensions";
import { cadSheet } from "../../src/cad/sheet";
import { createMultiViewDrawing } from "../../src/cad/multiView";
import { CAD_MANUAL_CONNECTION, validateDrawingModel } from "../../src/cad/model";
import { decodeSource } from "../src/pipeline/analysis";
import { generateDrawing } from "../src/pipeline/analysis";
import { createMultiViewSurveyDelivery, renderMultiViewPdf } from "../src/domain/multiViewDelivery";
import {generateLargeDrawing} from '../src/pipeline/largeDrawing';
import type {PointCloudData} from '../../src/domain/types';
import { demoRoom } from "../src/domain/demo";

it("三视图共用同一来源，整体编辑后交付一个总图 DXF 和单页 PDF", async () => {
  const bytes = demoRoom(), cloud = await decodeSource("room.pcd", bytes, "m");
  const models = {
    xy: generateDrawing(cloud, "room.pcd", "xy", { paperSize: "A3", scale: "1:100" }),
    xz: generateDrawing(cloud, "room.pcd", "xz", { paperSize: "A3", scale: "1:100" }),
    yz: generateDrawing(cloud, "room.pcd", "yz", { paperSize: "A3", scale: "1:100" }),
  };
  const sourceSha256=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");
  for(const model of Object.values(models))model.sourceSha256=sourceSha256;
  appendDimension(models.xy, { id: "manual-top", kind: "aligned", start: [0, 0], end: [1000, 0], linePoint: [500, 500], textHeightMm: 250, roundingMm: 1, unit: "m", source: "manual" });
  const wallIds = models.xy.entities.filter(entity => entity.category === "wall").map(entity => entity.id);
  models.xy.entities.push({ id: "manual-link", type: "line", start: [0, 0], end: [1000, 0], layer: "INFERRED_WALL", category: "wall", source: "manual", confidence: "confirmed", metadata: { operation: CAD_MANUAL_CONNECTION, startEntityId: wallIds[0]!, endEntityId: wallIds[1]! } });
  models.xy.warnings.push({ code: "MANUAL_WALL_CONNECTION", severity: "warning", message: "人工连线须复核。", relatedLayer: "INFERRED_WALL" });
  models.xy.statistics.inferredWallEntities++;
  const combined = createMultiViewDrawing(models);
  expect(validateDrawingModel(combined).errors).toEqual([]);
  expect(combined.dimensions?.map(dimension => dimension.id)).toContain("xy:manual-top");
  expect(combined.entities.some(entity => entity.id === "view-label-xz")).toBe(true);
  expect(combined.entities.some(entity => entity.id === "view-label-yz")).toBe(true);
  expect(combined.entities.find(entity => entity.id === "xy:manual-link")?.metadata).toMatchObject({ startEntityId: `xy:${wallIds[0]}`, endEntityId: `xy:${wallIds[1]}` });
  const plot=cadSheet(combined);expect(plot.outsideEntityIds).toEqual([]);expect(plot.titleOverlapEntityIds).toEqual([]);
  expect(combined.titleBlock.drawingName).toBe("建筑测绘三视总图");
  const originalLink=combined.entities.find(entity=>entity.id==='xy:manual-link');if(!originalLink||originalLink.type!=='line')throw Error('测试连线缺失');
  const edited={...combined,entities:combined.entities.map(entity=>entity.id==='xy:manual-link'&&entity.type==='line'?{...entity,start:[entity.start[0]+123,entity.start[1]] as [number,number]}:entity)};

  const file=new File([bytes],"room.pcd"),read=file.arrayBuffer.bind(file);let reads=0;
  file.arrayBuffer=()=>{reads++;return read();};
  const result = await createMultiViewSurveyDelivery(models, { name: "room.pcd", file, units: "m", synthetic: true }, async ({ widthMm, heightMm }) => {
    const pdf = await PDFDocument.create();
    pdf.addPage([widthMm * 72 / 25.4, heightMm * 72 / 25.4]);
    return pdf.save();
  },edited);
  expect(reads).toBe(1);
  const archive = unzipSync(result.archive);
  expect(Object.keys(archive).filter(name => name.endsWith(".dxf"))).toEqual(["survey-drawing/multiview.dxf"]);
  const pdf = await PDFDocument.load(archive["survey-drawing/multiview.pdf"]!);
  expect(pdf.getPageCount()).toBe(1);
  expect(strFromU8(archive["survey-drawing/multiview.dxf"]!)).toContain("xy:manual-link");
  expect(strFromU8(archive["survey-drawing/multiview.html"]!)).toContain("俯视图");
  expect(strFromU8(archive["survey-drawing/multiview.html"]!)).toContain("正视图");
  expect(strFromU8(archive["survey-drawing/multiview.html"]!)).toContain("侧视图");
  const annotations=JSON.parse(strFromU8(archive["survey-drawing/multiview.annotations.json"]!));
  expect(annotations.entities.find((entity:any)=>entity.id==='xy:manual-link').geometry.start_mm[0]).toBe(originalLink.start[0]+123);
  for (const projection of ["xy", "xz", "yz"]) expect(archive[`survey-drawing/${projection}/analysis.json`]).toBeTruthy();
  expect(archive["survey-drawing/review.json"]).toBeTruthy();
  expect(archive["survey-drawing/multiview.svg"]).toBeTruthy();
  const manifest = JSON.parse(strFromU8(archive["survey-drawing/multiview.manifest.json"]!)) as { views: Array<{ projection: string }>; pdfIncluded: boolean;pdfPageCount:number;editing:string; files: Array<{ name: string; size: number; sha256?: string }> };
  expect(manifest.views.map(view => view.projection)).toEqual(["xy", "xz", "yz"]);
  expect(manifest.pdfIncluded).toBe(true);expect(manifest.pdfPageCount).toBe(1);expect(manifest.editing).toBe('combined');
  for (const entry of manifest.files) {
    const data = archive[`survey-drawing/${entry.name}`]!;
    expect(data.byteLength).toBe(entry.size);
    if (entry.sha256) expect(Buffer.from(await crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer)).toString("hex")).toBe(entry.sha256);
  }
});

it("总图返回多页 PDF 时拒绝导出", async () => {
  const cloud = await decodeSource("room.pcd", demoRoom(), "m");
  const models = { xy: generateDrawing(cloud, "room.pcd", "xy", {}), xz: generateDrawing(cloud, "room.pcd", "xz", {}), yz: generateDrawing(cloud, "room.pcd", "yz", {}) };
  await expect(renderMultiViewPdf(models, async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([420, 297]); pdf.addPage([420, 297]); return pdf.save();
  })).rejects.toThrow("三视总图 PDF 应为单页");
  expect(()=>createMultiViewDrawing({...models,xy:{...models.xy,view:"front_xz" as const}})).toThrow("投影不一致");
  expect(()=>createMultiViewDrawing({...models,xz:{...models.xz,paperSize:"A4" as const}})).toThrow("图幅和比例必须一致");
});

it('范围外高树不阻断立面，正侧视仅交付四条外轮廓且不改原始点云',async()=>{
  const base=await decodeSource('room.pcd',demoRoom(),'m'),tree=[30,30,30,31,31,35];
  const positions=Float32Array.from([...base.positions,...tree]),visible=new Uint8Array(positions.length/3).fill(1);
  const cloud:PointCloudData={...base,positions,visible,colors:new Uint8Array(positions.length)},original=cloud.visible.slice();
  const decoded={cloud,preview:cloud,bounds:{min:[0,0,0] as [number,number,number],max:[31,31,35] as [number,number,number]}};
  const footprint={min:[-1,-1] as [number,number],max:[9,7] as [number,number]};
  for(const projection of ['xz','yz'] as const){
    const model=await generateLargeDrawing(decoded,'room.pcd',projection,{},()=>{},footprint),walls=model.entities.filter(entity=>entity.category==='wall');
    expect(walls).toHaveLength(4);expect(walls.every(entity=>entity.layer==='INFERRED_WALL'&&entity.source==='derived')).toBe(true);
    expect(model.sourceSummary.height).toBeLessThan(3);expect(model.parameters.analysisMode).toContain('outer-envelope');
    expect(model.warnings.some(warning=>warning.code==='ELEVATION_FOOTPRINT_FILTER')).toBe(true);
  }
  expect(cloud.visible).toEqual(original);expect(cloud.positions).toEqual(positions);
});

it('正侧视图区分标准推断外包络与高保真实测轮廓及室内立面投影',async()=>{
  const {validateDrawingModel}=await import('../../src/cad/model');
  const base=await decodeSource('room.pcd',demoRoom(),'m'),extra:number[]=[];
  for(let z=.2;z<=2.8;z+=.15)for(let t=0;t<=.55;t+=.03)extra.push(5+t,3,z,5,3+t,z);
  const positions=Float32Array.from([...base.positions,...extra]),visible=new Uint8Array(positions.length/3).fill(1);
  const cloud:PointCloudData={...base,positions,visible,colors:new Uint8Array(positions.length)};
  const decoded={cloud,preview:cloud,bounds:{min:[0,0,0] as [number,number,number],max:[8,6,3] as [number,number,number]}};
  const footprint={min:[-.2,-.2] as [number,number],max:[8.2,6.2] as [number,number]};

  for(const projection of ['xz','yz'] as const){
    const standard=await generateLargeDrawing(decoded,'room.pcd',projection,{},()=>{},footprint);
    expect(standard.entities.filter(e=>e.category==='wall')).toHaveLength(4);
    expect(standard.statistics.observedWallEntities).toBe(0);
    expect((standard.parameters as {wallFidelity?:string}).wallFidelity).toBe('architectural-outline');

    const highFidelity=await generateLargeDrawing(decoded,'room.pcd',projection,{autoCleanOutdoor:false,autoCleanIndoor:false},()=>{},footprint);
    expect(highFidelity.statistics.observedWallEntities).toBeGreaterThanOrEqual(1);
    expect(highFidelity.entities.some(e=>e.layer==='INFERRED_WALL'&&e.metadata?.operation==='elevation-interior-projection')).toBe(true);
    expect((highFidelity.parameters as {wallFidelity?:string}).wallFidelity).toBe('high-fidelity');
    expect(validateDrawingModel(highFidelity).valid).toBe(true);
  }
});
