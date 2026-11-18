import { expect, it } from "vitest";
import { applyCadAnnotations, cadEntityPoints, validateDrawingModel } from "../../src/cad/model";
import { createCadConnection, manualCadConnections, openCadEndpoints, previewCadConnection, suggestCadConnections, withCadConnections } from "../../src/cad/connections";
import { createCadShape, deleteCadGeometry, moveCadGeometry, withCadEdits } from "../../src/cad/editing";
import { exportCadDxf } from "../../src/cad/dxf";
import { createCadSheet, restyleCadDrawing } from "../../src/cad/sheet";
import { decodeSource } from "../src/pipeline/analysis";
import { generateWallDrawing } from "../src/pipeline/wallLines";
import { gappedRoomPcd } from "./fixtures/gappedRoom";

it("人工端点连线更新拓扑、保留于标注和重样式，并进入 SVG/DXF", async () => {
  const cloud = await decodeSource("gapped.pcd", gappedRoomPcd(), "m");
  const model = await generateWallDrawing(cloud, "gapped.pcd", { alignToPrincipalAxis: false }, () => {});
  const endpoints = openCadEndpoints(model);
  expect(endpoints).toHaveLength(2);
  expect(() => createCadConnection(model, endpoints[0]!, endpoints[0]!)).toThrow("同一图元自身");
  expect(() => createCadConnection(model, { ...endpoints[0]!, point: [0, 0] }, endpoints[1]!)).toThrow("状态已变化");

  const line = createCadConnection(model, endpoints[0]!, endpoints[1]!);
  if (line.type !== "line") throw Error("预期直线连接");
  const connected = withCadConnections(model, [line]);
  expect(openCadEndpoints(connected)).toHaveLength(0);
  expect((connected.parameters as typeof model.parameters & { openEndpoints: number }).openEndpoints).toBe(0);
  expect(connected.warnings.find(warning => warning.code === "WALL_LINES_REVIEW")?.message).toContain("0 个未连接端点");
  expect(connected.warnings.find(warning => warning.code === "MANUAL_WALL_CONNECTION")?.message).toContain("1 条人工连接墙线");
  expect(line).toMatchObject({ source: "manual", confidence: "confirmed", layer: "INFERRED_WALL" });
  expect(connected.titleBlock.evidenceNote).toContain("1 条人工端点连线");
  expect(validateDrawingModel(connected).valid).toBe(true);
  expect(openCadEndpoints(connected,layer=>layer!=="OBSERVED_WALL")).toHaveLength(0);
  const forged=structuredClone(connected),forgedLine=forged.entities.find(entity=>entity.id===line.id);
  if(forgedLine){forgedLine.source="observed";forgedLine.confidence="measured";forgedLine.layer="OBSERVED_WALL";}
  expect(validateDrawingModel(forged).valid).toBe(false);
  const missingReference=structuredClone(connected),invalidLine=missingReference.entities.find(entity=>entity.id===line.id);
  if(invalidLine)delete invalidLine.metadata!.startEntityId;
  expect(validateDrawingModel(missingReference).valid).toBe(false);
  const missingWarning=structuredClone(connected);missingWarning.warnings=missingWarning.warnings.filter(warning=>warning.code!=="MANUAL_WALL_CONNECTION");
  expect(validateDrawingModel(missingWarning).valid).toBe(false);

  const annotated = applyCadAnnotations(connected, [{ id: "review", text: "连线复核", x: line.start[0], y: line.start[1], coordinateSpace: "drawing-mm", projection: "xy" }]);
  expect(manualCadConnections(annotated)).toEqual([line]);
  const restyled = restyleCadDrawing(annotated, { paperSize: "A2" });
  expect(manualCadConnections(restyled)).toHaveLength(1);
  expect(manualCadConnections(restyled)[0]).toMatchObject({ start: line.start, end: line.end });
  expect(validateDrawingModel(restyled).valid).toBe(true);
  expect(createCadSheet(restyled).svg).toContain(`data-entity-id="${line.id}"`);
  const dxf = new TextDecoder().decode(exportCadDxf(restyled));
  expect(dxf).toContain("INFERRED_WALL");
  expect(dxf).toContain(`1000\r\n${line.id}`);

  const undone = withCadConnections(restyled, []);
  expect(openCadEndpoints(undone)).toHaveLength(2);
  expect(undone.warnings.some(warning => warning.code === "MANUAL_WALL_CONNECTION")).toBe(false);
  expect(undone.warnings.find(warning => warning.code === "WALL_LINES_REVIEW")?.message).toContain("2 个未连接端点");
  expect(undone.titleBlock.evidenceNote).not.toContain("人工端点连线");
  expect(validateDrawingModel(undone).valid).toBe(true);
});

it("自动连接小缺口并保留真实圆、跨零圆弧和逐图元虚线", async () => {
  const cloud=await decodeSource("gapped.pcd",gappedRoomPcd(),"m"),model=await generateWallDrawing(cloud,"gapped.pcd",{alignToPrincipalAxis:false},()=>{});
  const shortened=structuredClone(model),ends=openCadEndpoints(shortened),a=ends[0]!,b=ends[1]!,dx=b.point[0]-a.point[0],dy=b.point[1]-a.point[1],length=Math.hypot(dx,dy),point:[number,number]=[b.point[0]-dx/length*100,b.point[1]-dy/length*100];
  const wall=shortened.entities.find(entity=>entity.id===a.entityId);
  if(wall?.type!=='line')throw Error('缺少测试墙线');
  if(wall.start[0]===a.point[0]&&wall.start[1]===a.point[1])wall.start=point;else wall.end=point;
  const suggestions=suggestCadConnections(shortened);
  expect(suggestions).toHaveLength(1);expect(suggestions[0]).toMatchObject({source:'inferred',confidence:'inferred'});
  const connected=withCadConnections(shortened,suggestions),center=connected.modelBoundsMm.min.map((value,index)=>(value+connected.modelBoundsMm.max[index]!)/2) as [number,number];
  const circle=createCadShape('circle',[center,[center[0]+100,center[1]]],'DASHED');
  const arc=createCadShape('arc',[center,[center[0],center[1]-100],[center[0]-100,center[1]]],'CONTINUOUS');
  const edited=withCadEdits(connected,[...connected.entities,circle,arc]);
  expect(cadEntityPoints(arc).some(point=>point[1]>center[1]+99)).toBe(true);
  const annotated=applyCadAnnotations(edited,[{id:'review',text:'几何复核',x:center[0],y:center[1],coordinateSpace:'drawing-mm',projection:'xy'}]);
  expect(annotated.entities.some(entity=>entity.id===circle.id)).toBe(true);expect(annotated.entities.some(entity=>entity.id===arc.id)).toBe(true);
  expect(validateDrawingModel(annotated).valid).toBe(true);
  const sheet=createCadSheet(annotated).svg;expect(sheet).toContain('<circle');expect(sheet).toContain('<path');
  const dxf=new TextDecoder().decode(exportCadDxf(annotated));expect(dxf).toContain('0\r\nCIRCLE');expect(dxf).toContain('0\r\nARC');expect(dxf).toContain('6\r\nDASHED');
});

function cornerGappedRoomPcd(): ArrayBuffer {
  const rows: string[] = [];
  const add = (x: number, y: number, z: number) => rows.push(`${x} ${y} ${z}`);
  for (let t = 0; t <= 8; t += .05) for (let z = 0; z <= 3; z += .1) { if (t >= 1) add(t, 0, z); add(t, 6, z); }
  for (let t = 0; t <= 6; t += .05) for (let z = 0; z <= 3; z += .1) { if (t >= 1) add(0, t, z); add(8, t, z); }
  const pcd = `VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\nPOINTS ${rows.length}\nDATA ascii\n${rows.join("\n")}\n`;
  return new TextEncoder().encode(pcd).buffer as ArrayBuffer;
}

it("垂直墙角支持外折90°、内折90°、直连、弧线连线与导出校验", async () => {
  const cloud = await decodeSource("corner.pcd", cornerGappedRoomPcd(), "m");
  const model = await generateWallDrawing(cloud, "corner.pcd", { alignToPrincipalAxis: false }, () => {});
  const endpoints = openCadEndpoints(model);
  expect(endpoints).toHaveLength(2);
  const a = endpoints[0]!, b = endpoints[1]!;

  // 默认智能判定对垂直墙角自动选中外折 90°（向外部交点拐角延伸）
  const outer = createCadConnection(model, a, b);
  expect(outer.type).toBe("polyline");
  if (outer.type !== "polyline") throw Error("expected polyline");
  expect(outer.points).toHaveLength(3);
  const outerCorner = outer.points[1]!;
  expect(Math.hypot(outerCorner[0], outerCorner[1])).toBeLessThan(300);

  const inner = createCadConnection(model, a, b, "inner90");
  expect(inner.type).toBe("polyline");
  if (inner.type !== "polyline") throw Error("expected inner polyline");
  expect(inner.points[1]).not.toEqual(outerCorner);

  const direct = createCadConnection(model, a, b, "direct");
  expect(direct.type).toBe("line");

  const arc = createCadConnection(model, a, b, "arc");
  expect(arc.type).toBe("arc");
  expect(previewCadConnection(model, a, { point: b.point, entityId: "__preview__" }, "arc")?.type).toBe("arc");

  for (const entity of [outer, inner, direct, arc]) {
    const connected = withCadConnections(model, [entity]);
    expect(openCadEndpoints(connected)).toHaveLength(0);
    expect(validateDrawingModel(connected).valid).toBe(true);
    expect(manualCadConnections(connected)).toHaveLength(1);
    const svg = createCadSheet(connected).svg;
    expect(svg).toContain(`data-entity-id="${entity.id}"`);
    const dxf = new TextDecoder().decode(exportCadDxf(connected));
    expect(dxf).toContain(`1000\r\n${entity.id}`);
  }

  // 移动或删除连接墙段时，折线/圆弧连线保持拓扑同步
  const withOuter = withCadConnections(model, [outer]);
  const movedOuter = moveCadGeometry(withOuter, a.entityId, 50, 0);
  const movedPoly = manualCadConnections(movedOuter)[0]!;
  expect(movedPoly.type).toBe("polyline");
  if (movedPoly.type === "polyline") {
    const seg1 = [movedPoly.points[1]![0] - movedPoly.points[0]![0], movedPoly.points[1]![1] - movedPoly.points[0]![1]];
    expect(Math.abs(seg1[0]!) < 1e-3 || Math.abs(seg1[1]!) < 1e-3).toBe(true);
  }
  const deletedOuter = deleteCadGeometry(withOuter, [a.entityId]);
  expect(manualCadConnections(deletedOuter)).toHaveLength(0);
});
