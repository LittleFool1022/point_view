import {keyframeSupport} from "./keyframeSupport";
import {pairedWallsFromCloud} from "./pairedWalls";
import type {PairedFocus,PairedWall,PairedCandidate} from "../domain/pairedReview";
import {buildWallElevation,type ElevationOptions} from "./wallElevation";
import type {Wall} from "../domain/building";
/// <reference lib="webworker" />
import { ClipState, createMaskRule, isAutoCleanRule } from "../domain/cleaning";
import {BrushIndex} from "./brushSelection";
import type {BrushStroke} from "../domain/brush";
import { readCloud, type DecodedSource } from "./binaryPcd";
import { generateLargeDrawing } from "./largeDrawing";
import type { SurveySource } from "../domain/project";
import type { CadDrawingSettings } from "../../../src/cad/model";
import type { CadProjection } from "../../../src/cad/geometry";
import { buildingFromSegments, type BuildingOptions } from "../domain/buildingOps";
import { fitWallLines, selectArchitecturalOutline, type WallSegment } from "./wallLines";
import {suggestAutoClean,type AutoCleanOptions} from './autoClean';
import {pickCloudPoint} from '../domain/measurement';
import type {CloudPointRay} from '../domain/measurement';
type Request = { id: number; action: "import" | "drawing" | "clean" | "brush" | "building" | "elevation" | "keyframe-support" | "paired-walls" | "pick-point" | "auto-clean" | "preview-auto-clean"; source: SurveySource; stroke?:BrushStroke; focus?:PairedFocus; pairedWalls?:PairedWall[]; candidates?:PairedCandidate[]; instances?:Uint16Array; projection?: CadProjection; buildingOptions?: BuildingOptions; wall?:Wall; floorM?:number; elevationOptions?:ElevationOptions; settings?: Partial<CadDrawingSettings>; footprint?:{min:[number,number];max:[number,number]};ray?:CloudPointRay;autoOptions?:AutoCleanOptions };
let decoded: DecodedSource | undefined, cachedKey: string | undefined, chunkSequence = 0;
let clipState:ClipState|undefined,brushIndex:BrushIndex|undefined,preAutoCleanBaseline:{key:string;walls:WallSegment[]}|undefined;

function markPreviewCandidates(previewSourceIndices: Uint32Array | undefined, sortedIndices: number[] | undefined, tag: number, target: Uint8Array) {
  if (!previewSourceIndices?.length || !sortedIndices?.length) return;
  let j = 0;
  for (let s = 0; s < previewSourceIndices.length; s++) {
    const src = previewSourceIndices[s]!;
    while (j < sortedIndices.length && sortedIndices[j]! < src) j++;
    if (j >= sortedIndices.length) break;
    if (sortedIndices[j] === src) target[s] = tag;
  }
}

async function computeBaselineWalls(cloud: DecodedSource["cloud"]): Promise<WallSegment[]> {
  try {
    const fitted = await fitWallLines(cloud, () => {});
    const main = [...fitted.segments].sort((a, b) => Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) - Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]))[0]!;
    let angle = Math.atan2(main.b[1] - main.a[1], main.b[0] - main.a[0]);
    while (angle > Math.PI / 4) angle -= Math.PI / 2;
    while (angle < -Math.PI / 4) angle += Math.PI / 2;
    return selectArchitecturalOutline(fitted.segments, angle).kept;
  } catch {
    return [];
  }
}
const readers = new Map<number, { resolve(value: ArrayBuffer): void; reject(e: Error): void }>();
self.onmessage = async ({ data }: MessageEvent) => {
  if (data.action === "chunk") {
    const pending = readers.get(data.chunkId); if (!pending) return;
    readers.delete(data.chunkId); data.error ? pending.reject(Error(data.error)) : pending.resolve(data.buffer); return;
  }
  const request = data as Request;
  const progress = (stage: string) => self.postMessage({ kind: "progress", id: request.id, stage });
  try {
    const source = request.source, key = source.native?.token ?? source.key;
    if (!decoded || cachedKey !== key || request.action === "import") {
      const read = async (offset: number, size: number) => {
        if (source.native) return new Promise<ArrayBuffer>((resolve, reject) => { const chunkId = ++chunkSequence; readers.set(chunkId, { resolve, reject }); self.postMessage({ kind: "read", id: request.id, chunkId, token: source.native!.token, offset, size }); });
        if (source.file) return source.file.slice(offset, offset + size).arrayBuffer();
        if (source.bytes) return source.bytes.slice(offset, offset + size);
        throw Error("源文件不可用。");
      };
      const next = await readCloud(source, source.units, read, progress); decoded = next; cachedKey = key; clipState=new ClipState(next.cloud);brushIndex=undefined;preAutoCleanBaseline=undefined;
    }
    const retained = clipState!.sync(source.clips ?? []);
    if (!retained) throw Error("框选后没有剩余点，请撤销或重新框选。");
    if(request.action==='auto-clean' || request.action==='preview-auto-clean'){
      const manualClips=(source.clips??[]).filter(rule=>!isAutoCleanRule(rule));
      const manualKey=JSON.stringify(manualClips);
      clipState!.sync(manualClips);
      const beforeVisible=Uint8Array.from(decoded.preview.sourcePointIndices??[],index=>decoded!.cloud.visible[index]!);
      const suggestion=await suggestAutoClean(decoded.cloud,request.autoOptions!,progress);
      if(suggestion.baselineWalls)preAutoCleanBaseline={key:manualKey,walls:suggestion.baselineWalls};
      const highlightMask=new Uint8Array(decoded.preview.sourcePointIndices?.length??0);
      markPreviewCandidates(decoded.preview.sourcePointIndices,suggestion.outdoorIndices,1,highlightMask);
      markPreviewCandidates(decoded.preview.sourcePointIndices,suggestion.indoorIndices,2,highlightMask);
      const {outdoorIndices:_oi,indoorIndices:_ii,baselineWalls:_bw,...summary}=suggestion;
      if(request.action==='preview-auto-clean'){
        clipState!.sync(source.clips??[]);
        self.postMessage({id:request.id,result:{...summary,beforeVisible,highlightMask}},{transfer:[beforeVisible.buffer,highlightMask.buffer]});
      }else{
        const clips=[...manualClips,...suggestion.rules],retainedCount=clipState!.sync(clips),p=decoded.preview;
        const preview={...p,retainedPointCount:retainedCount,positions:p.positions.slice(),colors:p.colors.slice(),visible:Uint8Array.from(p.sourcePointIndices??[],index=>decoded!.cloud.visible[index]!),sourcePointIndices:p.sourcePointIndices?.slice()};
        const buffers:Transferable[]=[preview.positions.buffer,preview.colors.buffer,preview.visible.buffer,beforeVisible.buffer,highlightMask.buffer];if(preview.sourcePointIndices)buffers.push(preview.sourcePointIndices.buffer);
        self.postMessage({id:request.id,result:{...summary,clips,preview,compare:{beforeVisible,highlightMask}}},{transfer:buffers});
      }
    }else if(request.action==='brush'){
      if(!brushIndex){progress('建立点云空间索引');brushIndex=new BrushIndex(decoded.cloud,decoded.bounds);}
      const indices=brushIndex.select(request.stroke!);
      if(indices.length===retained)throw Error('本笔将移除全部剩余点，请缩小范围。');
      const rule=indices.length?createMaskRule(indices,decoded.cloud.visible.length):undefined;
      const retainedCount=rule?clipState!.sync([...(source.clips??[]),rule]):retained;
      const visible=Uint8Array.from(decoded.preview.sourcePointIndices??[],i=>decoded!.cloud.visible[i]!);
      self.postMessage({id:request.id,result:{rule,visible,affectedCount:indices.length,retainedCount}},{transfer:[visible.buffer]});
    }else if(request.action==='pick-point'){
      self.postMessage({id:request.id,result:pickCloudPoint(decoded.cloud,request.ray!)});
    }else if(request.action==='paired-walls'){
      self.postMessage({id:request.id,result:await pairedWallsFromCloud(decoded.cloud,progress)});
    }else if(request.action==='keyframe-support'){
      self.postMessage({id:request.id,result:await keyframeSupport(decoded.cloud,request.focus!,request.pairedWalls!,request.candidates!,request.instances!,progress)});
    } else if(request.action==='elevation'){
      self.postMessage({id:request.id,result:await buildWallElevation(decoded.cloud,request.wall!,request.floorM!,request.elevationOptions!,progress)});
    } else if (request.action === "building") {
      const options=request.buildingOptions!;
      if(![options.elevationM,options.heightM,options.thicknessM].every(Number.isFinite) || options.heightM<=0 || options.thicknessM<=0) throw Error("建筑高度或厚度设置无效。");
      const working={...decoded.cloud,visible:decoded.cloud.visible.slice()};
      for(let i=0;i<working.visible.length;i++) { const z=working.positions[i*3+2]!; if(z<options.elevationM || z>options.elevationM+options.heightM) working.visible[i]=0; }
      const fitted=await fitWallLines(working,progress);
      self.postMessage({id:request.id,result:buildingFromSegments(source,options,fitted.segments)});
    } else if (request.action === "import" || request.action === "clean") {
      const p = decoded.preview;
      const preview = { ...p, retainedPointCount:retained, positions: p.positions.slice(), colors: p.colors.slice(), visible: Uint8Array.from(p.sourcePointIndices ?? [], index => decoded!.cloud.visible[index]!), sourcePointIndices: p.sourcePointIndices?.slice() };
      const buffers: Transferable[] = [preview.positions.buffer, preview.colors.buffer, preview.visible.buffer]; if (preview.sourcePointIndices) buffers.push(preview.sourcePointIndices.buffer);
      self.postMessage({ id: request.id, result: preview }, { transfer: buffers });
    } else {
      let baselineWalls: WallSegment[] | undefined;
      if (request.projection === "xy" && request.settings?.orthogonalizeWalls !== false && (source.clips ?? []).some(rule => isAutoCleanRule(rule))) {
        const manualClips = (source.clips ?? []).filter(rule => !isAutoCleanRule(rule));
        const manualKey = JSON.stringify(manualClips);
        if (preAutoCleanBaseline?.key !== manualKey) {
          clipState!.sync(manualClips);
          preAutoCleanBaseline = { key: manualKey, walls: await computeBaselineWalls(decoded.cloud) };
          clipState!.sync(source.clips ?? []);
        }
        baselineWalls = preAutoCleanBaseline.walls;
      }
      self.postMessage({ id: request.id, result: await generateLargeDrawing(decoded, source.name, request.projection!, request.settings ?? {}, progress, request.footprint, baselineWalls) });
    }
  } catch (error) { self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
};
