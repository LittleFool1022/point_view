import {STUDIO_VERSION} from "./version";
import {createCadSheet,restyleCadDrawing} from "../../src/cad/sheet";
import { appendDimension, type CadDimension } from "../../src/cad/dimensions";
import type {ElevationOptions,WallElevation} from "./pipeline/wallElevation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, FileDown, Ruler, Building2, Image, PackageCheck, Layers, Play, X } from "lucide-react";
import type { PointCloudData } from "../../src/domain/types";
import type { CadProjection } from "../../src/cad/geometry";
import { DEFAULT_CAD_DRAWING_SETTINGS, type DrawingModel, type CadAnnotation, type CadDrawingSettings } from "../../src/cad/model";
import { createSurveyDelivery } from "./domain/delivery";
import { CadPreview } from "../../src/components/CadPreview";
import type { ClipRule, EditedPointCloud } from "./domain/cleaning";
import type {BrushStroke,BrushEditResult} from "./domain/brush";
import { PairedWorkspace } from "./PairedWorkspace";
import { DeviceImport } from "./DeviceImport";
import type { KeyframePage, OpenedInput } from "./domain/source";
import { buildingFromPairedReview, addKeyframeOpening, linkKeyframeOpening, type OpeningPlacement } from "./domain/pairedBuilding";
import { createUnifiedDelivery, type IfcArtifact } from "./domain/unifiedDelivery";
import { MAX_PAIRED_BYTES, cameraForFrame, verifyPairedReview, type PairedCandidate, type PairedReview } from "./domain/pairedReview";
import {SemanticClient} from "./pipeline/semanticClient";
import {mergeSemanticCandidates} from "./pipeline/semanticCore";
import { CloudView } from "./CloudView";
import { openFile, saveFile } from "./platform";
import { demoRoom } from "./domain/demo";
import { encodeProject, decodeProject, validateProjectState, type SurveyProject, type SurveySource } from "./domain/project";
import type { AccuracyRecord } from "./domain/accuracy";
import type { SourceUnit } from "./pipeline/analysis";
import { assessImportExtents, SOURCE_UNIT_LABELS, type ImportCheck, type ImportResult } from "./domain/importCheck";

import { RenderWorkspace } from "./RenderWorkspace";
import { DEFAULT_RENDER_SCENE, type RenderSceneSettings } from "./domain/renderScene";
import { BuildingWorkspace } from "./BuildingWorkspace";
import { reviewFitImpact } from "./domain/buildingReview";
import { validateBuilding, buildingQuantities, type BuildingModel } from "./domain/building";
import { sourceStamp, type BuildingOptions } from "./domain/buildingOps";
import { drawingFromBuilding, annotateSurveyDrawing } from "./domain/buildingDrawing";
import { zipSync, strToU8 } from "fflate";

type View = "keyframes" | "drawing" | "bim" | "render" | "delivery";
export function App() {
  const [view, setView] = useState<View>("drawing"), [source, setSource] = useState<SurveySource>(), [cloud, setCloud] = useState<EditedPointCloud>();
  const activeSource=useRef(source);activeSource.current=source;
  const brushChain=useRef<Promise<void>>(Promise.resolve()),brushCount=useRef(0),brushEpoch=useRef(0);
  const [pendingBrushes,setPendingBrushes]=useState(0);
  const [pairedReview, setPairedReview] = useState<PairedReview>();
  const [activeKeyframePage, setActiveKeyframePage] = useState<string>();
  const [deviceImport, setDeviceImport] = useState(false);
  const [renderScene,setRenderScene]=useState<RenderSceneSettings>({...DEFAULT_RENDER_SCENE});
  const [building, setBuilding] = useState<BuildingModel>();
  const [accuracy, setAccuracy] = useState<AccuracyRecord>();
  const [modelHistory, setModelHistory] = useState<{undo: Array<BuildingModel | undefined>; redo: Array<BuildingModel | undefined>}>({undo:[],redo:[]});
  const semanticClient=useRef<SemanticClient|undefined>(undefined),semanticSequence=useRef(0);
  useEffect(()=>()=>semanticClient.current?.dispose(),[]);
  const deliverySequence = useRef(0);
  const cancelIfc = useRef<(() => void) | undefined>(undefined);
  const ifcWorker = useRef<Worker | undefined>(undefined);
  useEffect(()=>()=>ifcWorker.current?.terminate(),[]);
  const [editHistory, setEditHistory] = useState<{ undo: ClipRule[][]; redo: ClipRule[][] }>({ undo: [], redo: [] });
  const [dimensionKind,setDimensionKind]=useState<CadDimension['kind']>('aligned'),[dimensionMode,setDimensionMode]=useState<CadDimension['kind']>();
  const [cadHistory,setCadHistory]=useState<{undo:CadDimension[][];redo:CadDimension[][]}>({undo:[],redo:[]});
  const [drawing, setDrawing] = useState<DrawingModel>(), [projection, setProjection] = useState<CadProjection>("xy"), [units, setUnits] = useState<SourceUnit>("m");
  const [importCheck, setImportCheck] = useState<ImportCheck>(), [unitConfirmed, setUnitConfirmed] = useState(false);
  const [settings, setSettings] = useState<CadDrawingSettings>({ ...DEFAULT_CAD_DRAWING_SETTINGS,alignToPrincipalAxis:true,roundingMm:1 });
  const [annotations, setAnnotations] = useState<CadAnnotation[]>([]), [label, setLabel] = useState(""), [category, setCategory] = useState<NonNullable<CadAnnotation["category"]>>("text");
  const [placing, setPlacing] = useState<Pick<CadAnnotation, "text" | "category">>(), [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const [busy, setBusy] = useState(""), [notice, setNotice] = useState(""), [stale, setStale] = useState(false), [dirty, setDirty] = useState(false);
  /** 点云不可用（源件缺失或无法解码）：工程仍可打开并保留模型与复核记录，依赖点云的操作须禁用并明示。 */
  const [cloudMissing, setCloudMissing] = useState(false);
  const worker = useRef<Worker | undefined>(undefined), sequence = useRef(0), pending = useRef<{ id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined>(undefined);
  useEffect(() => () => worker.current?.terminate(), []);
  useEffect(() => window.surveyDesktop?.onProgress(stage => setBusy(current => current ? stage : current)), []);
  useEffect(() => { const unload = (e: BeforeUnloadEvent) => { if (dirty || busy) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", unload); return () => window.removeEventListener("beforeunload", unload); }, [dirty, busy]);
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === "Escape") {setPlacing(undefined);setDimensionMode(undefined);} }; window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, []);
  function request<T>(data: object): Promise<T> {
    if (!worker.current) {
      worker.current = new Worker(new URL("./pipeline/analysis.worker.ts", import.meta.url), { type: "module" });
      const runtime = worker.current;
      runtime.onmessage = e => {
        const p = pending.current; if (!p || p.id !== e.data.id) return;
        if (e.data.kind === "progress") { setBusy(e.data.stage); return; }
        if (e.data.kind === "read") {
          const { chunkId, token, offset, size } = e.data;
          if (!window.surveyDesktop) { runtime.postMessage({ action: "chunk", chunkId, error: "桌面文件读取接口不可用。" }); return; }
          void window.surveyDesktop.read(token, offset, size).then(buffer => runtime.postMessage({ action: "chunk", chunkId, buffer }, [buffer])).catch(error => runtime.postMessage({ action: "chunk", chunkId, error: String(error) })); return;
        }
        pending.current = undefined; e.data.error ? p.reject(Error(e.data.error)) : p.resolve(e.data.result);
      };
      worker.current.onerror = () => { pending.current?.reject(Error("分析进程异常，请重新导入成果。")); pending.current = undefined; worker.current?.terminate(); worker.current = undefined; };
    }
    return new Promise<T>((resolve, reject) => { if (pending.current) { reject(Error("已有分析任务正在运行。")); return; } const id = ++sequence.current; pending.current = { id, resolve: value => resolve(value as T), reject }; worker.current!.postMessage({ id, ...data }); });
  }
  async function action(stage: string, callback: () => Promise<void>) { setBusy(stage); try { await callback(); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); } finally { setBusy(""); } }
  /** 解码已改变 worker 缓存但尚未提交界面状态时，必须丢弃缓存，避免后续继续用错尺度。 */
  function discardAnalysisWorker() {
    pending.current?.reject(Error("分析已中止，请重试。"));
    pending.current = undefined;
    worker.current?.terminate();
    worker.current = undefined;
  }
  function applyImportedSource(next: SurveySource, decoded: ImportResult, check: ImportCheck) {
    if (source?.native && source.native.token !== next.native?.token) void window.surveyDesktop?.release(source.native.token);
    // 新尺度下旧裁剪、图纸、标注、模型、精度记录和关键帧关联均不可沿用。
    setPairedReview(undefined); setActiveKeyframePage(undefined); setBuilding(undefined); setAccuracy(undefined); setRenderScene({...DEFAULT_RENDER_SCENE}); setModelHistory({undo:[],redo:[]});
    setEditHistory({ undo: (next.clips ?? []).map((_, i) => next.clips!.slice(0, i)), redo: [] });
    setCloudMissing(false);
    setSource(next); setCloud(decoded.cloud); setImportCheck(check); setUnitConfirmed(false); setUnits(next.units);
    setDrawing(undefined); setCadHistory({undo:[],redo:[]});setDimensionMode(undefined);setAnnotations([]); setPlacing(undefined); setStale(false); setDirty(true); setView("drawing");
    const count = decoded.cloud.sourcePointCount ?? decoded.cloud.visible.length;
    setNotice(`已导入 ${next.name} · ${count.toLocaleString()} 点 · 显示 ${decoded.cloud.visible.length.toLocaleString()} 点${next.synthetic ? " · 合成示例，非实测" : ""}`);
  }
  async function importSource(input: SurveySource) {
    const next = { ...input, key: crypto.randomUUID() };
    try {
      const decoded = await request<ImportResult>({ action: "import", source: next });
      if(next.deviceReceipt && decoded.cloud.sourcePointCount !== next.deviceReceipt.points)throw Error("设备点数回执与完整点云不一致，未替换当前工程。");
      applyImportedSource(next, decoded, assessImportExtents(decoded.bounds, decoded.cloud.sourcePointCount ?? decoded.cloud.visible.length));
    } catch (e) { if (next.native && next.native.token !== source?.native?.token) void window.surveyDesktop?.release(next.native.token); throw e; }
  }
  /** 复用当前源文件按另一单位重解码；先解码成功再提交，取消或失败均保留原工程。 */
  function switchUnits(nextUnit: SourceUnit) {
    if (!source || busy || nextUnit === source.units) return;
    const label = SOURCE_UNIT_LABELS[nextUnit];
    if (!window.confirm(`按${label}重新解码会清理当前工程的裁剪、图纸、标注、建筑模型、精度记录和关键帧关联。原始文件不会被修改。是否继续？`)) {
      setNotice(`已取消按${label}重新解码，当前工程保持不变。`); return;
    }
    const next = { ...source, units: nextUnit, clips: [], key: crypto.randomUUID() };
    void action(`按${label}重新解码当前源文件`, async () => {
      const decoded = await request<ImportResult>({ action: "import", source: next });
      let committed = next;
      try {
        if (next.deviceReceipt && decoded.cloud.sourcePointCount !== next.deviceReceipt.points) throw Error("设备点数回执与完整点云不一致，未切换单位。");
        // 桌面 token 同时持有已附加的原图卷；只在解码成功后解除，避免失败时丢失原关联。
        if (next.native && window.surveyDesktop?.clearKeyframePages) {
          let pages: KeyframePage[];
          try { pages = await window.surveyDesktop.clearKeyframePages(next.native.token); }
          catch (error) { throw Error(`清理旧关键帧卷失败，未切换单位：${error instanceof Error ? error.message : String(error)}`); }
          committed = { ...next, native: { ...next.native, keyframePages: pages } };
        }
        const check = assessImportExtents(decoded.bounds, decoded.cloud.sourcePointCount ?? decoded.cloud.visible.length);
        applyImportedSource(committed, decoded, check);
        setNotice(`已按${label}重新解码 ${next.name}：${check.sizeM.map(v => v.toFixed(2)).join(" × ")} m · ${check.pointCount.toLocaleString()} 点。旧尺度成果已清理${check.suspicious ? "；当前范围仍需核对。" : "。"}`);
      } catch (error) {
        discardAnalysisWorker();
        throw error;
      }
    });
  }
  /** 可疑单位未确认时拦住成图；正常范围不增加步骤。 */
  function confirmSuspiciousUnit() {
    if (!source || !importCheck?.suspicious || unitConfirmed) return true;
    const reasons = importCheck.reasons.join(" ");
    if (window.confirm(`当前按${SOURCE_UNIT_LABELS[source.units]}解码的点云范围可疑：${reasons}是否仍按当前单位生成工程图？取消后可先重新解码当前源文件。`)) {
      setUnitConfirmed(true); return true;
    }
    setNotice("已暂缓生成；请先核对源单位，可在导入核对条重新解码当前源文件。");
    return false;
  }
  const canReplace = () => !dirty || window.confirm("当前工程有未保存的更改，是否放弃并打开其他成果？");
  function importFile() { if (!canReplace()) return; void action("读取测量成果", async () => { const f = await openFile("cloud"); if (f) await importSource({ name: f.name, bytes: f.data, file: f.file, native: f.native, units, synthetic: false }); }); }
  async function receiveSource(file: OpenedInput) {
    const input:SurveySource={name:file.name,native:file.native,deviceReceipt:file.deviceReceipt,units:"m",synthetic:false};
    const first=file.native?.keyframePages?.[0];let review:PairedReview|undefined;
    if(first&&file.native&&window.surveyDesktop){
      try{review=JSON.parse(new TextDecoder().decode(await window.surveyDesktop.keyframePage(file.native.token,first.id)));await verifyPairedReview(review!,input);}
      catch(error){await window.surveyDesktop.release(file.native.token);throw error;}
    }
    setBusy("导入完整点云与原图卷");
    try{await importSource(input);if(review){setPairedReview(review);setActiveKeyframePage(first!.id);}}
    finally{setBusy("");}
  }
  async function persistKeyframeIndex() {
    if(!source?.native?.keyframePages?.length||!window.surveyDesktop)return undefined;
    if(pairedReview&&activeKeyframePage)await window.surveyDesktop.updateKeyframePage(source.native.token,activeKeyframePage,pairedReview);
    return window.surveyDesktop.keyframeIndex(source.native.token);
  }
  function switchKeyframePage(id:string){
    if(!source?.native||!window.surveyDesktop||id===activeKeyframePage||busy)return;
    void action("恢复关键帧原图卷",async()=>{
      if(pairedReview&&activeKeyframePage)await window.surveyDesktop!.updateKeyframePage(source.native!.token,activeKeyframePage,pairedReview);
      const review:PairedReview=JSON.parse(new TextDecoder().decode(await window.surveyDesktop!.keyframePage(source.native!.token,id)));
      await verifyPairedReview(review,source);setPairedReview(review);setActiveKeyframePage(id);setDirty(true);
      setNotice("原图卷已恢复，其他卷及其复核意见保留。");
    });
  }
  function importFrames() {
    if (!source) return;
    void action("关联并校验原始关键帧", async () => {
      const f = await openFile("frames"); if (!f) return;
      if (f.file && f.file.size > MAX_PAIRED_BYTES) throw Error("关键帧附件超过 16 MiB，请按会话拆分。");
      const bytes = f.data ?? await f.file?.arrayBuffer();
      if (!bytes || bytes.byteLength > MAX_PAIRED_BYTES) throw Error("关键帧附件为空或过大。");
      const next: PairedReview = JSON.parse(new TextDecoder().decode(bytes));
      await verifyPairedReview(next, source);
      if(source.native&&window.surveyDesktop){
        await persistKeyframeIndex();
        const pages=await window.surveyDesktop.addKeyframePage(source.native.token,next);
        setSource({...source,native:{...source.native,keyframePages:pages}});setActiveKeyframePage(pages.at(-1)!.id);
      }
      setPairedReview(next); setDirty(true); setNotice("关键帧原图与点云校验通过，可联合复核门窗候选。");
    });
  }
  function exportReview() {
    if (!pairedReview) return;
    void action("保存关键帧复核记录", async () => {
      const record = { schema: "survey-keyframe-decisions/1", session: pairedReview.session, sourceSha256: pairedReview.sourceSha256, model: pairedReview.model, frameId: pairedReview.frameId, poseSpace: pairedReview.poseSpace, captureQuality: pairedReview.captureQuality, alignmentVerified: pairedReview.alignmentVerified, constructionAccepted: false,
        frames: (await persistKeyframeIndex())??pairedReview.frames.map(({ id, name, sha256, cameraId, inference, candidates }) => ({ id, name, sha256, cameraId: cameraId ?? "front", inference, candidates })) };
      setNotice(await saveFile("门窗关键帧复核.json", strToU8(JSON.stringify(record, null, 2))) ? "门窗复核记录已保存，包含源件关联、类别修正与人工意见。" : "已取消保存。");
    });
  }
  function recognizeFrames(frameIds:string[]) {
    if(!source||!pairedReview||!frameIds.length)return;
    const operationId=++semanticSequence.current;
    void action("载入本地 AI 评估引擎",async()=>{
      let next=pairedReview;const client=semanticClient.current??(semanticClient.current=new SemanticClient());
      try {
        await verifyPairedReview(next,source);
        if(!next.walls.length){next={...next,walls:await request<PairedReview["walls"]>({action:"paired-walls",source})};setPairedReview(next);setDirty(true);}
        for(const [index,frameId] of frameIds.entries()){
          if(operationId!==semanticSequence.current)throw Error("已取消本地识别。");
          const frame=next.frames.find(f=>f.id===frameId);if(!frame)throw Error("当前原图已变化。");
          const camera=cameraForFrame(next,frame);setBusy(`本地 AI 识别 ${index+1}/${frameIds.length} · ${frame.name}`);
          const inferred=await client.run(frame,camera);
          if(next.model.id==="unassigned"&&next.model.revision==="none"&&next.frames.every(f=>!f.analyzed&&!f.candidates.length))next={...next,model:{id:inferred.modelId,revision:inferred.modelRevision}};
          if(inferred.modelId!==next.model.id||inferred.modelRevision!==next.model.revision)throw Error("附件识别模型与本地评估引擎不一致，原有观察已保留。");
          const candidates=await request<PairedCandidate[]>({action:"keyframe-support",source,focus:{camera,frame},pairedWalls:next.walls,candidates:inferred.candidates,instances:inferred.instances});
          if(operationId!==semanticSequence.current)throw Error("已取消本地识别。");
          next={...next,frames:next.frames.map(f=>f.id===frameId?{...f,analyzed:true,candidates:mergeSemanticCandidates(f.candidates,candidates),inference:{engine:"onnxruntime-web",version:"1.31.1",modelSha256:inferred.modelSha256,preprocessing:"RGB-antialias-triangle-512-imagenet/1",supportPolicy:"all-visible-source-3cm-voxel-8px-disc-near-depth-7m/1",inputSourcePoints:cloud?.sourcePointCount??0}}:f)};
          setPairedReview(next);setDirty(true);
        }
        setNotice(`本地 AI 已完成 ${frameIds.length} 帧识别并关联完整源点；已有人工意见保留，新增候选待复核。`);
      }catch(error){client.dispose();semanticClient.current=undefined;throw error;}
    });
  }
  function buildPairedModel() {
    if(!source||!pairedReview||building)return;
    if(!confirmSuspiciousUnit())return;
    void action("由同会话墙带建立建筑草案与平面图",async()=>{
      const review=pairedReview.walls.length?pairedReview:{...pairedReview,walls:await request<PairedReview["walls"]>({action:"paired-walls",source})};
      if(review!==pairedReview)setPairedReview(review);
      const next=await buildingFromPairedReview(source,review),committed={...next,revision:next.revision+1};
      changeBuilding(next);
      setDrawing(drawingFromBuilding(committed,committed.levels[0]!.id,settings,cloud?.sourcePointCount??0));setAnnotations([]);setProjection("xy");setStale(false);
      setNotice(`已建立 ${next.walls.length} 面墙带草案与同修订平面图；可将保留候选加入BIM或归并已有门窗。`);
    });
  }
  function addPairedOpening(frameId:string,candidateId:string,placement:OpeningPlacement) {
    if(!source||!pairedReview||!building)return;
    void action("将关键帧证据连接建筑模型",async()=>{
      changeBuilding(await addKeyframeOpening(building,source,pairedReview,frameId,candidateId,placement));
      setNotice("已加入待复核 BIM 草案，保留相机、原图和识别来源；完整边界与尺寸仍需核对。");
    });
  }
  function linkPairedOpening(frameId:string,candidateId:string,openingId:string) {
    if(!source||!pairedReview||!building)return;
    void action("归并同一门窗的关键帧观察",async()=>{
      changeBuilding(await linkKeyframeOpening(building,source,pairedReview,frameId,candidateId,openingId));
      setNotice("已追加至同一门窗的来源观察，未重复创建构件。");
    });
  }
  function exportUnified() {
    if(!source||!building)return;
    const operationId=++deliverySequence.current;
    const checkCancelled=()=>{if(operationId!==deliverySequence.current)throw Error("已取消统一成果生成。");};
    void action("生成同修订 CAD、IFC 与交付清单",async()=>{
      const parameters=drawing?.parameters as {buildingId?:string;buildingRevision?:number;buildingLevelId?:string}|undefined;
      const result=await createUnifiedDelivery({source,model:building,accuracy,review:pairedReview,reviewIndex:await persistKeyframeIndex(),settings,pointCount:cloud?.sourcePointCount??0,annotations,annotationLevelId:parameters?.buildingId===building.id&&parameters.buildingRevision===building.revision&&!stale?parameters.buildingLevelId:undefined,makeIfc:m=>runIfc(m,"review"),checkCancelled});
      checkCancelled();
      const saved=await saveFile("建筑同修订复核成果.zip",result.archive);
      if(saved)setNotice(`同修订成果包已保存：${result.drawings.length} 张平面图、IFC4、工程量与来源清单；${result.report.issues.length} 项待复核。`);
      else setNotice("已取消成果保存。");
    });
  }
  function clean(nextRules: ClipRule[], historyAction: "edit" | "undo" | "redo" = "edit") {
    if (!source || busy) return;
    const next = { ...source, clips: nextRules };
    void action("将清理范围应用于完整源点", async () => {
      const preview = await request<PointCloudData>({ action: "clean", source: next });
      const current = source.clips ?? [];
      setEditHistory(historyAction === "undo" ? { undo: editHistory.undo.slice(0, -1), redo: [...editHistory.redo, current] }
        : historyAction === "redo" ? { undo: [...editHistory.undo, current], redo: editHistory.redo.slice(0, -1) }
        : { undo: [...editHistory.undo, current], redo: [] });
      setCloud(preview); setSource(next); if (drawing) setStale(true); setDirty(true);
      setNotice(`已应用 ${nextRules.length} 次清理；原始 PCD 保留，图纸需重新生成。`);
    });
  }
  /** 按提交顺序处理笔画；导航继续可用，保存和出图等待同一修订确认。 */
  function queueBrush(stroke:BrushStroke):Promise<boolean> {
    if(!source||(busy&&!brushCount.current))return Promise.resolve(false);
    const identity=source.native?.token??source.key,epoch=brushEpoch.current;
    brushCount.current++;setPendingBrushes(brushCount.current);setBusy('同步点云笔画');
    const job=brushChain.current.then(async()=>{
      const current=activeSource.current;
      if(epoch!==brushEpoch.current||!current||(current.native?.token??current.key)!==identity)return false;
      const result=await request<BrushEditResult>({action:'brush',source:current,stroke});
      if(epoch!==brushEpoch.current)return false;
      if(result.rule){
        const next={...current,clips:[...(current.clips??[]),result.rule]};
        activeSource.current=next;setSource(next);
        setEditHistory(h=>({undo:[...h.undo,current.clips??[]],redo:[]}));
        setCloud(previous=>previous?{...previous,visible:result.visible,retainedPointCount:result.retainedCount}:previous);
        if(drawing)setStale(true);setDirty(true);
        setNotice(`已擦除 ${result.affectedCount.toLocaleString()} 个源点 · 保留 ${result.retainedCount.toLocaleString()} 点，图纸待更新。`);
      }else setNotice('本笔未命中可擦除的源点。');
      return true;
    }).catch(error=>{setNotice(error instanceof Error?error.message:String(error));return false;}).finally(()=>{
      brushCount.current--;setPendingBrushes(brushCount.current);if(!brushCount.current)setBusy('');
    });
    brushChain.current=job.then(()=>{});return job;
  }
  function changeBuilding(next: BuildingModel | undefined, mode: "edit" | "undo" | "redo" = "edit") {
    if (busy) return;
    setModelHistory(mode==="undo"?{undo:modelHistory.undo.slice(0,-1),redo:[...modelHistory.redo,building]}:mode==="redo"?{undo:[...modelHistory.undo,building],redo:modelHistory.redo.slice(0,-1)}:{undo:[...modelHistory.undo,building].slice(-50),redo:[]});
    setBuilding(next?{...next,revision:Math.max(next.revision,building?.revision??0)+1}:undefined);
    if(drawing && (drawing.parameters as any).buildingRevision) setStale(true);
    setDirty(true);
  }
  function generateBuilding(options: BuildingOptions) {
    if(!source)return;
    // 重新拟合会覆盖人工墙段与其处置记录：拟合前逐条列出并阻断（模型层 reviewPolicy=block-on-fit，界面不静默丢弃）。
    if(building){
      const impact=reviewFitImpact(building);
      if(!impact.ok){setNotice(`已阻断重新拟合：${impact.wallIds.length} 个人工墙段、${impact.actionIds.length} 条复核处置记录会被覆盖。${impact.reasons.slice(0,2).join("；")}`);return;}
    }
    if(!confirmSuspiciousUnit())return;
    void action("从当前楼层点云提取墙体候选",async()=>{
      const next=await request<BuildingModel>({action:"building",source,buildingOptions:options});
      setModelHistory({undo:[...modelHistory.undo,building].slice(-50),redo:[]});setBuilding({...next,revision:(building?.revision??0)+1});if(drawing && (drawing.parameters as any).buildingRevision)setStale(true);setDirty(true);setNotice(`已生成 ${next.walls.length} 条墙候选和 ${next.rooms.length} 个闭合房间；厚高与墙轴均需复核。`);
    });
  }
  async function getWallElevation(wallId:string,options:ElevationOptions):Promise<WallElevation>{
    if(cloudMissing)throw Error('点云对照不可用，墙面门窗识别需要完整点云；点云恢复后重开工程即可。');
    if(!source||!building||busy||building.sourceStamp!==sourceStamp(source))throw Error('请先完成当前任务并更新建筑模型测量关联。');
    const wall=building.walls.find(w=>w.id===wallId),floor=building.levels.find(l=>l.id===wall?.levelId);if(!wall||!floor)throw Error('请先选择宿主墙体。');
    setBusy('提取完整点云的墙面颜色与深度');
    try{return await request<WallElevation>({action:'elevation',source,wall,floorM:floor.elevationM,elevationOptions:options});}finally{setBusy('');}
  }
  async function runIfc(model:BuildingModel,purpose:"review"|"delivery"):Promise<IfcArtifact> {
    return new Promise<IfcArtifact>((resolve,reject)=>{
        const runtime=new Worker(new URL("./pipeline/ifc.worker.ts",import.meta.url),{type:"module"});ifcWorker.current=runtime;cancelIfc.current=()=>{runtime.terminate();ifcWorker.current=undefined;cancelIfc.current=undefined;reject(Error("已取消IFC导出。"));};
        runtime.onmessage=e=>{runtime.terminate();ifcWorker.current=undefined;cancelIfc.current=undefined;e.data.error?reject(Error(e.data.error)):resolve(e.data);};runtime.onerror=()=>{runtime.terminate();ifcWorker.current=undefined;cancelIfc.current=undefined;reject(Error("IFC引擎运行失败。"));};runtime.postMessage({model,purpose});
      });
  }
  function exportBuilding(purpose: "review"|"delivery") {
    if(!building||!source)return;
    void action("生成 IFC4 并离线检查实体几何",async()=>{
      if(building.sourceStamp!==sourceStamp(source))throw Error("建筑模型测量依据已过期，请更新测量关联。");
      const errors=validateBuilding(building).filter(i=>purpose==="delivery"||i.code!=="UNREVIEWED");if(errors.length)throw Error(errors[0]!.message);
      const result=await runIfc(building,purpose);
      const report={schema:"survey-bim-delivery/1",modelId:building.id,revision:building.revision,purpose,source:{name:source.name,sha256:source.native?.sha256,clips:source.clips??[]},checks:result.check,issues:validateBuilding(building),quantities:buildingQuantities(building),limitations:["内置解析与几何检查不替代完整IFC EXPRESS和目标软件验收。","墙角重叠体积未做全局布尔扣除；门窗为参数化闭合实体，非厂家族；无空间边界关系。"]};
      const saved=await saveFile(purpose==="review"?"建筑模型-复核.ifc":"建筑模型.ifc",result.bytes);
      if(saved){const archive=zipSync({"building.json":strToU8(JSON.stringify(building,null,2)),"quantities-and-checks.json":strToU8(JSON.stringify(report,null,2)),"model.ifc":result.bytes});await saveFile("建筑模型成果包.zip",archive);setNotice("IFC4 已通过离线解析与几何检查；模型和工程量清单已生成。");}else setNotice("已取消IFC保存。");
    });
  }
  function modelDrawing(levelId: string, refresh = false) {
    if (!building || !source) return;
    if (!confirmSuspiciousUnit()) return;
    void action("由建筑模型派生平面图", async () => {
      if (building.sourceStamp !== sourceStamp(source)) throw Error("建筑模型测量依据已过期。");
      const next = drawingFromBuilding(building, levelId, settings, cloud?.sourcePointCount ?? cloud?.visible.length ?? 0);
      const labels = refresh ? annotations : [];
      setDrawing(annotateSurveyDrawing(next, labels)); setAnnotations(labels); setPlacing(undefined);
      setProjection("xy"); setStale(false); setDirty(true); setView("drawing");
      setNotice("模型平面图已生成，与当前建筑修订一致。");
    });
  }
  function generate() {
    if (!source) return;
    if (!confirmSuspiciousUnit()) return;
    const count=drawing?.dimensions?.filter(d=>d.source==='manual').length??0;
    if(count&&!window.confirm(`重新生成图纸会清除 ${count} 条人工尺寸，请先保存工程。是否继续？`))return;
    setCadHistory({undo:[],redo:[]});setDimensionMode(undefined);
    const derived = drawing?.parameters as { analysisMode?: string; buildingId?: string; buildingLevelId?: string } | undefined;
    // 更新沿用原图来源；模型缺失或过期时保留旧图，不能悄悄切换到点云墙线。
    if (derived?.analysisMode === "building-model") {
      if (!building || derived.buildingId !== building.id || !building.levels.some(l => l.id === derived.buildingLevelId)) {
        setNotice("原图关联的建筑模型或楼层已不存在，请在建筑模型中重新生成平面图。"); return;
      }
      if (projection !== "xy") { setNotice("模型派生图当前支持 XY 平面，请切回平面视图后更新。"); return; }
      modelDrawing(derived.buildingLevelId!, true); return;
    }
    void action("提取墙体并生成工程图", async () => { const model = await request<DrawingModel>({ action: "drawing", source, projection, settings }); setDrawing(annotateSurveyDrawing(model, annotations)); setStale(false); setDirty(true); setNotice("工程图已生成，可复核图层并添加标注。门窗识别尚未接入。"); });
  }
  function changeDimensions(next:CadDimension[],mode:'edit'|'undo'|'redo'='edit') {
    if(!drawing||busy||stale)return;
    const current=drawing.dimensions??[];
    const updated={...drawing,dimensions:[],entities:drawing.entities.filter(e=>!e.metadata?.dimensionId)};
    try{for(const d of next)appendDimension(updated,d);setCadHistory(mode==='undo'?{undo:cadHistory.undo.slice(0,-1),redo:[...cadHistory.redo,current]}:mode==='redo'?{undo:[...cadHistory.undo,current],redo:cadHistory.redo.slice(0,-1)}:{undo:[...cadHistory.undo,current].slice(-50),redo:[]});setDrawing(updated);setDirty(true);}catch(error){setNotice(error instanceof Error?error.message:String(error));}
  }
  function addDimension(start:[number,number],end:[number,number],linePoint:[number,number]) {
    if(!drawing||!dimensionMode)return;
    const scale=Number(settings.scale.split(':')[1])||100;
    changeDimensions([...(drawing.dimensions??[]),{id:crypto.randomUUID(),kind:dimensionMode,start,end,linePoint,textHeightMm:2.5*scale,roundingMm:settings.roundingMm,source:'manual'}]);
  }
  function changeAnnotations(next: CadAnnotation[]) { setAnnotations(next); if (drawing) setDrawing(annotateSurveyDrawing(drawing, next)); setDirty(true); }
  function updateSettings(next:Partial<CadDrawingSettings>) {
    if(drawing&&!stale&&Object.keys(next).every(k=>['paperSize','scale','roundingMm'].includes(k))){
      try{
        const updated=restyleCadDrawing(drawing,next),ratio=Number(updated.scale.split(':')[1])/Number(drawing.scale.split(':')[1]);
        const style=(rows:CadDimension[])=>rows.map(d=>({...d,textHeightMm:d.textHeightMm*ratio,roundingMm:updated.parameters.roundingMm}));
        setDrawing(updated);setCadHistory({undo:cadHistory.undo.map(style),redo:cadHistory.redo.map(style)});
      }catch(error){setNotice(error instanceof Error?error.message:String(error));return;}
    }else if(drawing)setStale(true);
    setSettings(s=>({...s,...next}));setDirty(true);setPlacing(undefined);setDimensionMode(undefined);
  }
  function exportCad() { if (!drawing || stale) return; void action("打包工程图", async () => { const result = await createSurveyDelivery(drawing, source!,window.surveyDesktop?.renderPdf); setNotice(await saveFile(result.archiveName, result.archive) ? result.plot.outsideEntityIds.length||result.plot.titleOverlapEntityIds.length?`成果已保存；存在超框或标题栏重叠，需调整图幅后导出 PDF。`:"DXF、图纸和校验清单已保存。" : "已取消保存。"); }); }
  function exportPdf() {
    if(!drawing||stale)return;
    void action("生成图纸 PDF",async()=>{
      if(!window.surveyDesktop)throw Error("请在桌面版导出 PDF；浏览器成果包包含等比例矢量图纸。");
      const vector=createCadSheet(drawing);
      const bytes=await window.surveyDesktop.renderPdf({html:vector.html,widthMm:vector.sheet.widthMm,heightMm:vector.sheet.heightMm});
      setNotice(await saveFile("建筑测绘图.pdf",new Uint8Array(bytes))?"PDF 已保存；打印时使用实际大小。":"已取消保存。");
    });
  }
  function saveProject() {
    if (!source) return;
    void action("保存测量工程", async () => {
      let saved = false;
      if (pairedReview) await verifyPairedReview(pairedReview, source);
      if (source.native && window.surveyDesktop) {
        const state = { source: { name: source.name, units: source.units, synthetic: source.synthetic, clips: source.clips ?? [], deviceReceipt: source.deviceReceipt }, pairedReview, activeKeyframePage, building, accuracy, renderScene, drawing, drawingStale:stale, annotations, projection, settings };
        saved = (await window.surveyDesktop.saveProject(source.native.token, state)).saved;
      } else {
        const bytes = await encodeProject({ source, pairedReview, building, accuracy, renderScene, drawing, drawingStale:stale, annotations, projection, settings });
        saved = await saveFile("测量工程.pvplan", bytes);
      }
      if (saved) { setDirty(false); setNotice("工程已保存，包含原始点云、关键帧、复核记录和出图参数，可换机打开。"); } else setNotice("已取消保存。");
    });
  }
  function openProject() {
    if (!canReplace()) return;
    void action("打开测量工程", async () => {
      const f = await openFile("project"); if (!f) return;
      // 工程内已带建筑模型时，点云不可用（文件缺失或无法读取）不拒绝打开：保留建筑模型、复核记录与处置历史，
      // 只是点云对照不可用；依赖点云的操作禁用并提示。源件恢复后重开工程即恢复对照，无需迁移工程文件。
      let sourceMissing = false;
      const loadSource = async (source: SurveySource, keepOnFailure: boolean) => {
        if (!keepOnFailure) return importSource(source);
        try { await importSource(source); } catch (error) { sourceMissing = true; setNotice(`点云对照不可用：${error instanceof Error ? error.message : String(error)}`); }
      };
      let p: SurveyProject;
      if (f.native && f.project) {
        try { validateProjectState(f.project); } catch (error) { void window.surveyDesktop?.release(f.native.token); throw error; }
        const state = f.project as SurveyProject;
        try {
          if(state.pairedReview&&!f.native.keyframePages?.length&&window.surveyDesktop){
            const pages=await window.surveyDesktop.addKeyframePage(f.native.token,state.pairedReview);
            f.native={...f.native,keyframePages:pages};state.activeKeyframePage=pages[0]!.id;
            state.pairedReviewIndex=await window.surveyDesktop.keyframeIndex(f.native.token);
          }
        }catch(error){void window.surveyDesktop?.release(f.native.token);throw error;}
        p = { ...state, source: { name: f.native.name, native: f.native, units: state.source.units, synthetic: state.source.synthetic, clips: state.source.clips, deviceReceipt: state.source.deviceReceipt } };
        try { if (p.pairedReview) await verifyPairedReview(p.pairedReview, p.source); } catch (error) { void window.surveyDesktop?.release(f.native.token); throw error; }
      } else {
        if (f.file && f.file.size > 256 * 1024 ** 2) throw Error("请在 Windows 应用中打开流式大工程。");
        const bytes = f.data ?? await f.file?.arrayBuffer(); if (!bytes) throw Error("工程数据缺失。");
        p = await decodeProject(bytes);
      }
      // 点云先于模型提交（导入会重置模型状态），失败时按“点云对照不可用”继续打开。
      await loadSource(p.source, !!p.building);
      setCloudMissing(sourceMissing); if (sourceMissing) setSource(p.source);
      setPairedReview(p.pairedReview); setActiveKeyframePage(p.activeKeyframePage);  setBuilding(p.building); setAccuracy(p.accuracy); setRenderScene(p.renderScene??{...DEFAULT_RENDER_SCENE}); setProjection(p.projection); setSettings({ ...DEFAULT_CAD_DRAWING_SETTINGS, ...p.settings }); setAnnotations(p.annotations); setDrawing(p.drawing);setStale(p.drawingStale??false); setUnits(p.source.units); setDirty(false);
      setNotice(sourceMissing ? "测量工程已恢复；点云对照不可用，建筑模型、复核记录与处置历史已保留，点云恢复后重开即可恢复对照。" : "测量工程已恢复。");
    });
  }
  function cancel() { brushEpoch.current++; semanticSequence.current++; semanticClient.current?.dispose(); semanticClient.current=undefined; deliverySequence.current++; cancelIfc.current?.(); void window.surveyDesktop?.cancel(); worker.current?.terminate(); worker.current = undefined; pending.current?.reject(Error("已取消分析，原始文件和现有工程保留；下次分析会重新读取完整源点。")); pending.current = undefined; }
  const nav: Array<[View, string, typeof Ruler]> = [["drawing", "点云与 CAD", Ruler], ["delivery", "图纸交付", PackageCheck]];
  const extensions: Array<[View,string,typeof Ruler]> = [["bim","建筑模型",Building2],["render","建筑效果图",Image],["keyframes","关键帧复核",Image]];
  const [splitRatio, setSplitRatio] = useState(0.35);
  const [focusPane, setFocusPane] = useState<"none" | "cloud" | "drawing">("none");
  const [resizing, setResizing] = useState(false);
  /** 进入点云编辑时临时让点云成为主画布；退出时仅在未被手动改动时恢复双栏。 */
  const autoFocusedCloud = useRef(false);
  const focusPaneRef = useRef(focusPane); focusPaneRef.current = focusPane;
  const onCloudEditActive = useCallback((active: boolean) => {
    if (active && focusPaneRef.current === "none") { autoFocusedCloud.current = true; setFocusPane("cloud"); }
    else if (!active && autoFocusedCloud.current) { autoFocusedCloud.current = false; if (focusPaneRef.current === "cloud") setFocusPane("none"); }
  }, []);
  const workBodyRef = useRef<HTMLDivElement>(null);
  const shortcutRef = useRef({ busy, hasSource: !!source, openProject, saveProject });
  shortcutRef.current = { busy, hasSource: !!source, openProject, saveProject };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === "o") {
        e.preventDefault();
        if (!shortcutRef.current.busy) shortcutRef.current.openProject();
      } else if (key === "s") {
        e.preventDefault();
        if (!shortcutRef.current.busy && shortcutRef.current.hasSource) shortcutRef.current.saveProject();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    if (focusPane !== "none") return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    const move = (ev: PointerEvent) => {
      const container = workBodyRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const inspectorWidth = rect.width <= 1220 ? 236 : rect.width <= 1420 ? 252 : 268;
      const available = Math.max(480, rect.width - inspectorWidth - 28);
      const next = (ev.clientX - rect.left - 10) / available;
      setSplitRatio(Math.max(0.24, Math.min(0.62, next)));
    };
    const stop = () => {
      setResizing(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }
  const warningList = drawing?.warnings.filter(w => w.severity === "warning") ?? [];
  const manualDimCount = drawing?.dimensions?.filter(d => d.source === "manual").length ?? 0;

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><Layers size={18}/><strong title={`版本 ${STUDIO_VERSION}`}>Guanyao Survey Studio</strong><small className="version-badge">v{STUDIO_VERSION}</small></div>
      <nav className="main-nav" aria-label="工程流程">
        {nav.map(([id, name, Icon]) => <button key={id} disabled={!!busy} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><Icon size={15}/>{name}</button>)}
        <details className="extensions-menu">
          <summary>扩展{extensions.some(([id])=>id===view)?` · ${extensions.find(([id])=>id===view)![1]}`:''}</summary>
          <div>{extensions.map(([id,name,Icon])=><button key={id} disabled={!!busy} aria-current={view===id?'page':undefined} onClick={e=>{setView(id);e.currentTarget.closest('details')!.open=false;}}><Icon size={15}/>{name}</button>)}</div>
        </details>
      </nav>
      <div className="header-project">
        <div className={`file-name ${dirty ? "is-dirty" : ""}`} title={cloudMissing ? `点云对照不可用：${source?.name ?? "源件缺失"}` : source?.name ?? "未打开工程"}>{cloudMissing ? "点云对照不可用" : source?.name ?? "未打开工程"}{dirty ? " · 未保存" : ""}</div>
        <div className="header-actions">
          <button disabled={!!busy} title="打开测量工程 (Ctrl+O)" onClick={openProject}><FolderOpen size={15}/>打开工程</button>
          <button disabled={!source || !!busy} title="保存测量工程 (Ctrl+S)" onClick={saveProject}><FileDown size={15}/>保存工程</button>
        </div>
      </div>
    </header>
    {deviceImport && <DeviceImport busy={!!busy} onClose={()=>setDeviceImport(false)} onNotice={setNotice} onReceive={receiveSource}/>}
    {view === "drawing" ? <main className="drawing-workspace">
      <div className="work-toolbar">
        <div className="toolbar-status">
          {source?.synthetic && <span className="status-pill warning">合成示例</span>}
          {stale && <span className="status-pill stale">图纸待更新</span>}
          {focusPane !== "none" && <button className="layout-reset-chip" onClick={() => setFocusPane("none")}>恢复双栏对照</button>}
        </div>
        <div className="toolbar-group">
          <label className="inline-field">下次导入单位<select aria-label="源文件坐标单位" disabled={!!busy} value={units} onChange={e => setUnits(e.target.value as SourceUnit)}><option value="m">米</option><option value="mm">毫米</option></select></label>
          <button disabled={!!busy} onClick={importFile}><FolderOpen size={15}/>导入测量成果</button>
          {window.surveyDesktop && <button disabled={!!busy} onClick={()=>{if(canReplace())setDeviceImport(true);}}>从设备接收</button>}
          <button disabled={!!busy} onClick={() => { if (canReplace()) void action("载入合成示例", () => importSource({ name: "合成房间示例.pcd", bytes: demoRoom(), units: "m", synthetic: true })); }}>打开示例</button>
          <span className="toolbar-divider" aria-hidden="true"/>
          <button className="primary" disabled={!cloud || !!busy} onClick={generate}><Play size={14}/>{stale ? "更新工程图" : "生成工程图"}</button>
        </div>
      </div>
      {source && importCheck && <div className={`import-check-bar ${importCheck.suspicious ? "is-suspicious" : ""}`} role="group" aria-label="导入单位与范围核对">
        <div className="import-check-items">
          <span className="import-check-pill">源单位 {SOURCE_UNIT_LABELS[source.units]}</span>
          {source.deviceReceipt && <span className="import-check-note">设备清单未提供单位</span>}
          <span className="import-check-stat">范围 {importCheck.sizeM.map(v => v.toFixed(2)).join(" × ")} m</span>
          <span className="import-check-stat">{importCheck.pointCount.toLocaleString()} 点</span>
          {importCheck.suspicious && <span className="import-check-warning">范围可疑{importCheck.reasons.length ? ` · ${importCheck.reasons.slice(0, 2).join(" ")}` : ""}</span>}
        </div>
        <button className="import-switch-btn" disabled={!!busy} onClick={() => switchUnits(source.units === "m" ? "mm" : "m")}>{source.units === "m" ? "按毫米重新导入" : "按米重新导入"}</button>
      </div>}
      <div
        ref={workBodyRef}
        className={`work-body ${focusPane !== "none" ? `focus-${focusPane}` : ""} ${resizing ? "is-resizing" : ""}`}
        style={{ "--cloud-fr": `${splitRatio.toFixed(3)}fr`, "--drawing-fr": `${(1 - splitRatio).toFixed(3)}fr` } as React.CSSProperties}
      >
        <section className={`pane cloud-pane ${focusPane === "drawing" ? "is-collapsed" : ""}`}>
          <header>
            <strong>原始测量成果</strong>
            <div className="pane-header-meta">
              <span>{cloud ? `${(cloud.sourcePointCount ?? cloud.visible.length).toLocaleString()} 点 · 显示 ${cloud.visible.length.toLocaleString()}` : "PCD / PLY / LAS / LAZ"}</span>
              <button className="pane-focus-btn" aria-pressed={focusPane === "cloud"} title={focusPane === "cloud" ? "恢复双栏对照" : "展开点云视图"} onClick={() => { autoFocusedCloud.current = false; setFocusPane(focusPane === "cloud" ? "none" : "cloud"); }}>{focusPane === "cloud" ? "双栏" : "展开"}</button>
            </div>
          </header>
          <CloudView cloud={cloud} busy={!!busy} editing={pendingBrushes>0} onBrush={queueBrush} onEditActive={onCloudEditActive} onClip={rule => clean([...(source?.clips ?? []), rule])} canUndo={!!editHistory.undo.length} canRedo={!!editHistory.redo.length} clipCount={source?.clips?.length ?? 0} onUndo={() => clean(editHistory.undo.at(-1)!, "undo")} onRedo={() => clean(editHistory.redo.at(-1)!, "redo")} onRestore={() => clean([])}/>
          <div className="clean-history">
            {source?.deviceReceipt && <span>设备接收已校验 · {source.deviceReceipt.captureIntegrity === "passed" ? "采集完整性检查通过" : source.deviceReceipt.captureIntegrity === "warning" ? "采集完整性有告警" : "采集完整性待核实"} · 工程质量待核实</span>}
            <span>{source?.clips?.length ?? 0} 次清理 · 预览保留 {cloud ? Array.from(cloud.visible).reduce((a, b) => a + b, 0).toLocaleString() : 0} 点</span>
          </div>
        </section>
        {focusPane === "none" && <div
          className="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整点云与图纸宽度比例"
          tabIndex={0}
          title="拖动调整宽度 · 双击复位"
          onPointerDown={startResize}
          onDoubleClick={() => setSplitRatio(0.35)}
          onKeyDown={e => {
            if (e.key === "ArrowLeft") { e.preventDefault(); setSplitRatio(r => Math.max(0.24, +(r - 0.03).toFixed(2))); }
            else if (e.key === "ArrowRight") { e.preventDefault(); setSplitRatio(r => Math.min(0.62, +(r + 0.03).toFixed(2))); }
            else if (e.key === "Home") { e.preventDefault(); setSplitRatio(0.35); }
          }}
        />}
        <section className={`pane drawing-pane ${focusPane === "cloud" ? "is-collapsed" : ""}`}>
          <header>
            <strong>工程图纸</strong>
            <div className="pane-header-meta">
              <span className={stale ? "is-stale" : ""}>{stale ? "参数已变更，待更新" : drawing ? `${drawing.statistics.observedWallEntities} 个墙体图元 · mm` : "未生成"}</span>
              <button className="pane-focus-btn" aria-pressed={focusPane === "drawing"} title={focusPane === "drawing" ? "恢复双栏对照" : "展开工程图纸"} onClick={() => setFocusPane(focusPane === "drawing" ? "none" : "drawing")}>{focusPane === "drawing" ? "双栏" : "展开"}</button>
            </div>
          </header>
          <div className="drawing-canvas">
            {drawing ? <CadPreview lightMode dimensionMode={dimensionMode} onCreateDimension={addDimension} onDeleteDimension={id=>drawing&&changeDimensions(drawing.dimensions?.filter(d=>d.id!==id)??[])} model={drawing} stale={stale} projection={projection} annotations={annotations} placingAnnotation={placing} selectedAnnotationId={selectedAnnotationId} onPlaceAnnotation={point => { if (!placing || stale || busy) return; changeAnnotations([...annotations, { ...placing, id: crypto.randomUUID(), x: point[0], y: point[1], coordinateSpace: "drawing-mm", projection }]); setPlacing(undefined); }} onMoveAnnotation={(id, p) => { if (stale || busy) return; changeAnnotations(annotations.map(a => a.id === id ? { ...a, x: p[0], y: p[1], coordinateSpace: "drawing-mm" } : a)); }} onDeleteAnnotation={id => { if (!stale && !busy) changeAnnotations(annotations.filter(a => a.id !== id)); }} onSelectedAnnotationChange={setSelectedAnnotationId}/> : <div className="cad-preview-empty">
              <div className="empty-card">
                <Ruler size={22}/>
                <strong>暂无工程图纸</strong>
                <span>{cloud ? "点击上方“生成工程图”提取墙体轮廓" : "请先导入测量成果或打开示例"}</span>
              </div>
            </div>}
          </div>
        </section>
        <aside className="inspector">
          <div className="inspector-section">
            <h2>出图设置</h2>
            <label>分析方式<select aria-label="分析方式" value={settings.orthogonalizeWalls ? "walls" : "projection"} disabled={!!busy} onChange={e => updateSettings({ orthogonalizeWalls: e.target.value === "walls" })}><option value="walls">墙线拟合 · 平面推荐</option><option value="projection">投影证据轮廓 · 复核用</option></select></label>
            <div className="inspector-grid-2">
              <label>出图朝向<select aria-label="出图朝向" value={settings.alignToPrincipalAxis?"building":"source"} disabled={!!busy||projection!=="xy"||!settings.orthogonalizeWalls} onChange={e=>updateSettings({alignToPrincipalAxis:e.target.value==="building"})}><option value="building">建筑主轴</option><option value="source">采集坐标</option></select></label>
              <label>图纸视图<select aria-label="图纸视图" value={projection} disabled={!!busy} onChange={e => { setProjection(e.target.value as CadProjection); setPlacing(undefined); if (drawing) setStale(true); setDirty(true); }}><option value="xy">平面 · XY</option><option value="xz">正立面 · XZ</option><option value="yz">侧立面 · YZ</option></select></label>
            </div>
            <div className="inspector-grid-3">
              <label>图幅<select aria-label="图幅" value={settings.paperSize} disabled={!!busy} onChange={e => updateSettings({ paperSize: e.target.value as CadDrawingSettings["paperSize"] })}>{["A4", "A3", "A2", "A1", "A0"].map(s => <option key={s}>{s}</option>)}</select></label>
              <label>比例<select aria-label="出图比例" value={settings.scale} disabled={!!busy} onChange={e => updateSettings({ scale: e.target.value })}>{["1:50", "1:100", "1:200"].map(s => <option key={s}>{s}</option>)}</select></label>
              <label>尺寸取整<select aria-label="尺寸取整 mm" disabled={!!busy} value={settings.roundingMm} onChange={e=>updateSettings({roundingMm:Number(e.target.value)})}>{[.1,1,5,10].map(v=><option key={v} value={v}>{v} mm</option>)}</select></label>
            </div>
          </div>
          <div className="inspector-section">
            <h2>尺寸标注</h2>
            <div className="inspector-inline-action">
              <label>方向<select aria-label="尺寸方向" value={dimensionKind} onChange={e=>{setDimensionKind(e.target.value as CadDimension['kind']);setDimensionMode(undefined);}}><option value="aligned">对齐</option><option value="horizontal">水平</option><option value="vertical">垂直</option></select></label>
              <button aria-pressed={!!dimensionMode} disabled={!drawing||stale||!!busy} onClick={()=>{setPlacing(undefined);setDimensionMode(dimensionMode?undefined:dimensionKind);}}>标注尺寸</button>
            </div>
            <div className="cad-history">
              <button disabled={!cadHistory.undo.length||stale||!!busy} onClick={()=>changeDimensions(cadHistory.undo.at(-1)!,'undo')}>撤销尺寸</button>
              <button disabled={!cadHistory.redo.length||stale||!!busy} onClick={()=>changeDimensions(cadHistory.redo.at(-1)!,'redo')}>重做尺寸</button>
            </div>
          </div>
          <div className="inspector-section">
            <h2>工程标注</h2>
            <div className="inspector-grid-2">
              <label>类型<select aria-label="标注类型" value={category} onChange={e => setCategory(e.target.value as typeof category)}><option value="text">文字说明</option><option value="room">房间标签</option><option value="door">门标签</option><option value="window">窗标签</option></select></label>
              <label>内容<input aria-label="标注内容" placeholder="输入标签文本" value={label} maxLength={100} onChange={e => setLabel(e.target.value)}/></label>
            </div>
            <button disabled={!drawing || stale || !label.trim() || !!busy} onClick={() => {setDimensionMode(undefined);setPlacing({ text: label.trim(), category });}}>{placing ? "重新选择标注" : "在图纸放置标注"}</button>
          </div>
          <div className="inspector-section inspector-footer">
            <h2>成果检查</h2>
            {drawing ? <>
              <p className="stats-summary">{drawing.statistics.sourcePointCount.toLocaleString()} 个源点 · {annotations.length} 条人工标注</p>
              <details className="warnings-box">
                <summary>{warningList.length} 项复核提示</summary>
                <div className="warnings-list">{warningList.map(w => <p className="help" key={w.code}>{w.message}</p>)}</div>
              </details>
            </> : null}
            <button className="primary export" disabled={!drawing || stale || !!busy} onClick={exportCad}><PackageCheck size={15}/>导出 DXF 成果包</button>
          </div>
        </aside>
      </div>
    </main>
    : view === "keyframes" ? <PairedWorkspace pages={source?.native?.keyframePages} activePage={activeKeyframePage} onPage={switchKeyframePage} review={pairedReview} cloud={cloud} busy={!!busy} onImport={importFrames} onChange={r=>{setPairedReview(r);setDirty(true);}} onExport={exportReview} model={building} onBuild={buildPairedModel} onAdd={addPairedOpening} onLink={linkPairedOpening} onRecognize={recognizeFrames}/>
    : view === "bim" ? <><div className="extension-delivery"><button disabled={!building||!!busy} onClick={exportUnified}>导出 CAD / BIM 复核包</button></div><BuildingWorkspace accuracy={accuracy} onAccuracy={r=>{setAccuracy(r);setDirty(true);}} onElevation={getWallElevation} model={building} source={source} cloud={cloud} cloudMissing={cloudMissing} busy={!!busy} onChange={changeBuilding} onGenerate={generateBuilding} onExport={exportBuilding} onDrawing={modelDrawing} onNotice={setNotice} canUndo={!!modelHistory.undo.length} canRedo={!!modelHistory.redo.length} onUndo={()=>changeBuilding(modelHistory.undo.at(-1),"undo")} onRedo={()=>changeBuilding(modelHistory.redo.at(-1),"redo")}/></>
    : view === "delivery" ? <main className="delivery-view">
      <div className="delivery-shell">
        <div className="delivery-grid">
          <div className="delivery-row">
            <Ruler size={20}/>
            <div>
              <div className="delivery-title-line">
                <h2>CAD 图纸成果包</h2>
                {(!drawing || stale) && <span className="delivery-state disabled">{!drawing ? "未生成" : "待更新"}</span>}
              </div>
              <p>DXF 图纸、尺寸标注与复核清单</p>
              {drawing && <div className="delivery-meta"><span>墙体图元 {drawing.statistics.observedWallEntities}</span>{manualDimCount > 0 && <span>人工尺寸 {manualDimCount}</span>}<span>复核提示 {warningList.length} 项</span></div>}
            </div>
            <button className="primary" disabled={!drawing || stale || !!busy} onClick={exportCad}>导出成果包</button>
          </div>
          <div className="delivery-row">
            <FileDown size={20}/>
            <div>
              <div className="delivery-title-line">
                <h2>测绘图纸 PDF</h2>
                {(!window.surveyDesktop || !drawing || stale) && <span className="delivery-state disabled">{!window.surveyDesktop ? "桌面版可用" : !drawing ? "未生成" : "待更新"}</span>}
              </div>
              <p>{drawing ? `${drawing.paperSize} · ${drawing.scale} · 等比例打印图纸` : "图幅 · 比例 · 等比例打印图纸"}</p>
            </div>
            <button disabled={!drawing||stale||!!busy||!window.surveyDesktop} onClick={exportPdf}>导出 PDF</button>
          </div>
          <div className="delivery-row">
            <FolderOpen size={20}/>
            <div>
              <div className="delivery-title-line">
                <h2>可恢复测量工程</h2>
                {!source && <span className="delivery-state disabled">未打开</span>}
              </div>
              <p>保存点云、清理记录与出图参数，支持跨机恢复</p>
            </div>
            <button disabled={!source || !!busy} onClick={saveProject}>保存 .pvplan</button>
          </div>
        </div>
        <footer className="delivery-notice">复核用途，墙体、门窗与独立尺寸仍需核验。</footer>
      </div>
    </main>
    : <RenderWorkspace model={building} settings={renderScene} stale={!!building&&!!source&&building.sourceStamp!==sourceStamp(source)} busy={!!busy} onChange={s=>{setRenderScene(s);setDirty(true);}} onNotice={setNotice} onBuilding={()=>setView("bim")} onExporting={active=>setBusy(active?"保存建筑效果图与约束":"")}/>}
    <footer className="status-bar" role="status"><span>{busy || notice}</span>{busy && !busy.startsWith("保存建筑效果图") && <button onClick={cancel}><X size={14}/>取消分析</button>}</footer>
  </div>;
}
