import {keyframeSupport} from "./keyframeSupport";
import {pairedWallsFromCloud} from "./pairedWalls";
import type {PairedFocus,PairedWall,PairedCandidate} from "../domain/pairedReview";
import {buildWallElevation,type ElevationOptions} from "./wallElevation";
import type {Wall} from "../domain/building";
/// <reference lib="webworker" />
import { ClipState, createMaskRule } from "../domain/cleaning";
import {BrushIndex} from "./brushSelection";
import type {BrushStroke} from "../domain/brush";
import { readCloud, type DecodedSource } from "./binaryPcd";
import { generateLargeDrawing } from "./largeDrawing";
import type { SurveySource } from "../domain/project";
import type { CadDrawingSettings } from "../../../src/cad/model";
import type { CadProjection } from "../../../src/cad/geometry";
import { buildingFromSegments, type BuildingOptions } from "../domain/buildingOps";
import { fitWallLines } from "./wallLines";
type Request = { id: number; action: "import" | "drawing" | "clean" | "brush" | "building" | "elevation" | "keyframe-support" | "paired-walls"; source: SurveySource; stroke?:BrushStroke; focus?:PairedFocus; pairedWalls?:PairedWall[]; candidates?:PairedCandidate[]; instances?:Uint16Array; projection?: CadProjection; buildingOptions?: BuildingOptions; wall?:Wall; floorM?:number; elevationOptions?:ElevationOptions; settings?: Partial<CadDrawingSettings> };
let decoded: DecodedSource | undefined, cachedKey: string | undefined, chunkSequence = 0;
let clipState:ClipState|undefined,brushIndex:BrushIndex|undefined;
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
      const next = await readCloud(source, source.units, read, progress); decoded = next; cachedKey = key; clipState=new ClipState(next.cloud);brushIndex=undefined;
    }
    const retained = clipState!.sync(source.clips ?? []);
    if (!retained) throw Error("框选后没有剩余点，请撤销或重新框选。");
    if(request.action==='brush'){
      if(!brushIndex){progress('建立点云空间索引');brushIndex=new BrushIndex(decoded.cloud,decoded.bounds);}
      const indices=brushIndex.select(request.stroke!);
      if(indices.length===retained)throw Error('本笔将移除全部剩余点，请缩小范围。');
      const rule=indices.length?createMaskRule(indices,decoded.cloud.visible.length):undefined;
      const retainedCount=rule?clipState!.sync([...(source.clips??[]),rule]):retained;
      const visible=Uint8Array.from(decoded.preview.sourcePointIndices??[],i=>decoded!.cloud.visible[i]!);
      self.postMessage({id:request.id,result:{rule,visible,affectedCount:indices.length,retainedCount}},{transfer:[visible.buffer]});
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
    } else self.postMessage({ id: request.id, result: await generateLargeDrawing(decoded, source.name, request.projection!, request.settings ?? {}, progress) });
  } catch (error) { self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
};
