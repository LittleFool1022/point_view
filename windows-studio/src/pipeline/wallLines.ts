import {STUDIO_VERSION} from "../version";
import {restyleCadDrawing} from "../../../src/cad/sheet";
import { appendDimension } from "../../../src/cad/dimensions";
import type { PointCloudData } from "../../../src/domain/types";
import type { CadDrawingSettings, DrawingModel } from "../../../src/cad/model";
import { generateDrawing } from "./analysis";
import { MAX_EXTENSION_M, OPENING_M, TIE_TOLERANCE_M, buildWallNetwork, type UnclosedEnd, type WallNetwork } from "./wallNetwork";
import { mergeWallSegments } from "./wallDedupe";
type P = [number, number];
/** 墙段；`sources` 为合并来源的原段编号，`merge` 为合并记录（未合并为 null），`dedupedIndex` 为去重输出段号。 */
export interface WallSegment { a: P; b: P; support: number; rmsM: number; sources?: number[]; merge?: { sourceIndexes: number[]; backboneIndex: number; projectionUnionM: [number, number]; coveredFraction: number } | null; dedupedIndex?: number }
const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 亚分米网格仅用于检索跨高度证据；输出几何来自证据质心拟合，不描格网边。 */
export async function fitWallLines(cloud: PointCloudData, progress: (s: string) => void) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, retained = 0;
  for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i]) { const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); minZ = Math.min(minZ, cloud.positions[i * 3 + 2]!); maxZ = Math.max(maxZ, cloud.positions[i * 3 + 2]!); retained++; }
  const cell = .06, nx = Math.ceil((maxX - minX) / cell) + 1, ny = Math.ceil((maxY - minY) / cell) + 1, n = nx * ny;
  if (!retained || n > 8_000_000) throw Error("建筑范围为空或过大，请先使用保留框内圈定建筑。");
  const counts = new Uint32Array(n), layers = new Uint32Array(n), xsum = new Float64Array(n), ysum = new Float64Array(n), low = new Float32Array(n).fill(Infinity), high = new Float32Array(n).fill(-Infinity);
  for (let i = 0; i < cloud.visible.length; i++) {
    if (!cloud.visible[i]) continue;
    const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!, z = cloud.positions[i * 3 + 2]!;
    const key = Math.floor((y - minY) / cell) * nx + Math.floor((x - minX) / cell);
    counts[key]++; xsum[key] += x; ysum[key] += y; low[key] = Math.min(low[key]!, z); high[key] = Math.max(high[key]!, z);
    // 25cm 高度层计数；模32只合并远隔8m的层，不增加层数。
    layers[key] |= 1 << ((Math.floor(z / .25) % 32 + 32) % 32);
    if (i % 1_000_000 === 0) { progress(`扫描跨高度墙体证据 ${Math.floor(i / cloud.visible.length * 100)}%`); await new Promise(r => setTimeout(r, 0)); }
  }
  let points: P[] = [];
  for (let i = 0; i < n; i++) if (counts[i]! >= 8 && high[i]! - low[i]! >= .8) {
    let bits = layers[i]!, occupied = 0; while (bits) { bits &= bits - 1; occupied++; }
    if (occupied >= 4) points.push([xsum[i]! / counts[i]!, ysum[i]! / counts[i]!]);
  }
  const evidenceCells = points.length;
  if (evidenceCells < 30) throw Error("跨高度墙体证据不足，请检查 Z 轴方向、清理范围及建筑数据。");
  if (evidenceCells > 100_000) throw Error("墙体候选区域过大，请分区出图，避免把整个场景拟合为建筑。");
  const segments: WallSegment[] = []; let seed = 1234567;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const tolerance = .045;
  for (let round = 0; round < 60 && points.length >= 16; round++) {
    let best: { a: P; ux: number; uy: number; score: number } | undefined;
    for (let t = 0; t < 160; t++) {
      const a = points[Math.floor(random() * points.length)]!, b = points[Math.floor(random() * points.length)]!, length = distance(a, b);
      if (length < .8) continue;
      const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length; let score = 0;
      for (const p of points) if (Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) <= tolerance) score++;
      if (score > (best?.score ?? 15)) best = { a, ux, uy, score };
    }
    if (!best) break;
    const candidates = points.filter(p => Math.abs((p[0] - best!.a[0]) * best!.uy - (p[1] - best!.a[1]) * best!.ux) <= tolerance);
    const cx = candidates.reduce((s, p) => s + p[0], 0) / candidates.length, cy = candidates.reduce((s, p) => s + p[1], 0) / candidates.length;
    let xx = 0, yy = 0, xy = 0; for (const p of candidates) { xx += (p[0] - cx) ** 2; yy += (p[1] - cy) ** 2; xy += (p[0] - cx) * (p[1] - cy); }
    const angle = .5 * Math.atan2(2 * xy, xx - yy), ux = Math.cos(angle), uy = Math.sin(angle);
    const projected = candidates.map(p => ({ p, t: (p[0] - cx) * ux + (p[1] - cy) * uy })).sort((a, b) => a.t - b.t);
    let start = 0;
    for (let j = 1; j <= projected.length; j++) if (j === projected.length || projected[j]!.t - projected[j - 1]!.t > .20) {
      const first = projected[start]!.t, last = projected[j - 1]!.t;
      if (j - start >= 10 && last - first >= .8) {
        let residual = 0; for (let k = start; k < j; k++) { const p = projected[k]!.p; residual += ((p[0] - cx) * uy - (p[1] - cy) * ux) ** 2; }
        segments.push({ a: [cx + first * ux, cy + first * uy], b: [cx + last * ux, cy + last * uy], support: j - start, rmsM: Math.sqrt(residual / (j - start)) });
      }
      start = j;
    }
    points = points.filter(p => Math.abs((p[0] - best!.a[0]) * best!.uy - (p[1] - best!.a[1]) * best!.ux) > tolerance);
    if (round % 5 === 0) { progress(`拟合墙线 ${segments.length} 段`); await new Promise(r => setTimeout(r, 0)); }
  }
  // 集成顺序（a→b）：先按 wallDedupe.ts 合并同一墙轴上的平行重复段，再交给 wallNetwork.ts 的
  // 墙网级连接（贴合 T 形插节点、角接、沿墙轴延长）；洞口不补墙，未连接项逐条给出位置与原因。
  // 去重在前：连接阶段的贴合/延长作用在合并后的墙轴上，不会把重复段的端点再拉成新节点；
  // 去重的判据（轴向间距 0.15 m、投影相接 0.02 m）只比较轴向位置与投影区间，不读端点微移，
  // 故不受连接阶段影响。两者的判据与参数均未改动。
  const deduped = mergeWallSegments(segments);
  if (deduped.groups.length) progress(`合并同墙轴重复段 ${deduped.groups.length} 组，${segments.length}→${deduped.segments.length} 段`);
  const network = buildWallNetwork(deduped.segments);
  if (network.segments.length < 2) throw Error("无法拟合足够的持续墙线；请先清理建筑范围。不会回退到占据轮廓。");
  // 连接结果按墙网边顺序给出；来源编号（sources/merge）随段带出，供诊断与去重去向核对回溯。
  const joined = network.segments.map(({ a, b, support, rmsM, sourceIndex }) => {
    const source = deduped.segments[sourceIndex]!;
    return { a, b, support, rmsM, sources: source.sources ? [...source.sources] : undefined, merge: source.merge ?? null, dedupedIndex: sourceIndex };
  });
  return { segments: joined, network, mergeGroups: deduped.groups, fittedSegments: segments.length, dedupedSegments: deduped.segments.length, evidenceCells, retained, cell, bounds: { min: [minX, minY, minZ] as [number, number, number], max: [maxX, maxY, maxZ] as [number, number, number] } };
}

export async function generateWallDrawing(cloud: PointCloudData, name: string, settings: Partial<CadDrawingSettings>, progress: (s: string) => void): Promise<DrawingModel> {
  const result = await fitWallLines(cloud, progress);
  const mainWall = [...result.segments].sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b))[0]!;
  let sourceAngle = Math.atan2(mainWall.b[1] - mainWall.a[1], mainWall.b[0] - mainWall.a[0]);
  while (sourceAngle > Math.PI / 4) sourceAngle -= Math.PI / 2;
  while (sourceAngle < -Math.PI / 4) sourceAngle += Math.PI / 2;
  const aligned = settings.alignToPrincipalAxis ?? true, rotation = aligned ? -sourceAngle : 0;
  const rotate = (p:P):P => [p[0]*Math.cos(rotation)-p[1]*Math.sin(rotation),p[0]*Math.sin(rotation)+p[1]*Math.cos(rotation)];
  // 只做同一刚体旋转，不强拉直斜墙；原始点云及墙长保持不变，变换写入成果。
  const segments = result.segments.map(s => ({...s,a:rotate(s.a),b:rotate(s.b)}));
  // 旧模型仅承载图层、图框和成果契约；占据轮廓及其尺寸全部替换。
  const positions: number[] = [];
  for (const { a, b } of segments) for (let t = 0; t <= 1; t += .005) positions.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 1);
  const scaffold: PointCloudData = { id: cloud.id, frameId: cloud.frameId, stampNs: 0n, positions: Float32Array.from(positions), colors: new Uint8Array(positions.length), visible: new Uint8Array(positions.length / 3).fill(1) };
  const model = generateDrawing(scaffold, name, "xy", { ...settings, orthogonalizeWalls: false, alignToPrincipalAxis: false, minRegionCells: 1, minCellPoints: 1, includePoints: false, detailDimensions: false });
  model.dimensions = [];
  model.entities = model.entities.filter(e => !["wall", "dimension", "point-evidence"].includes(e.category));
  const base = { source: "observed" as const, confidence: "measured" as const }, mm = (p: P): P => [p[0] * 1000, p[1] * 1000];
  // 合并结果保留来源段编号，可回溯拟合原始输出与诊断报告（diagnosis.json 的 segments[].index）。
  for (const [i, s] of segments.entries()) model.entities.push({ ...base, id: `wall-fit-${i}`, type: "line", start: mm(s.a), end: mm(s.b), layer: "OBSERVED_WALL", category: "wall", metadata: { evidenceCells: s.support, rmsMm: s.rmsM * 1000, sourceWalls: (s.sources ?? [i]).join(",") } });
  const angle = aligned ? 0 : sourceAngle, cs = Math.cos(angle), sn = Math.sin(angle);
  const toLocal = (p: P): P => [(p[0] * cs + p[1] * sn) * 1000, (-p[0] * sn + p[1] * cs) * 1000];
  const toWorld = (p: P): P => [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs];
  const pts = segments.flatMap(s => [toLocal(s.a), toLocal(s.b)]), minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0])), minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  const denominator = Number(settings.scale?.split(":")[1])||100, textHeight = 2.5*denominator;
  let serial = 0;
  function dimension(a:P,b:P,d:number) {
    const length=distance(a,b);if(length<1e-6)return;
    const ux=(b[0]-a[0])/length,uy=(b[1]-a[1])/length;
    appendDimension(model,{id:`fit-dim-${serial++}`,kind:aligned?(Math.abs(b[1]-a[1])<1e-6?"horizontal":"vertical"):"aligned",start:a,end:b,linePoint:[a[0]-uy*d,a[1]+ux*d],textHeightMm:textHeight,roundingMm:settings.roundingMm??1,source:"derived"});
  }
  // 建筑外侧分段尺寸链：由横纵墙段位置提供分界，避免逐线标注互相叠压。
  function chainCoordinates(axis: 0 | 1, min: number, max: number) {
    const values = [min, max];
    for (const s of segments) { const a = toLocal(s.a), b = toLocal(s.b), length = distance(a, b); if (Math.abs(a[axis] - b[axis]) < length * .08) values.push((a[axis] + b[axis]) / 2); }
    values.sort((a, b) => a - b); const grouped: number[] = [];
    for (const v of values) if (!grouped.length || v - grouped.at(-1)! > 300) grouped.push(v);
    if (max - grouped.at(-1)! < 300) grouped[grouped.length - 1] = max; else grouped.push(max);
    return grouped.length <= 14 ? grouped : [min, max];
  }
  const xs = chainCoordinates(0, minX, maxX), ys = chainCoordinates(1, minY, maxY);
  function chain(axis:0|1,values:number[]) {
    const lanes:Array<Array<[number,number]>>=[];
    if(values.length>2)for(let i=1;i<values.length;i++){
      const a=values[i-1]!,b=values[i]!,rounding=settings.roundingMm??1;
      const text=String(Number((Math.round((b-a)/rounding)*rounding).toFixed(6)));
      // 按纸面字高估算数字占宽；短尺寸放到相邻尺寸线，避免文字相互叠压。
      const half=(text.length*.72*textHeight+2*denominator)/2,mid=(a+b)/2;
      const interval:[number,number]=[mid-half,mid+half];
      let lane=lanes.findIndex(items=>items.every(([l,r])=>interval[0]>=r||interval[1]<=l));
      if(lane<0){lane=lanes.length;lanes.push([]);}lanes[lane]!.push(interval);
      const offset=(8+7*lane)*denominator;
      if(axis===0)dimension(toWorld([a,minY]),toWorld([b,minY]),-offset);
      else dimension(toWorld([minX,a]),toWorld([minX,b]),offset);
    }
    const totalOffset=(16+7*Math.max(0,lanes.length-1))*denominator;
    if(axis===0)dimension(toWorld([minX,minY]),toWorld([maxX,minY]),-totalOffset);
    else dimension(toWorld([minX,minY]),toWorld([minX,maxY]),totalOffset);
    return lanes.length;
  }
  const dimensionLanes=[chain(0,xs),chain(1,ys)];
  const geometryPoints = model.entities.flatMap(e => e.category === "frame" || e.layer === "TITLE_BLOCK" ? [] : e.type === "line" ? [e.start, e.end] : e.type === "polyline" ? e.points : [e.position]);
  model.modelBoundsMm = { min: [Math.min(...geometryPoints.map(p => p[0])), Math.min(...geometryPoints.map(p => p[1]))], max: [Math.max(...geometryPoints.map(p => p[0])), Math.max(...geometryPoints.map(p => p[1]))] };
  model.layoutBoundsMm = { min: model.layoutBoundsMm.min.map((v, i) => Math.min(v, model.modelBoundsMm.min[i]!)) as P, max: model.layoutBoundsMm.max.map((v, i) => Math.max(v, model.modelBoundsMm.max[i]!)) as P };
  model.statistics.sourcePointCount = cloud.visible.length; model.statistics.observedWallEntities = segments.length; model.statistics.roomCount = 0;
  model.accuracy.gridResolutionMm = result.cell * 1000; model.accuracy.fittingEstimateMm = Math.max(...segments.map(s => s.rmsM)) * 1000;
  // 悬空端直接取墙网连接结果：与"未连接清单"同源，避免两套口径。
  const openEndpoints = result.network.join.dangling;
  model.parameters.orthogonalizeWalls = true; model.parameters.detailDimensions = true; model.parameters.alignToPrincipalAxis = aligned;
  if(aligned){
    model.parameters.planAlignment={angleRadians:rotation,originM:[0,0],method:"wall-directions"};
    model.drawingCoordinateSystem=`建筑主轴 XY（旋转 ${(rotation*180/Math.PI).toFixed(3)}°）`;
    model.titleBlock.drawingCoordinateSystem=model.drawingCoordinateSystem;
  }
  const { min, max } = result.bounds;
  model.sourceSummary = { ...model.sourceSummary, pointCount: cloud.visible.length, bounds: result.bounds, width: max[0] - min[0], depth: max[1] - min[1], height: max[2] - min[2], volumeM3: (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]) };
  model.titleBlock.accuracyNote = `墙体索引60mm；最大拟合RMS ${model.accuracy.fittingEstimateMm.toFixed(1)}mm；原始配准精度未提供，须现场复核`;
  Object.assign(model.parameters, { analysisMode: "vertical-evidence-ransac-lines", retainedPoints: result.retained, excludedPoints: cloud.visible.length - result.retained, evidenceCells: result.evidenceCells, fitToleranceM: .045, maxJoinM: .12, maxExtensionM: MAX_EXTENSION_M, openingM: OPENING_M, tieToleranceM: TIE_TOLERANCE_M, minWallLengthM: .8, openEndpoints, fittedSegments: result.fittedSegments, dedupedSegments: result.dedupedSegments, mergedWallGroups: result.mergeGroups.length, wallJoin: result.network.join, unclosedEnds: result.network.unclosed, dimensionLanes });
  model.warnings = [{ code: "WALL_LINES_REVIEW", severity: "warning", message: `${openEndpoints} 个未连接端点（洞口 ${result.network.join.opening} 个按门口保留、${result.network.join.unclosed} 个 0.5–1.0 m 缺口未闭合），墙线来自跨高度证据和直线拟合；未识别门窗，曲墙可能遗漏。同一墙轴的平行重复段先合并 ${result.mergeGroups.length} 组，连接只在同一墙轴上延长（≤${MAX_EXTENSION_M} m）、T 形插入节点，≥${OPENING_M} m 洞口不补墙，未强制闭合，须复核墙体与尺寸；不构成施工图精度验收。` }];
  model.titleBlock.evidenceNote = "跨高度墙线拟合；分段尺寸单位mm；原件及清理规则保留";
  model.titleBlock.softwareVersion = `Survey Studio ${STUDIO_VERSION}`;
  return restyleCadDrawing(model,settings);
}
