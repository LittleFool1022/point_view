import {STUDIO_VERSION} from "../version";
import {restyleCadDrawing} from "../../../src/cad/sheet";
import { appendDimension,formatDimensionText } from "../../../src/cad/dimensions";
import type { PointCloudData } from "../../../src/domain/types";
import { cadEntityPoints, type CadDrawingSettings, type DrawingModel } from "../../../src/cad/model";
import { generateDrawing } from "./analysis";
type P = [number, number];
export interface WallSegment { a: P; b: P; support: number; rmsM: number }
const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** 默认出图只保留外边界及与外墙连接的轴线墙；孤立短段和斜段留作不导出的复核候选。 */
export function selectArchitecturalOutline(segments: WallSegment[], principalAngle: number) {
  const cs=Math.cos(principalAngle),sn=Math.sin(principalAngle),axisTolerance=Math.sin(5*Math.PI/180);
  const local=(p:P):P=>[p[0]*cs+p[1]*sn,-p[0]*sn+p[1]*cs];
  const oriented=segments.map((segment,index)=>{
    const a=local(segment.a),b=local(segment.b),length=distance(a,b),horizontal=Math.abs(a[1]-b[1])<=length*axisTolerance,vertical=Math.abs(a[0]-b[0])<=length*axisTolerance;
    return {segment,index,a,b,horizontal,vertical,axis:horizontal||vertical};
  });
  const axisPoints=oriented.filter(s=>s.axis).flatMap(s=>[s.a,s.b]);
  const minX=Math.min(...axisPoints.map(p=>p[0])),maxX=Math.max(...axisPoints.map(p=>p[0])),minY=Math.min(...axisPoints.map(p=>p[1])),maxY=Math.max(...axisPoints.map(p=>p[1]));
  const kept=new Set<number>(),rejected=new Set<number>();
  for(const s of oriented){
    if(!s.axis){rejected.add(s.index);continue;}
    const x=(s.a[0]+s.b[0])/2,y=(s.a[1]+s.b[1])/2;
    if((s.horizontal&&Math.min(Math.abs(y-minY),Math.abs(y-maxY))<=.18)||(s.vertical&&Math.min(Math.abs(x-minX),Math.abs(x-maxX))<=.18))kept.add(s.index);
  }
  const pointSegmentDistance=(p:P,s:typeof oriented[number])=>{
    const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],length2=dx*dx+dy*dy;
    const t=length2?Math.max(0,Math.min(1,((p[0]-s.a[0])*dx+(p[1]-s.a[1])*dy)/length2)):0;
    return Math.hypot(p[0]-s.a[0]-t*dx,p[1]-s.a[1]-t*dy);
  };
  let changed=true;
  while(changed){changed=false;for(const s of oriented){
    if(!s.axis||kept.has(s.index))continue;
    const anchors=oriented.filter(a=>kept.has(a.index));
    if(anchors.some(a=>Math.min(pointSegmentDistance(s.a,a),pointSegmentDistance(s.b,a))<=.15)){kept.add(s.index);changed=true;}
  }}
  for(const s of oriented)if(!kept.has(s.index))rejected.add(s.index);
  return {kept:segments.filter((_,i)=>kept.has(i)),rejected:segments.filter((_,i)=>rejected.has(i))};
}

export interface FitWallOptions { fidelity?: "standard" | "high" }

/** 亚分米网格仅用于检索跨高度证据；输出几何来自证据质心拟合，不描格网边。 */
export async function fitWallLines(cloud: PointCloudData, progress: (s: string) => void, options?: FitWallOptions) {
  const highFidelity = options?.fidelity === "high";
  const minHeightSpanM = highFidelity ? .65 : .8;
  const minOccupiedLayers = highFidelity ? 3 : 4;
  const minVoxelCount = highFidelity ? 5 : 8;
  const minSegmentLengthM = highFidelity ? .35 : .8;
  const minScore = highFidelity ? 5 : 15;
  const minClusterSupport = highFidelity ? 5 : 10;
  const normals=cloud.normals;
  const wallNormal=(index:number)=>{if(!normals)return false;const nx=normals[index*3]!,ny=normals[index*3+1]!,nz=normals[index*3+2]!;return nx*nx+ny*ny+nz*nz>64&&Math.abs(nz)<=44;};
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, retained = 0,normalEvidencePoints=0;
  let evidenceMinX=Infinity,evidenceMinY=Infinity,evidenceMaxX=-Infinity,evidenceMaxY=-Infinity;
  for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i]) {
    const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); minZ = Math.min(minZ, cloud.positions[i * 3 + 2]!); maxZ = Math.max(maxZ, cloud.positions[i * 3 + 2]!); retained++;
    if(wallNormal(i)){normalEvidencePoints++;evidenceMinX=Math.min(evidenceMinX,x);evidenceMinY=Math.min(evidenceMinY,y);evidenceMaxX=Math.max(evidenceMaxX,x);evidenceMaxY=Math.max(evidenceMaxY,y);}
  }
  const sourceBounds={min:[minX,minY,minZ] as [number,number,number],max:[maxX,maxY,maxZ] as [number,number,number]},normalMode=normalEvidencePoints>=1000?'voxel-normals':'fallback';
  if(normalMode==='voxel-normals'){minX=evidenceMinX;minY=evidenceMinY;maxX=evidenceMaxX;maxY=evidenceMaxY;}
  const cell = .06, nx = Math.ceil((maxX - minX) / cell) + 1, ny = Math.ceil((maxY - minY) / cell) + 1, n = nx * ny;
  if (!retained || n > 8_000_000) throw Error("建筑范围为空或过大，请先使用保留框内圈定建筑。");
  const counts = new Uint32Array(n), layers = new Uint32Array(n), xsum = new Float64Array(n), ysum = new Float64Array(n), low = new Float32Array(n).fill(Infinity), high = new Float32Array(n).fill(-Infinity);
  for (let i = 0; i < cloud.visible.length; i++) {
    if (!cloud.visible[i]||(normalMode==='voxel-normals'&&!wallNormal(i))) continue;
    const x = cloud.positions[i * 3]!, y = cloud.positions[i * 3 + 1]!, z = cloud.positions[i * 3 + 2]!;
    const key = Math.floor((y - minY) / cell) * nx + Math.floor((x - minX) / cell);
    counts[key]++; xsum[key] += x; ysum[key] += y; low[key] = Math.min(low[key]!, z); high[key] = Math.max(high[key]!, z);
    // 25cm 高度层计数；模32只合并远隔8m的层，不增加层数。
    layers[key] |= 1 << ((Math.floor(z / .25) % 32 + 32) % 32);
    if (i % 1_000_000 === 0) { progress(`扫描跨高度墙体证据 ${Math.floor(i / cloud.visible.length * 100)}%`); await new Promise(r => setTimeout(r, 0)); }
  }
  let points: P[] = [];
  for (let i = 0; i < n; i++) if (counts[i]! >= minVoxelCount && high[i]! - low[i]! >= minHeightSpanM) {
    let bits = layers[i]!, occupied = 0; while (bits) { bits &= bits - 1; occupied++; }
    if (occupied >= minOccupiedLayers) points.push([xsum[i]! / counts[i]!, ysum[i]! / counts[i]!]);
  }
  const evidenceCells = points.length;
  if (evidenceCells < (highFidelity ? 16 : 30)) throw Error("跨高度墙体证据不足，请检查 Z 轴方向、清理范围及建筑数据。");
  if (evidenceCells > 100_000) throw Error("墙体候选区域过大，请分区出图，避免把整个场景拟合为建筑。");
  const segments: WallSegment[] = []; let seed = 1234567;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const tolerance = .045;
  for (let round = 0; round < 60 && points.length >= (highFidelity ? 8 : 16); round++) {
    let best: { a: P; ux: number; uy: number; score: number } | undefined;
    for (let t = 0; t < 160; t++) {
      const a = points[Math.floor(random() * points.length)]!, b = points[Math.floor(random() * points.length)]!, length = distance(a, b);
      if (length < minSegmentLengthM) continue;
      const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length; let score = 0;
      for (const p of points) if (Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) <= tolerance) score++;
      if (score > (best?.score ?? minScore)) best = { a, ux, uy, score };
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
      if (j - start >= minClusterSupport && last - first >= minSegmentLengthM) {
        let residual = 0; for (let k = start; k < j; k++) { const p = projected[k]!.p; residual += ((p[0] - cx) * uy - (p[1] - cy) * ux) ** 2; }
        segments.push({ a: [cx + first * ux, cy + first * uy], b: [cx + last * ux, cy + last * uy], support: j - start, rmsM: Math.sqrt(residual / (j - start)) });
      }
      start = j;
    }
    points = points.filter(p => Math.abs((p[0] - best!.a[0]) * best!.uy - (p[1] - best!.a[1]) * best!.ux) > tolerance);
    if (round % 5 === 0) { progress(`拟合墙线 ${segments.length} 段`); await new Promise(r => setTimeout(r, 0)); }
  }
  // 只有两条非平行线的端点都距交点12cm以内才相接，不跨门洞补墙。
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i]!, b = segments[j]!, u: P = [a.b[0] - a.a[0], a.b[1] - a.a[1]], v: P = [b.b[0] - b.a[0], b.b[1] - b.a[1]];
    const cross = u[0] * v[1] - u[1] * v[0]; if (Math.abs(cross) < .15 * distance(a.a, a.b) * distance(b.a, b.b)) continue;
    const t = ((b.a[0] - a.a[0]) * v[1] - (b.a[1] - a.a[1]) * v[0]) / cross, p: P = [a.a[0] + u[0] * t, a.a[1] + u[1] * t];
    const ak = distance(a.a, p) < distance(a.b, p) ? "a" : "b", bk = distance(b.a, p) < distance(b.b, p) ? "a" : "b";
    if (distance(a[ak], p) <= .12 && distance(b[bk], p) <= .12) { a[ak] = [...p]; b[bk] = [...p]; }
  }
  if (segments.length < 2) throw Error("无法拟合足够的持续墙线；请先清理建筑范围。不会回退到占据轮廓。");
  return { segments, evidenceCells, retained, cell, normalMode,normalEvidencePoints, bounds:sourceBounds };
}

/** 判断两段墙线是否基本共线并存在有效投影重叠，用于区分已有墙线与清理后新显露墙线。 */
export function evaluateWallPreservation(before: WallSegment[], after: WallSegment[]) {
  const overlapBetween = (target: WallSegment, candidate: WallSegment): number => {
    const lenT = distance(target.a, target.b), lenC = distance(candidate.a, candidate.b);
    if (lenT < 1e-4 || lenC < 1e-4) return 0;
    const ux = (target.b[0] - target.a[0]) / lenT, uy = (target.b[1] - target.a[1]) / lenT;
    const cx = (candidate.b[0] - candidate.a[0]) / lenC, cy = (candidate.b[1] - candidate.a[1]) / lenC;
    if (Math.abs(ux * cx + uy * cy) < 0.98) return 0;
    const perpA = Math.abs((candidate.a[0] - target.a[0]) * uy - (candidate.a[1] - target.a[1]) * ux);
    const perpB = Math.abs((candidate.b[0] - target.a[0]) * uy - (candidate.b[1] - target.a[1]) * ux);
    if (Math.max(perpA, perpB) > 0.22) return 0;
    const t0 = (candidate.a[0] - target.a[0]) * ux + (candidate.a[1] - target.a[1]) * uy;
    const t1 = (candidate.b[0] - target.a[0]) * ux + (candidate.b[1] - target.a[1]) * uy;
    return Math.max(0, Math.min(lenT, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)));
  };

  let allPreserved = true;
  for (const w of before) {
    const len = distance(w.a, w.b);
    const intervals: Array<[number, number]> = [];
    for (const c of after) {
      if (overlapBetween(w, c) <= 0) continue;
      const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
      const t0 = (c.a[0] - w.a[0]) * ux + (c.a[1] - w.a[1]) * uy;
      const t1 = (c.b[0] - w.a[0]) * ux + (c.b[1] - w.a[1]) * uy;
      intervals.push([Math.max(0, Math.min(t0, t1)), Math.min(len, Math.max(t0, t1))]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0, curLo = 0, curHi = -1;
    for (const [lo, hi] of intervals) {
      if (lo > curHi) {
        if (curHi >= curLo) covered += curHi - curLo;
        curLo = lo; curHi = hi;
      } else curHi = Math.max(curHi, hi);
    }
    if (curHi >= curLo) covered += curHi - curLo;
    if (covered < Math.max(0.4, len - 0.25)) { allPreserved = false; break; }
  }

  const discovered = after.filter(c => before.reduce((best, w) => Math.max(best, overlapBetween(w, c)), 0) < 0.35);
  return { allPreserved, discovered };
}

export async function generateWallDrawing(cloud: PointCloudData, name: string, settings: Partial<CadDrawingSettings>, progress: (s: string) => void, baselineWalls?: WallSegment[]): Promise<DrawingModel> {
  const highFidelity = settings.autoCleanOutdoor === false && settings.autoCleanIndoor === false;
  const keepAllInterior = highFidelity || settings.autoCleanIndoor === false;
  const result = await fitWallLines(cloud, progress, { fidelity: highFidelity ? "high" : "standard" });
  const mainWall = [...result.segments].sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b))[0]!;
  let sourceAngle = Math.atan2(mainWall.b[1] - mainWall.a[1], mainWall.b[0] - mainWall.a[0]);
  while (sourceAngle > Math.PI / 4) sourceAngle -= Math.PI / 2;
  while (sourceAngle < -Math.PI / 4) sourceAngle += Math.PI / 2;
  const aligned = settings.alignToPrincipalAxis ?? true, rotation = aligned ? -sourceAngle : 0;
  const rotate = (p:P):P => [p[0]*Math.cos(rotation)-p[1]*Math.sin(rotation),p[0]*Math.sin(rotation)+p[1]*Math.cos(rotation)];
  // 只做同一刚体旋转，不强拉直斜墙；原始点云及墙长保持不变，变换写入成果。
  const fitted = result.segments.map(s => ({...s,a:rotate(s.a),b:rotate(s.b)}));
  const {kept:segments,rejected}=keepAllInterior
    ? { kept: fitted, rejected: [] as WallSegment[] }
    : selectArchitecturalOutline(fitted,aligned?0:sourceAngle);
  if(segments.length<2)throw Error('建筑外轮廓证据不足，请检查点云范围或人工绘制墙线。');
  const discoveredSet = baselineWalls?.length
    ? new Set(evaluateWallPreservation(baselineWalls.map(w => ({ ...w, a: rotate(w.a), b: rotate(w.b) })), segments).discovered)
    : new Set<WallSegment>();
  // 旧模型仅承载图层、图框和成果契约；占据轮廓及其尺寸全部替换。
  const positions: number[] = [];
  for (const { a, b } of segments) for (let t = 0; t <= 1; t += .005) positions.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 1);
  const scaffold: PointCloudData = { id: cloud.id, frameId: cloud.frameId, stampNs: 0n, positions: Float32Array.from(positions), colors: new Uint8Array(positions.length), visible: new Uint8Array(positions.length / 3).fill(1) };
  const model = generateDrawing(scaffold, name, "xy", { ...settings, orthogonalizeWalls: false, alignToPrincipalAxis: false, minRegionCells: 1, minCellPoints: 1, includePoints: false, detailDimensions: false });
  model.dimensions = [];
  model.entities = model.entities.filter(e => !["wall", "dimension", "point-evidence"].includes(e.category));
  const base = { source: "observed" as const, confidence: "measured" as const }, mm = (p: P): P => [p[0] * 1000, p[1] * 1000];
  let observedCount = 0, discoveredCount = 0;
  for (const [i, s] of segments.entries()) {
    if (discoveredSet.has(s)) {
      discoveredCount++;
      model.entities.push({ id: `wall-discovered-${i}`, type: "line", start: mm(s.a), end: mm(s.b), layer: "INFERRED_WALL", category: "wall", source: "derived", confidence: "inferred", lineType: "DASHED", metadata: { evidenceCells: s.support, rmsMm: s.rmsM * 1000, outlineReview: "自动清理后新显露墙线，请复核确认" } });
    } else {
      observedCount++;
      model.entities.push({ ...base, id: `wall-fit-${i}`, type: "line", start: mm(s.a), end: mm(s.b), layer: "OBSERVED_WALL", category: "wall", metadata: { evidenceCells: s.support, rmsMm: s.rmsM * 1000 } });
    }
  }
  for (const [i,s] of rejected.entries()) model.entities.push({id:`wall-candidate-${i}`,type:'line',start:mm(s.a),end:mm(s.b),layer:'FURNITURE',category:'geometry',source:'inferred',confidence:'inferred',lineType:'DASHED',metadata:{evidenceCells:s.support,rmsMm:s.rmsM*1000,outlineReview:'偏离建筑主轴或孤立室内段；默认隐藏且不导出'}});
  const angle = aligned ? 0 : sourceAngle, cs = Math.cos(angle), sn = Math.sin(angle);
  const toLocal = (p: P): P => [(p[0] * cs + p[1] * sn) * 1000, (-p[0] * sn + p[1] * cs) * 1000];
  const toWorld = (p: P): P => [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs];
  const pts = segments.flatMap(s => [toLocal(s.a), toLocal(s.b)]), minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0])), minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  const denominator = Number(settings.scale?.split(":")[1])||100, textHeight = 2.5*denominator;
  let serial = 0;
  function dimension(a:P,b:P,d:number) {
    const length=distance(a,b);if(length<1e-6)return;
    const ux=(b[0]-a[0])/length,uy=(b[1]-a[1])/length;
    appendDimension(model,{id:`fit-dim-${serial++}`,kind:aligned?(Math.abs(b[1]-a[1])<1e-6?"horizontal":"vertical"):"aligned",start:a,end:b,linePoint:[a[0]-uy*d,a[1]+ux*d],textHeightMm:textHeight,roundingMm:settings.roundingMm??1,unit:settings.dimensionUnit,source:"derived"});
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
      const text=formatDimensionText({unit:settings.dimensionUnit,roundingMm:rounding},b-a);
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
  const geometryPoints = model.entities.filter(e => e.category !== "frame" && e.layer !== "TITLE_BLOCK" && e.layer !== 'FURNITURE').flatMap(cadEntityPoints);
  model.modelBoundsMm = { min: [Math.min(...geometryPoints.map(p => p[0])), Math.min(...geometryPoints.map(p => p[1]))], max: [Math.max(...geometryPoints.map(p => p[0])), Math.max(...geometryPoints.map(p => p[1]))] };
  model.layoutBoundsMm = { min: model.layoutBoundsMm.min.map((v, i) => Math.min(v, model.modelBoundsMm.min[i]!)) as P, max: model.layoutBoundsMm.max.map((v, i) => Math.max(v, model.modelBoundsMm.max[i]!)) as P };
  model.statistics.sourcePointCount = cloud.visible.length; model.statistics.observedWallEntities = observedCount; model.statistics.inferredWallEntities = discoveredCount; model.statistics.roomCount = 0;
  model.accuracy.gridResolutionMm = result.cell * 1000; model.accuracy.fittingEstimateMm = Math.max(...segments.map(s => s.rmsM)) * 1000;
  const endpoints = segments.flatMap(s => [s.a, s.b]);
  const openEndpoints = endpoints.filter((p, i) => !endpoints.some((q, j) => i !== j && distance(p, q) < .001)).length;
  model.parameters.orthogonalizeWalls = true; model.parameters.detailDimensions = true; model.parameters.alignToPrincipalAxis = aligned;
  if(aligned){
    model.parameters.planAlignment={angleRadians:rotation,originM:[0,0],method:"wall-directions"};
    model.drawingCoordinateSystem=`建筑主轴 XY（旋转 ${(rotation*180/Math.PI).toFixed(3)}°）`;
    model.titleBlock.drawingCoordinateSystem=model.drawingCoordinateSystem;
  }
  const { min, max } = result.bounds;
  model.sourceSummary = { ...model.sourceSummary, pointCount: cloud.visible.length, bounds: result.bounds, width: max[0] - min[0], depth: max[1] - min[1], height: max[2] - min[2], volumeM3: (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]) };
  model.titleBlock.accuracyNote = `墙体索引60mm；最大拟合RMS ${model.accuracy.fittingEstimateMm.toFixed(1)}mm；原始配准精度未提供，须现场复核`;
  const wallFidelity = highFidelity ? "high-fidelity" : keepAllInterior ? "interior-preserved" : "architectural-outline";
  Object.assign(model.parameters, { wallFidelity, analysisMode: `${result.normalMode==='voxel-normals'?"vertical-evidence-ransac-lines+voxel-normals":"vertical-evidence-ransac-lines"}+${wallFidelity}`, retainedPoints: result.retained, excludedPoints: cloud.visible.length - result.retained, evidenceCells: result.evidenceCells,normalEvidencePoints:result.normalEvidencePoints, fitToleranceM: .045, maxJoinM: .12, minWallLengthM: highFidelity ? .35 : .8, openEndpoints, fittedSegments: segments.length, discoveredWallSegments: discoveredCount, rawFittedSegments:fitted.length,rejectedOutlineCandidates:rejected.length, dimensionLanes });
  const reviewMessage = highFidelity
    ? `${openEndpoints} 个未连接端点（含门洞或缺失证据）；已关闭自动去噪，按高保真模式保留全部 ${segments.length} 段拟合墙线（含短拐角 ≥0.35m、斜墙与独立室内段），未剔除至隐藏层；非承重隔断与尺寸须复核。`
    : keepAllInterior
      ? `${openEndpoints} 个未连接端点（含门洞或缺失证据）；已保留全部 ${segments.length} 段室内外拟合墙线（含斜墙与独立室内段），未剔除至隐藏层；非承重隔断与尺寸须复核。`
      : `${openEndpoints} 个未连接端点（含门洞或缺失证据）；默认保留外轮廓及与外墙连接的轴线墙，${rejected.length} 个偏离主轴或孤立室内段已放入默认隐藏且不导出的家具/复核层。未识别门窗，曲墙和真实斜墙可能遗漏，须复核；不构成施工图精度验收。`;
  model.warnings = [
    { code: "WALL_LINES_REVIEW", severity: "warning", message: reviewMessage },
    ...(discoveredCount ? [{ code: "INFERRED_CONTENT" as const, severity: "warning" as const, relatedLayer: "INFERRED_WALL" as const, message: `自动清理后新显露 ${discoveredCount} 段墙线，已放入推断复核层（INFERRED_WALL），请复核确认。` }] : []),
  ];
  model.titleBlock.evidenceNote = `${result.normalMode==='voxel-normals'?'法向约束 · ':''}跨高度墙线拟合 · ${highFidelity ? '高保真全段保留' : keepAllInterior ? '保留室内墙段' : '建筑轮廓筛选'}；分段尺寸单位${settings.dimensionUnit==='m'?'m':'mm'}；原件及清理规则保留`;
  model.titleBlock.softwareVersion = `Survey Studio ${STUDIO_VERSION}`;
  return restyleCadDrawing(model,settings);
}
