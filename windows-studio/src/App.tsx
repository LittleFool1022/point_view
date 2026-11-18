import {STUDIO_VERSION} from "./version";
import {createCadSheet,restyleCadDrawing} from "../../src/cad/sheet";
import { appendDimension, type CadDimension } from "../../src/cad/dimensions";
import { createCadConnection, manualCadConnections, openCadEndpoints, suggestCadConnections, withCadConnections, type CadConnectionEntity, type CadConnectionStyle, type CadEndpoint } from "../../src/cad/connections";
import type {ElevationOptions,WallElevation} from "./pipeline/wallElevation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, FileDown, Ruler, Building2, Image, PackageCheck, Layers, Play, X } from "lucide-react";
import type { PointCloudData } from "../../src/domain/types";
import type { CadProjection } from "../../src/cad/geometry";
import { DEFAULT_CAD_DRAWING_SETTINGS, cadEntityPoints, type DrawingModel, type CadAnnotation, type CadDrawingSettings, type CadLineEntity } from "../../src/cad/model";
import { createSurveyDelivery } from "./domain/delivery";
import { createMultiViewSurveyDelivery, renderMultiViewPdf } from "./domain/multiViewDelivery";
import { createMultiViewDrawing, MULTI_VIEW_ORDER, type MultiViewModels } from "../../src/cad/multiView";
import { CadPreview } from "../../src/components/CadPreview";
import { isAutoCleanRule, type AutoCleanOperation, type ClipRule, type EditedPointCloud } from "./domain/cleaning";
import type {AutoCleanSuggestion} from './pipeline/autoClean';
import type {BrushStroke,BrushEditResult} from "./domain/brush";
import { PairedWorkspace } from "./PairedWorkspace";
import { DeviceImport } from "./DeviceImport";
import type { OpenedInput } from "./domain/source";
import { buildingFromPairedReview, addKeyframeOpening, linkKeyframeOpening, type OpeningPlacement } from "./domain/pairedBuilding";
import { createUnifiedDelivery, type IfcArtifact } from "./domain/unifiedDelivery";
import { MAX_PAIRED_BYTES, cameraForFrame, verifyPairedReview, sha256, type PairedCandidate, type PairedReview } from "./domain/pairedReview";
import {SemanticClient} from "./pipeline/semanticClient";
import {AnalysisClient} from "./analysisClient";
import {mergeSemanticCandidates} from "./pipeline/semanticCore";
import { CloudView } from "./CloudView";
import { openFile, saveFile } from "./platform";
import { demoRoom } from "./domain/demo";
import type { SurveySource } from "./domain/project";
import { readOpenedProject, writeSurveyProject } from "./projectIo";
import type { AccuracyRecord } from "./domain/accuracy";
import type { SourceUnit } from "./pipeline/analysis";
import type {CloudMeasuredPoint,CloudPointRay} from './domain/measurement';

import { RenderWorkspace } from "./RenderWorkspace";
import { DEFAULT_RENDER_SCENE, type RenderSceneSettings } from "./domain/renderScene";
import { BuildingWorkspace } from "./BuildingWorkspace";
import { validateBuilding, buildingQuantities, type BuildingModel } from "./domain/building";
import { sourceStamp, type BuildingOptions } from "./domain/buildingOps";
import { drawingFromBuilding, annotateSurveyDrawing } from "./domain/buildingDrawing";
import { zipSync, strToU8 } from "fflate";

type View = "keyframes" | "drawing" | "bim" | "render" | "delivery";
type CadSnapshot={drawing:DrawingModel;annotations:CadAnnotation[]};
const conciseProgress=(stage:string)=>/保存|导出|打包|PDF|打印/.test(stage)?'正在保存成果…':/读取|导入|接收/.test(stage)?'正在读取测量成果…':/墙|图纸|投影|出图/.test(stage)?'正在生成工程图…':/清理|笔画|源点/.test(stage)?'正在更新点云…':'正在处理…';
type SourceFootprint={min:[number,number];max:[number,number]};
function drawingSourceFootprint(model:DrawingModel):SourceFootprint|undefined{
  const points=model.entities.filter(entity=>entity.layer==='OBSERVED_WALL').flatMap(cadEntityPoints);if(!points.length)return undefined;
  const angle=model.parameters.planAlignment?.angleRadians??0,cs=Math.cos(angle),sn=Math.sin(angle);
  const source=points.map(point=>[(point[0]*cs+point[1]*sn)/1000,(-point[0]*sn+point[1]*cs)/1000]);
  const pad=.2,min:[number,number]=[Math.min(...source.map(p=>p[0]!))-pad,Math.min(...source.map(p=>p[1]!))-pad],max:[number,number]=[Math.max(...source.map(p=>p[0]!))+pad,Math.max(...source.map(p=>p[1]!))+pad];
  return {min,max};
}
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
  const [drawingHistory,setDrawingHistory]=useState<{undo:CadSnapshot[];redo:CadSnapshot[]}>({undo:[],redo:[]}),[cadLayoutMode,setCadLayoutMode]=useState(false);
  const [connectionMode,setConnectionMode]=useState(false);
  const [drawing, setDrawing] = useState<DrawingModel>(), [projection, setProjection] = useState<CadProjection>("xy"), [units, setUnits] = useState<SourceUnit>("m");
  const [multiViewModels,setMultiViewModels]=useState<MultiViewModels>();
  const [settings, setSettings] = useState<CadDrawingSettings>({ ...DEFAULT_CAD_DRAWING_SETTINGS,alignToPrincipalAxis:true,roundingMm:1,dimensionUnit:'m' });
  const [annotations, setAnnotations] = useState<CadAnnotation[]>([]), [label, setLabel] = useState(""), [category, setCategory] = useState<NonNullable<CadAnnotation["category"]>>("text");
  const [placing, setPlacing] = useState<Pick<CadAnnotation, "text" | "category">>(), [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const [busy, setBusy] = useState(""), [notice, setNotice] = useState(""), [stale, setStale] = useState(false), [dirty, setDirty] = useState(false);
  const [autoCleanState, setAutoCleanState] = useState<{
    outdoorRemoved: number;
    indoorRemoved: number;
    visibleBefore: number;
    discoveredWallCount: number;
    wallsChanged: boolean;
    warnings: string[];
    applied: boolean;
    mode: "after" | "before" | "candidates";
    beforeVisible?: Uint8Array;
    highlightMask?: Uint8Array;
  }>();
  const analysis=useRef<AnalysisClient|undefined>(undefined);if(!analysis.current)analysis.current=new AnalysisClient(stage=>setBusy(current=>current?conciseProgress(stage):current));
  const actionSequence=useRef(0),actionOwner=useRef(0),sourceRevision=useRef(0),editRevision=useRef(0);
  useEffect(() => () => analysis.current?.dispose(), []);
  useEffect(() => window.surveyDesktop?.onProgress(stage => setBusy(current => current ? conciseProgress(stage) : current)), []);
  useEffect(() => { const unload = (e: BeforeUnloadEvent) => { if (dirty || busy) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", unload); return () => window.removeEventListener("beforeunload", unload); }, [dirty, busy]);
  const extensionsMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setPlacing(undefined); setDimensionMode(undefined); setConnectionMode(false); if (extensionsMenuRef.current) extensionsMenuRef.current.open = false; } };
    const outside = (e: PointerEvent) => { if (extensionsMenuRef.current?.open && e.target instanceof Node && !extensionsMenuRef.current.contains(e.target)) extensionsMenuRef.current.open = false; };
    window.addEventListener("keydown", esc); window.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("keydown", esc); window.removeEventListener("pointerdown", outside); };
  }, []);
  function request<T>(data: object): Promise<T> { return analysis.current!.request<T>(data); }
  function pickMeasuredPoint(ray:CloudPointRay):Promise<CloudMeasuredPoint>{
    if(!source)return Promise.reject(Error('请先导入点云。'));
    return request<CloudMeasuredPoint>({action:'pick-point',source,ray});
  }
  async function action(stage: string, callback: (isCurrent:()=>boolean) => Promise<void>, propagate=false) {
    const owner=++actionSequence.current;actionOwner.current=owner;setBusy(stage);
    const isCurrent=()=>actionOwner.current===owner;
    try { await callback(isCurrent); } catch (e) { if(isCurrent())setNotice(e instanceof Error ? e.message : String(e));if(propagate)throw e; } finally { if(isCurrent()){actionOwner.current=0;setBusy("");} }
  }
  function markDirty(){editRevision.current++;setDirty(true);}
  async function importSource(input: SurveySource,isCurrent:()=>boolean=()=>true):Promise<boolean> {
    const sourceBytes=input.bytes??(input.native?undefined:await input.file?.arrayBuffer()),sourceSha256=input.sha256??input.native?.sha256??(sourceBytes?await sha256(sourceBytes):undefined);
    const next = { ...input, sha256:sourceSha256, key: crypto.randomUUID() };
    if(!isCurrent()){if(next.native&&next.native.token!==source?.native?.token)void window.surveyDesktop?.release(next.native.token);return false;}
    try {
      const decoded = await request<PointCloudData>({ action: "import", source: next });
      if(!isCurrent()){if(next.native&&next.native.token!==source?.native?.token)void window.surveyDesktop?.release(next.native.token);return false;}
      if(next.deviceReceipt && decoded.sourcePointCount !== next.deviceReceipt.points)throw Error("设备点数回执与完整点云不一致，未替换当前工程。");
      if (source?.native && source.native.token !== next.native?.token) void window.surveyDesktop?.release(source.native.token);
      sourceRevision.current++;brushEpoch.current++; brushCount.current = 0; setPendingBrushes(0);
      setPairedReview(undefined); setActiveKeyframePage(undefined); setBuilding(undefined); setAccuracy(undefined); setRenderScene({...DEFAULT_RENDER_SCENE}); setModelHistory({undo:[],redo:[]});
      setAutoCleanState(undefined);
      setEditHistory({ undo: (next.clips ?? []).map((_, i) => next.clips!.slice(0, i)), redo: [] });
      setSource(next); setCloud(decoded); setDrawing(undefined);setMultiViewModels(undefined); setDrawingHistory({undo:[],redo:[]});setDimensionMode(undefined);setConnectionMode(false);setAnnotations([]); setPlacing(undefined); setStale(false); markDirty(); setView("drawing"); setNotice(`已导入 ${next.name} · ${(decoded.sourcePointCount ?? decoded.visible.length).toLocaleString()} 点 · 显示 ${decoded.visible.length.toLocaleString()} 点${next.synthetic ? " · 合成示例，非实测" : ""}`);
      return true;
    } catch (e) { if (next.native && next.native.token !== source?.native?.token) void window.surveyDesktop?.release(next.native.token); throw e; }
  }
  const canReplace = () => !dirty || window.confirm("当前工程有未保存的更改，是否放弃并打开其他成果？");
  function importFile() { if (!canReplace()) return; void action("读取测量成果", async isCurrent => { const f = await openFile("cloud"); if(!isCurrent()){if(f?.native)void window.surveyDesktop?.release(f.native.token);return;} if (f) await importSource({ name: f.name, bytes: f.data, file: f.file, native: f.native, units, synthetic: false },isCurrent); }); }
  function openDemo() { if (canReplace()) void action("载入合成示例", async isCurrent => {await importSource({ name: "合成房间示例.pcd", bytes: demoRoom(), units: "m", synthetic: true },isCurrent);}); }
  function openDeviceImport() { if(canReplace())setDeviceImport(true); }
  async function receiveSource(file: OpenedInput) {
    const input:SurveySource={name:file.name,native:file.native,deviceReceipt:file.deviceReceipt,units:"m",synthetic:false};
    await action("导入完整点云与原图卷",async isCurrent=>{
      const first=file.native?.keyframePages?.[0];let review:PairedReview|undefined;
      if(first&&file.native&&window.surveyDesktop){
        try{review=JSON.parse(new TextDecoder().decode(await window.surveyDesktop.keyframePage(file.native.token,first.id)));if(!isCurrent())throw Error("已取消工程接收。");await verifyPairedReview(review!,input);if(!isCurrent())throw Error("已取消工程接收。");}
        catch(error){await window.surveyDesktop.release(file.native.token);throw error;}
      }
      const imported=await importSource(input,isCurrent);if(imported&&review&&isCurrent()){setPairedReview(review);setActiveKeyframePage(first!.id);}
    },true);
  }
  async function persistKeyframeIndex() {
    if(!source?.native?.keyframePages?.length||!window.surveyDesktop)return undefined;
    if(pairedReview&&activeKeyframePage)await window.surveyDesktop.updateKeyframePage(source.native.token,activeKeyframePage,pairedReview);
    return window.surveyDesktop.keyframeIndex(source.native.token);
  }
  function switchKeyframePage(id:string){
    if(!source?.native||!window.surveyDesktop||id===activeKeyframePage||busy)return;
    void action("恢复关键帧原图卷",async isCurrent=>{
      if(pairedReview&&activeKeyframePage)await window.surveyDesktop!.updateKeyframePage(source.native!.token,activeKeyframePage,pairedReview);
      if(!isCurrent())return;
      const review:PairedReview=JSON.parse(new TextDecoder().decode(await window.surveyDesktop!.keyframePage(source.native!.token,id)));
      await verifyPairedReview(review,source);if(!isCurrent())return;
      setPairedReview(review);setActiveKeyframePage(id);markDirty();
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
      setPairedReview(next); markDirty(); setNotice("关键帧原图与点云校验通过，可联合复核门窗候选。");
    });
  }
  function exportReview() {
    if (!pairedReview) return;
    void action("保存关键帧复核记录", async isCurrent => {
      const frames=(await persistKeyframeIndex())??pairedReview.frames.map(({ id, name, sha256, cameraId, inference, candidates }) => ({ id, name, sha256, cameraId: cameraId ?? "front", inference, candidates }));if(!isCurrent())return;
      const record = { schema: "survey-keyframe-decisions/1", session: pairedReview.session, sourceSha256: pairedReview.sourceSha256, model: pairedReview.model, frameId: pairedReview.frameId, poseSpace: pairedReview.poseSpace, captureQuality: pairedReview.captureQuality, alignmentVerified: pairedReview.alignmentVerified, constructionAccepted: false, frames };
      const saved=await saveFile("门窗关键帧复核.json", strToU8(JSON.stringify(record, null, 2)));if(!isCurrent())return;
      setNotice(saved ? "门窗复核记录已保存，包含源件关联、类别修正与人工意见。" : "已取消保存。");
    });
  }
  function recognizeFrames(frameIds:string[]) {
    if(!source||!pairedReview||!frameIds.length)return;
    const operationId=++semanticSequence.current,revision=sourceRevision.current;
    void action("载入本地 AI 评估引擎",async isCurrent=>{
      let next=pairedReview;const client=semanticClient.current??(semanticClient.current=new SemanticClient());
      const checkCurrent=()=>{if(!isCurrent()||operationId!==semanticSequence.current||revision!==sourceRevision.current)throw Error("已取消本地识别。");};
      try {
        await verifyPairedReview(next,source);checkCurrent();
        if(!next.walls.length){const walls=await request<PairedReview["walls"]>({action:"paired-walls",source});checkCurrent();next={...next,walls};setPairedReview(next);markDirty();}
        for(const [index,frameId] of frameIds.entries()){
          checkCurrent();
          const frame=next.frames.find(f=>f.id===frameId);if(!frame)throw Error("当前原图已变化。");
          const camera=cameraForFrame(next,frame);setBusy(`本地 AI 识别 ${index+1}/${frameIds.length} · ${frame.name}`);
          const inferred=await client.run(frame,camera);checkCurrent();
          if(next.model.id==="unassigned"&&next.model.revision==="none"&&next.frames.every(f=>!f.analyzed&&!f.candidates.length))next={...next,model:{id:inferred.modelId,revision:inferred.modelRevision}};
          if(inferred.modelId!==next.model.id||inferred.modelRevision!==next.model.revision)throw Error("附件识别模型与本地评估引擎不一致，原有观察已保留。");
          const candidates=await request<PairedCandidate[]>({action:"keyframe-support",source,focus:{camera,frame},pairedWalls:next.walls,candidates:inferred.candidates,instances:inferred.instances});
          checkCurrent();
          next={...next,frames:next.frames.map(f=>f.id===frameId?{...f,analyzed:true,candidates:mergeSemanticCandidates(f.candidates,candidates),inference:{engine:"onnxruntime-web",version:"1.31.1",modelSha256:inferred.modelSha256,preprocessing:"RGB-antialias-triangle-512-imagenet/1",supportPolicy:"all-visible-source-3cm-voxel-8px-disc-near-depth-7m/1",inputSourcePoints:cloud?.sourcePointCount??0}}:f)};
          setPairedReview(next);markDirty();
        }
        setNotice(`本地 AI 已完成 ${frameIds.length} 帧识别并关联完整源点；已有人工意见保留，新增候选待复核。`);
      }catch(error){client.dispose();if(semanticClient.current===client)semanticClient.current=undefined;throw error;}
    });
  }
  function confirmDrawingReplacement(includeAnnotations:boolean) {
    const items:string[]=[];
    if(drawingHistory.undo.length||drawingHistory.redo.length||drawing?.dimensions?.some(d=>d.source==='manual')||(drawing&&manualCadConnections(drawing).length)||drawing?.entities.some(e=>e.source==='manual'&&e.type!=='text'))items.push('人工编辑及其历史');
    if(includeAnnotations&&annotations.length)items.push(`${annotations.length} 条人工标注`);
    return !items.length||window.confirm(`重新生成图纸将清除${items.join('、')}，请先保存工程。是否继续？`);
  }
  function buildPairedModel() {
    if(!source||!pairedReview||building||!confirmDrawingReplacement(true))return;
    void action("由同会话墙带建立建筑草案与平面图",async()=>{
      const review=pairedReview.walls.length?pairedReview:{...pairedReview,walls:await request<PairedReview["walls"]>({action:"paired-walls",source})};
      if(review!==pairedReview)setPairedReview(review);
      const next=await buildingFromPairedReview(source,review),committed={...next,revision:next.revision+1};
      changeBuilding(next);
      const nextDrawing=drawingFromBuilding(committed,committed.levels[0]!.id,settings,cloud?.sourcePointCount??0);nextDrawing.sourceSha256=source.sha256??source.native?.sha256;
      setDrawingHistory({undo:[],redo:[]});setDimensionMode(undefined);setConnectionMode(false);setSelectedAnnotationId(undefined);setDrawing(nextDrawing);setAnnotations([]);setProjection("xy");setStale(false);
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
    const operationId=++deliverySequence.current,revision=sourceRevision.current;
    void action("生成同修订 CAD、IFC 与交付清单",async isCurrent=>{
      const checkCancelled=()=>{if(!isCurrent()||operationId!==deliverySequence.current||revision!==sourceRevision.current)throw Error("已取消统一成果生成。");};
      const parameters=drawing?.parameters as {buildingId?:string;buildingRevision?:number;buildingLevelId?:string}|undefined;
      const reviewIndex=await persistKeyframeIndex();checkCancelled();
      const result=await createUnifiedDelivery({source,model:building,accuracy,review:pairedReview,reviewIndex,settings,pointCount:cloud?.sourcePointCount??0,annotations,annotationLevelId:parameters?.buildingId===building.id&&parameters.buildingRevision===building.revision&&!stale?parameters.buildingLevelId:undefined,makeIfc:m=>{checkCancelled();return runIfc(m,"review");},checkCancelled});
      checkCancelled();
      const saved=await saveFile("建筑同修订复核成果.zip",result.archive);checkCancelled();
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
      setCloud(preview); setSource(next); setAutoCleanState(undefined); if (drawing) setStale(true); markDirty();
      setNotice(`已应用 ${nextRules.length} 次清理；原始 PCD 保留，图纸需重新生成。`);
    });
  }
  function applyClip(rule:ClipRule) {
    const current=source?.clips??[];
    if(!('axis' in rule)||rule.axis!=='z'||rule.mode!=='keep'){clean([...current,rule]);return;}
    // 高度范围是当前过滤器而非逐次叠加的裁切；兼容并合并旧工程已累积的同类规则。
    const first=current.findIndex(clip=>'axis' in clip&&clip.axis==='z'&&clip.mode==='keep');
    const next=current.filter((clip,index)=>!('axis' in clip)||clip.axis!=='z'||clip.mode!=='keep'||index===first);
    if(first<0)next.push(rule);else next[first]=rule;
    clean(next);
  }
  type AutoCleanPreviewResult = AutoCleanSuggestion & { beforeVisible: Uint8Array; highlightMask: Uint8Array };
  type AutoCleanRunResult = AutoCleanSuggestion & { clips: ClipRule[]; preview: PointCloudData; compare: { beforeVisible: Uint8Array; highlightMask: Uint8Array } };
  function formatAutoCleanWallSummary(result: Pick<AutoCleanSuggestion, "outdoorRemoved" | "indoorRemoved" | "discoveredWallCount">) {
    const total = result.outdoorRemoved + result.indoorRemoved;
    const wallNote = result.discoveredWallCount > 0
      ? `新发现 ${result.discoveredWallCount} 段墙线（出图将放入推断复核层）`
      : "本次墙线保持不变";
    return `已清理 ${total.toLocaleString()} 点（室外 ${result.outdoorRemoved.toLocaleString()} / 室内 ${result.indoorRemoved.toLocaleString()}），${wallNote}`;
  }
  function previewAutoCleaning() {
    if (!source || busy) return;
    if (settings.autoCleanOutdoor === false && settings.autoCleanIndoor === false) { setNotice("请先勾选需要执行的自动清理。"); return; }
    void action("预检自动清理候选点", async isCurrent => {
      const result = await request<AutoCleanPreviewResult>({ action: "preview-auto-clean", source, autoOptions: { outdoor: settings.autoCleanOutdoor !== false, indoor: settings.autoCleanIndoor !== false } });
      if (!isCurrent()) return;
      setAutoCleanState({
        outdoorRemoved: result.outdoorRemoved,
        indoorRemoved: result.indoorRemoved,
        visibleBefore: result.visibleBefore,
        discoveredWallCount: result.discoveredWallCount,
        wallsChanged: result.wallsChanged,
        warnings: result.warnings,
        applied: false,
        mode: "candidates",
        beforeVisible: result.beforeVisible,
        highlightMask: result.highlightMask,
      });
      const total = result.outdoorRemoved + result.indoorRemoved;
      const wallNote = result.discoveredWallCount > 0 ? `清理后预计新显露 ${result.discoveredWallCount} 段墙线` : "本次墙线预计保持不变";
      setNotice(total ? `预检完成：已高亮 ${total.toLocaleString()} 个待清理候选点（室外 ${result.outdoorRemoved.toLocaleString()} / 室内 ${result.indoorRemoved.toLocaleString()}），${wallNote}。` : `预检完成：未发现可安全自动清理的候选点，本次墙线保持不变。${result.warnings.join("；")}`);
    });
  }
  async function applyAutoCleaning(current: SurveySource) {
    const result = await request<AutoCleanRunResult>({ action: "auto-clean", source: current, autoOptions: { outdoor: settings.autoCleanOutdoor !== false, indoor: settings.autoCleanIndoor !== false } });
    const next = { ...current, clips: result.clips }, changed = JSON.stringify(current.clips ?? []) !== JSON.stringify(next.clips);
    if (changed) setEditHistory(history => ({ undo: [...history.undo, current.clips ?? []], redo: [] }));
    activeSource.current = next; setSource(next); setCloud(result.preview);
    setAutoCleanState({
      outdoorRemoved: result.outdoorRemoved,
      indoorRemoved: result.indoorRemoved,
      visibleBefore: result.visibleBefore,
      discoveredWallCount: result.discoveredWallCount,
      wallsChanged: result.wallsChanged,
      warnings: result.warnings,
      applied: true,
      mode: "after",
      beforeVisible: result.compare.beforeVisible,
      highlightMask: result.compare.highlightMask,
    });
    return { next, result };
  }
  function runAutoCleaning() {
    if (!source || busy) return;
    if (settings.autoCleanOutdoor === false && settings.autoCleanIndoor === false) { setNotice("请先勾选需要执行的自动清理。"); return; }
    void action("自动清理完整源点", async isCurrent => {
      const { result } = await applyAutoCleaning(source); if (!isCurrent()) return;
      if (drawing) setStale(true); markDirty();
      setNotice(`自动清理完成：${formatAutoCleanWallSummary(result)}${result.warnings.length ? `；${result.warnings.join("；")}` : ""}`);
    });
  }
  function changeAutoCleaning(operation: AutoCleanOperation, checked: boolean) {
    const field = operation === "auto-outdoor-v1" ? "autoCleanOutdoor" : "autoCleanIndoor";
    setSettings(current => ({ ...current, [field]: checked }));
    setAutoCleanState(undefined);
    markDirty(); if (drawing) setStale(true);
    if (!checked && source?.clips?.some(rule => isAutoCleanRule(rule, operation))) clean(source.clips!.filter(rule => !isAutoCleanRule(rule, operation)));
  }
  /** 按提交顺序处理笔画；导航继续可用，保存和出图等待同一修订确认。 */
  function queueBrush(stroke:BrushStroke):Promise<boolean> {
    if(!source||(busy&&!brushCount.current))return Promise.resolve(false);
    const identity=source.native?.token??source.key,epoch=brushEpoch.current;
    if(!brushCount.current)actionOwner.current=++actionSequence.current;const owner=actionOwner.current;
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
        setAutoCleanState(undefined);
        if(drawing)setStale(true);markDirty();
        setNotice(`已擦除 ${result.affectedCount.toLocaleString()} 个源点 · 保留 ${result.retainedCount.toLocaleString()} 点，图纸待更新。`);
      }else setNotice('本笔未命中可擦除的源点。');
      return true;
    }).catch(error=>{if(actionOwner.current===owner)setNotice(error instanceof Error?error.message:String(error));return false;}).finally(()=>{
      if(brushCount.current>0)brushCount.current--;setPendingBrushes(brushCount.current);if(!brushCount.current&&actionOwner.current===owner){actionOwner.current=0;setBusy('');}
    });
    brushChain.current=job.then(()=>{});return job;
  }
  function changeBuilding(next: BuildingModel | undefined, mode: "edit" | "undo" | "redo" = "edit") {
    if (busy) return;
    setModelHistory(mode==="undo"?{undo:modelHistory.undo.slice(0,-1),redo:[...modelHistory.redo,building]}:mode==="redo"?{undo:[...modelHistory.undo,building],redo:modelHistory.redo.slice(0,-1)}:{undo:[...modelHistory.undo,building].slice(-50),redo:[]});
    setBuilding(next?{...next,revision:Math.max(next.revision,building?.revision??0)+1}:undefined);
    if(drawing && (drawing.parameters as any).buildingRevision) setStale(true);
    markDirty();
  }
  function generateBuilding(options: BuildingOptions) {
    if(!source)return;
    void action("从当前楼层点云提取墙体候选",async()=>{
      const next=await request<BuildingModel>({action:"building",source,buildingOptions:options});
      setModelHistory({undo:[...modelHistory.undo,building].slice(-50),redo:[]});setBuilding({...next,revision:(building?.revision??0)+1});if(drawing && (drawing.parameters as any).buildingRevision)setStale(true);markDirty();setNotice(`已生成 ${next.walls.length} 条墙候选和 ${next.rooms.length} 个闭合房间；厚高与墙轴均需复核。`);
    });
  }
  async function getWallElevation(wallId:string,options:ElevationOptions):Promise<WallElevation>{
    if(!source||!building||busy||building.sourceStamp!==sourceStamp(source))throw Error('请先完成当前任务并更新建筑模型测量关联。');
    const wall=building.walls.find(w=>w.id===wallId),floor=building.levels.find(l=>l.id===wall?.levelId);if(!wall||!floor)throw Error('请先选择宿主墙体。');
    const owner=++actionSequence.current;actionOwner.current=owner;setBusy('提取完整点云的墙面颜色与深度');
    try{return await request<WallElevation>({action:'elevation',source,wall,floorM:floor.elevationM,elevationOptions:options});}finally{if(actionOwner.current===owner){actionOwner.current=0;setBusy('');}}
  }
  async function runIfc(model:BuildingModel,purpose:"review"|"delivery"):Promise<IfcArtifact> {
    return new Promise<IfcArtifact>((resolve,reject)=>{
      const runtime=new Worker(new URL("./pipeline/ifc.worker.ts",import.meta.url),{type:"module"});
      const clear=()=>{if(ifcWorker.current===runtime){ifcWorker.current=undefined;cancelIfc.current=undefined;}};
      ifcWorker.current=runtime;cancelIfc.current=()=>{runtime.terminate();clear();reject(Error("已取消IFC导出。"));};
      runtime.onmessage=e=>{runtime.terminate();clear();e.data.error?reject(Error(e.data.error)):resolve(e.data);};runtime.onerror=()=>{runtime.terminate();clear();reject(Error("IFC引擎运行失败。"));};runtime.postMessage({model,purpose});
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
  function modelDrawing(levelId: string, refresh = false, confirmed = false) {
    if (!building || !source || (!confirmed&&!confirmDrawingReplacement(!refresh))) return;
    void action("由建筑模型派生平面图", async () => {
      if (building.sourceStamp !== sourceStamp(source)) throw Error("建筑模型测量依据已过期。");
      const next = drawingFromBuilding(building, levelId, settings, cloud?.sourcePointCount ?? cloud?.visible.length ?? 0);
      next.sourceSha256=source.sha256??source.native?.sha256;
      const labels = refresh ? annotations : [];
      setDrawingHistory({undo:[],redo:[]});setDimensionMode(undefined);setConnectionMode(false);setSelectedAnnotationId(undefined);setMultiViewModels(undefined);setDrawing(annotateSurveyDrawing(next, labels)); setAnnotations(labels); setPlacing(undefined);
      setProjection("xy"); setStale(false); markDirty(); setView("drawing");
      setNotice("模型平面图已生成，与当前建筑修订一致。");
    });
  }
  function generate() {
    if (!source) return;
    if(!confirmDrawingReplacement(false))return;
    const derived = drawing?.parameters;
    // 更新沿用原图来源；模型缺失或过期时保留旧图，不能悄悄切换到点云墙线。
    if (derived?.analysisMode === "building-model") {
      if (!building || derived.buildingId !== building.id || !building.levels.some(l => l.id === derived.buildingLevelId)) {
        setNotice("原图关联的建筑模型或楼层已不存在，请在建筑模型中重新生成平面图。"); return;
      }
      modelDrawing(derived.buildingLevelId!, true, true); return;
    }
    void action("智能生成三视总图", async isCurrent => {
      let workingSource=source,cleanResult:AutoCleanSuggestion|undefined;
      if(settings.autoCleanOutdoor!==false||settings.autoCleanIndoor!==false){const applied=await applyAutoCleaning(source);if(!isCurrent())return;workingSource=applied.next;cleanResult=applied.result;}
      const models={} as MultiViewModels;let footprint:SourceFootprint|undefined;
      for(const target of MULTI_VIEW_ORDER){
        const model=await request<DrawingModel>({action:"drawing",source:workingSource,projection:target,settings,...(target!=='xy'&&footprint?{footprint}:{})});
        if(!isCurrent())return;
        model.sourceSha256=source.sha256??source.native?.sha256;models[target]=model;if(target==='xy')footprint=drawingSourceFootprint(model);
      }
      const combined=createMultiViewDrawing(models),next=annotateSurveyDrawing(combined,annotations),cleanNote=cleanResult?` · ${formatAutoCleanWallSummary(cleanResult)}`:settings.autoCleanOutdoor===false&&settings.autoCleanIndoor===false?' · 高保真模式（保留全部室内墙段与拐角）':settings.autoCleanIndoor===false?' · 已保留全部室内拟合墙段':'';
      if(!isCurrent())return;
      setMultiViewModels(models);setDrawingHistory({undo:[],redo:[]});setDimensionMode(undefined);setConnectionMode(false);setSelectedAnnotationId(undefined);setDrawing(next);setProjection('xy');setSettings(s=>({...s,paperSize:next.paperSize,scale:next.scale}));setStale(false);markDirty();setNotice(`工程图已生成：俯视、正视、侧视总图，${next.statistics.observedWallEntities} 个实测墙段，${next.warnings.filter(w=>w.severity==='warning').length} 项待复核${cleanNote}。${cleanResult?.warnings.join('；')??''}`);
    });
  }
  function commitDrawing(next:DrawingModel,message:string,nextAnnotations:CadAnnotation[]=annotations){
    if(busy||stale||cadLayoutMode)return;
    setDrawingHistory(history=>({undo:[...history.undo,{drawing:structuredClone(drawing!),annotations:structuredClone(annotations)}].slice(-50),redo:[]}));
    setDrawing(next);setAnnotations(nextAnnotations);markDirty();setNotice(message);
  }
  function undoDrawing(){
    const previous=drawingHistory.undo.at(-1);if(!previous||!drawing||busy||stale||cadLayoutMode)return;
    const current={drawing:structuredClone(drawing),annotations:structuredClone(annotations)};
    setDrawingHistory(history=>({undo:history.undo.slice(0,-1),redo:[...history.redo,current]}));setDrawing(structuredClone(previous.drawing));setAnnotations(previous.annotations);markDirty();setNotice('已撤销上一步 CAD 编辑。');
  }
  function redoDrawing(){
    const next=drawingHistory.redo.at(-1);if(!next||!drawing||busy||stale||cadLayoutMode)return;
    const current={drawing:structuredClone(drawing),annotations:structuredClone(annotations)};
    setDrawingHistory(history=>({undo:[...history.undo,current],redo:history.redo.slice(0,-1)}));setDrawing(structuredClone(next.drawing));setAnnotations(next.annotations);markDirty();setNotice('已重做上一步 CAD 编辑。');
  }
  function changeDimensions(next:CadDimension[]) {
    if(!drawing||busy||stale)return;
    const updated={...drawing,dimensions:[],entities:drawing.entities.filter(e=>!e.metadata?.dimensionId)};
    try{for(const d of next)appendDimension(updated,d);commitDrawing(updated,'尺寸标注已更新。');}catch(error){setNotice(error instanceof Error?error.message:String(error));}
  }
  function addDimension(start:[number,number],end:[number,number],linePoint:[number,number]) {
    if(!drawing||!dimensionMode)return;
    const scale=Number(settings.scale.split(':')[1])||100;
    changeDimensions([...(drawing.dimensions??[]),{id:crypto.randomUUID(),kind:dimensionMode,start,end,linePoint,textHeightMm:2.5*scale,roundingMm:settings.roundingMm,unit:settings.dimensionUnit,source:'manual'}]);
  }
  function changeConnections(next:CadConnectionEntity[],message?:string) {
    if(!drawing||busy||stale)return;
    const updated=withCadConnections(drawing,next);commitDrawing(updated,message??`端点连线已更新，剩余 ${openCadEndpoints(updated).length} 个开放端点。`);
  }
  function addConnection(start:CadEndpoint,end:CadEndpoint,style:CadConnectionStyle="auto") {
    if(!drawing||!connectionMode)return;
    try{changeConnections([...manualCadConnections(drawing),createCadConnection(drawing,start,end,style)]);}catch(error){setNotice(error instanceof Error?error.message:String(error));}
  }
  function autoConnect(){
    if(!drawing||busy||stale||cadLayoutMode)return;const suggestions=suggestCadConnections(drawing);
    if(!suggestions.length){setNotice('没有可自动连接的小缺口；可放大后使用端点连线。');return;}
    changeConnections([...manualCadConnections(drawing),...suggestions],`已自动连接 ${suggestions.length} 处小缺口，请复核辅助墙线。`);
  }
  function changeAnnotations(next: CadAnnotation[]) {if(drawing)commitDrawing(annotateSurveyDrawing(drawing,next),'工程标注已更新。',next);else{setAnnotations(next);markDirty();}}
  function updateSettings(next:Partial<CadDrawingSettings>) {
    if(drawing&&!stale&&Object.keys(next).every(k=>['paperSize','scale','roundingMm','dimensionUnit'].includes(k))){
      try{
        const updated=restyleCadDrawing(drawing,next);
        setDrawing(updated);setDrawingHistory(history=>({undo:history.undo.map(snapshot=>({...snapshot,drawing:restyleCadDrawing(snapshot.drawing,next)})),redo:history.redo.map(snapshot=>({...snapshot,drawing:restyleCadDrawing(snapshot.drawing,next)}))}));
      }catch(error){setNotice(error instanceof Error?error.message:String(error));return;}
    }else if(drawing)setStale(true);
    setSettings(s=>({...s,...next}));markDirty();setPlacing(undefined);setDimensionMode(undefined);setConnectionMode(false);
  }
  async function sourceModels():Promise<MultiViewModels> {
    if(multiViewModels)return multiViewModels;
    const models={} as MultiViewModels;let footprint:SourceFootprint|undefined;
    for(const target of MULTI_VIEW_ORDER){
      const generated=await request<DrawingModel>({action:"drawing",source:source!,projection:target,settings,...(target!=='xy'&&footprint?{footprint}:{})});generated.sourceSha256=source!.sha256??source!.native?.sha256;
      models[target]=generated;if(target==='xy')footprint=drawingSourceFootprint(generated);
    }
    setMultiViewModels(models);return models;
  }
  function exportCad() { if (!drawing || stale) return; void action("打包工程图", async isCurrent => { const result = buildingDerived?await createSurveyDelivery(drawing,source!,window.surveyDesktop?.renderPdf):await createMultiViewSurveyDelivery(await sourceModels(),source!,window.surveyDesktop?.renderPdf,drawing);if(!isCurrent())return;const saved=await saveFile(result.archiveName,result.archive);if(!isCurrent())return;setNotice(saved ? result.plot.outsideEntityIds.length||result.plot.titleOverlapEntityIds.length?`成果已保存；存在超框或标题栏重叠，需调整图幅后导出 PDF。`:buildingDerived?"DXF、图纸和校验清单已保存。":"三视总图 DXF、单页矢量图纸和校验清单已保存。" : "已取消保存。"); }); }
  function exportPdf() {
    if(!drawing||stale)return;
    void action("生成图纸 PDF",async isCurrent=>{
      if(!window.surveyDesktop)throw Error("请在桌面版导出 PDF；浏览器成果包包含等比例矢量图纸。");
      let bytes:Uint8Array;
      if(buildingDerived){const vector=createCadSheet(drawing);bytes=new Uint8Array(await window.surveyDesktop.renderPdf({html:vector.html,widthMm:vector.sheet.widthMm,heightMm:vector.sheet.heightMm}));}
      else bytes=await renderMultiViewPdf(await sourceModels(),window.surveyDesktop.renderPdf,drawing);
      if(!isCurrent())return;
      const saved=await saveFile(buildingDerived?"建筑测绘图.pdf":"建筑测绘三视图.pdf",new Uint8Array(bytes));if(!isCurrent())return;
      setNotice(saved?"PDF 已保存；打印时使用实际大小。":"已取消保存。");
    });
  }
  function saveProject() {
    if (!source) return;
    const revision=editRevision.current,sourceVersion=sourceRevision.current;
    void action("保存测量工程", async isCurrent => {
      const saved=await writeSurveyProject({ source, pairedReview, activeKeyframePage, building, accuracy, renderScene, drawing, drawingStale:stale, annotations, projection, settings },isCurrent);
      if(!isCurrent())return;
      if (saved) {
        const unchanged=revision===editRevision.current&&sourceVersion===sourceRevision.current;if(unchanged)setDirty(false);
        setNotice(unchanged?"工程已保存，包含原始点云、关键帧、复核记录和出图参数，可换机打开。":"工程快照已保存，后续修改仍未保存。");
      } else setNotice("已取消保存。");
    });
  }
  function openProject() {
    if (!canReplace()) return;
    void action("打开测量工程", async isCurrent => {
      const f = await openFile("project"); if (!f) return;
      if(!isCurrent()){if(f.native)void window.surveyDesktop?.release(f.native.token);return;}
      const p=await readOpenedProject(f,isCurrent);
      const imported=await importSource(p.source,isCurrent);if(!imported||!isCurrent())return;
      const sourceSha256=p.source.sha256??p.source.native?.sha256;
      const combined=p.drawing?.parameters.analysisMode==='point-cloud-multi-view',modelDerived=p.drawing?.parameters.analysisMode==='building-model';
      setPairedReview(p.pairedReview); setActiveKeyframePage(p.activeKeyframePage);  setBuilding(p.building); setAccuracy(p.accuracy); setRenderScene(p.renderScene??{...DEFAULT_RENDER_SCENE}); setProjection(combined?'xy':p.projection); setSettings({ ...DEFAULT_CAD_DRAWING_SETTINGS, ...p.settings }); setAnnotations(p.annotations); setDrawing(p.drawing);setStale((p.drawingStale??false)||(!!p.drawing&&p.drawing.sourceSha256!==sourceSha256)||(!!p.drawing&&!combined&&!modelDerived)); setUnits(p.source.units); setDirty(false); setNotice(!p.drawing||combined||modelDerived?"测量工程已恢复。":"旧单视图工程已恢复；请点击智能出图生成可整体编辑的三视总图。");
    });
  }
  function cancel() { actionOwner.current=0;brushEpoch.current++; brushCount.current = 0; setPendingBrushes(0); setBusy(""); semanticSequence.current++; semanticClient.current?.dispose(); semanticClient.current=undefined; deliverySequence.current++; cancelIfc.current?.(); void window.surveyDesktop?.cancel();analysis.current?.cancel(); }
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
  const shortcutRef = useRef({ busy, hasSource: !!source, openProject, saveProject,undoDrawing,redoDrawing,cadActive:view==='drawing'&&!stale&&!cadLayoutMode });
  shortcutRef.current = { busy, hasSource: !!source, openProject, saveProject,undoDrawing,redoDrawing,cadActive:view==='drawing'&&!stale&&!cadLayoutMode };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if(key==='z'&&shortcutRef.current.cadActive&&target?.closest('.drawing-pane,.inspector')){e.preventDefault();if(!shortcutRef.current.busy)shortcutRef.current.undoDrawing();return;}
      if(key==='y'&&shortcutRef.current.cadActive&&target?.closest('.drawing-pane,.inspector')){e.preventDefault();if(!shortcutRef.current.busy)shortcutRef.current.redoDrawing();return;}
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
  const buildingDerived=(drawing?.parameters as {analysisMode?:string}|undefined)?.analysisMode==="building-model";
  const openEndpointCount=drawing?openCadEndpoints(drawing).length:0,manualConnectionCount=drawing?manualCadConnections(drawing).length:0;
  const previewRetainedCount = useMemo(() => {
    if (!cloud) return 0;
    let count = 0;
    for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i]) count++;
    return count;
  }, [cloud?.visible]);
  const sourceRetainedCount = cloud ? (cloud.retainedPointCount ?? cloud.sourcePointCount ?? previewRetainedCount) : 0;

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><Layers size={18}/><strong title={`版本 ${STUDIO_VERSION}`}>Guanyao Survey Studio</strong><small className="version-tag">v{STUDIO_VERSION}</small></div>
      <nav className="main-nav" aria-label="工程流程">
        {nav.map(([id, name, Icon]) => <button key={id} disabled={!!busy} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><Icon size={15}/>{name}</button>)}
        <details ref={extensionsMenuRef} className="extensions-menu">
          <summary>菜单{extensions.some(([id])=>id===view)?` · ${extensions.find(([id])=>id===view)![1]}`:''}</summary>
          <div>
            <span className="menu-group-label">工程</span>
            <button disabled={!!busy} onClick={e=>{e.currentTarget.closest('details')!.open=false;openProject();}}><FolderOpen size={15}/>打开工程<kbd>Ctrl+O</kbd></button>
            <button disabled={!source||!!busy} onClick={e=>{e.currentTarget.closest('details')!.open=false;saveProject();}}><FileDown size={15}/>保存工程<kbd>Ctrl+S</kbd></button>
            <span className="menu-group-label">数据</span>
            <label className="menu-unit-field">导入单位<select aria-label="源文件坐标单位" disabled={!!busy} value={units} onChange={e => setUnits(e.target.value as SourceUnit)}><option value="m">米</option><option value="mm">毫米</option></select></label>
            <button disabled={!!busy} onClick={e=>{e.currentTarget.closest('details')!.open=false;importFile();}}><FolderOpen size={15}/>导入测量成果</button>
            {window.surveyDesktop&&<button disabled={!!busy} onClick={e=>{e.currentTarget.closest('details')!.open=false;openDeviceImport();}}>从设备接收</button>}
            <button disabled={!!busy} onClick={e=>{e.currentTarget.closest('details')!.open=false;openDemo();}}><Play size={15}/>打开示例</button>
            <span className="menu-group-label">工作区</span>
            {extensions.map(([id,name,Icon])=><button key={id} disabled={!!busy} aria-current={view===id?'page':undefined} onClick={e=>{setView(id);e.currentTarget.closest('details')!.open=false;}}><Icon size={15}/>{name}</button>)}
          </div>
        </details>
      </nav>
      <div className="header-project">
        <div className={`file-name ${dirty ? "is-dirty" : ""}`} title={source?.name ?? "未打开工程"}>{source?.name ?? "未打开工程"}{dirty ? " · 未保存" : ""}</div>
        {source?.synthetic && <span className="status-pill warning">合成示例</span>}
        <div className="header-actions">
          <button disabled={!!busy} title="打开测量工程 (Ctrl+O)" onClick={openProject}><FolderOpen size={15}/>打开工程</button>
          <button disabled={!source || !!busy} title="保存测量工程 (Ctrl+S)" onClick={saveProject}><FileDown size={15}/>保存工程</button>
          {view === "drawing" && cloud && (
            <button className={`primary ${stale ? "is-stale" : ""}`} disabled={!!busy} onClick={() => generate()}>
              <Play size={14}/>{stale ? "更新图纸" : "智能出图"}
            </button>
          )}
        </div>
      </div>
    </header>
    {deviceImport && <DeviceImport busy={!!busy} onClose={()=>setDeviceImport(false)} onNotice={setNotice} onReceive={receiveSource}/>}
    {view === "drawing" ? <main className="drawing-workspace">
      <div
        ref={workBodyRef}
        className={`work-body ${focusPane !== "none" ? `focus-${focusPane}` : ""} ${resizing ? "is-resizing" : ""}`}
        style={{ "--cloud-fr": `${splitRatio.toFixed(3)}fr`, "--drawing-fr": `${(1 - splitRatio).toFixed(3)}fr` } as React.CSSProperties}
      >
        <section className={`pane cloud-pane ${focusPane === "drawing" ? "is-collapsed" : ""}`}>
          <header>
            <strong>原始测量成果</strong>
            <div className="pane-header-meta">
              <span>{cloud ? `${(cloud.sourcePointCount ?? cloud.visible.length).toLocaleString()} 点` : "PCD / PLY / LAS / LAZ"}</span>
              <button className="pane-focus-btn" aria-pressed={focusPane === "cloud"} aria-label={focusPane === "cloud" ? "恢复双栏对照" : "展开点云视图"} title={focusPane === "cloud" ? "恢复双栏对照" : "展开点云视图"} onClick={() => { autoFocusedCloud.current = false; setFocusPane(focusPane === "cloud" ? "none" : "cloud"); }}>{focusPane === "cloud" ? "恢复双栏" : "展开"}</button>
            </div>
          </header>
          <CloudView cloud={cloud} busy={!!busy} editing={pendingBrushes>0} onBrush={queueBrush} onEditActive={onCloudEditActive} onClip={applyClip} onPickPoint={pickMeasuredPoint} units={units} onUnitsChange={setUnits} onImport={importFile} onDeviceImport={window.surveyDesktop ? openDeviceImport : undefined} onDemo={openDemo} autoCleanPreview={autoCleanState ? { mode: autoCleanState.mode, beforeVisible: autoCleanState.beforeVisible, highlightMask: autoCleanState.highlightMask } : undefined} canUndo={!!editHistory.undo.length} canRedo={!!editHistory.redo.length} clipCount={source?.clips?.length ?? 0} onUndo={() => clean(editHistory.undo.at(-1)!, "undo")} onRedo={() => clean(editHistory.redo.at(-1)!, "redo")} onRestore={() => clean([])}/>
          <div className="clean-history">
            {source?.deviceReceipt && <span>设备接收已校验 · {source.deviceReceipt.captureIntegrity === "passed" ? "采集完整性检查通过" : source.deviceReceipt.captureIntegrity === "warning" ? "采集完整性有告警" : "采集完整性待核实"} · 工程质量待核实</span>}
            <span>{source?.clips?.length ?? 0} 次清理 · 保留 {sourceRetainedCount.toLocaleString()} 点</span>
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
              <span className={stale ? "is-stale" : ""}>{stale ? "待更新" : drawing ? `${buildingDerived?'单视图': '三视总图'}${(drawing.parameters as {wallFidelity?:string}).wallFidelity==='high-fidelity'?' · 高保真':(drawing.parameters as {wallFidelity?:string}).wallFidelity==='interior-preserved'?' · 保留室内':''} · ${drawing.entities.filter(e=>e.category==="wall").length} 墙体${manualConnectionCount?` · ${manualConnectionCount} 连线`:""}` : "未生成"}</span>
              <button className="pane-focus-btn" aria-pressed={focusPane === "drawing"} aria-label={focusPane === "drawing" ? "恢复双栏对照" : "展开工程图纸"} title={focusPane === "drawing" ? "恢复双栏对照" : "展开工程图纸"} onClick={() => setFocusPane(focusPane === "drawing" ? "none" : "drawing")}>{focusPane === "drawing" ? "恢复双栏" : "展开"}</button>
            </div>
          </header>
          <div className="drawing-canvas">
            {drawing ? <CadPreview dimensionMode={dimensionMode} onCreateDimension={addDimension} onDeleteDimension={id=>drawing&&changeDimensions(drawing.dimensions?.filter(d=>d.id!==id)??[])} connectionMode={connectionMode} onCreateConnection={addConnection} onEdit={commitDrawing} canUndo={drawingHistory.undo.length>0} canRedo={drawingHistory.redo.length>0} onUndo={undoDrawing} onRedo={redoDrawing} busy={!!busy} onLayoutModeChange={setCadLayoutMode} onToolChange={next=>{setPlacing(undefined);setDimensionMode(undefined);setConnectionMode(next==='connect');setSelectedAnnotationId(undefined);}} model={drawing} stale={stale} projection={projection} annotations={annotations} placingAnnotation={placing} selectedAnnotationId={selectedAnnotationId} onPlaceAnnotation={point => { if (!placing || stale || busy) return; changeAnnotations([...annotations, { ...placing, id: crypto.randomUUID(), x: point[0], y: point[1], coordinateSpace: "drawing-mm", projection }]); setPlacing(undefined); }} onMoveAnnotation={(id, p) => { if (stale || busy) return; changeAnnotations(annotations.map(a => a.id === id ? { ...a, x: p[0], y: p[1], coordinateSpace: "drawing-mm" } : a)); }} onDeleteAnnotation={id => { if (!stale && !busy) changeAnnotations(annotations.filter(a => a.id !== id)); }} onSelectedAnnotationChange={setSelectedAnnotationId}/> : <div className="cad-preview-empty">
              <div className="empty-card">
                <Ruler size={22}/>
                <strong>暂无工程图纸</strong>
                <span>{cloud ? "点击右上角“智能出图”生成可编辑图纸" : "请先导入测量成果或打开示例"}</span>
              </div>
            </div>}
          </div>
        </section>
        <aside className="inspector">
          <div className="inspector-section auto-clean-options">
            <h2>出图前自动清理 <span className="section-hint" title="开启时过滤杂点并收敛为建筑主轴轮廓；两项均关闭则切换高保真模式，保留室内短拐角与斜墙。">?</span></h2>
            <div className="auto-clean-toggles">
              <label><input type="checkbox" aria-label="去除室外噪点" checked={settings.autoCleanOutdoor!==false} disabled={!!busy} onChange={event=>changeAutoCleaning('auto-outdoor-v1',event.target.checked)}/>去除室外噪点</label>
              <label><input type="checkbox" aria-label="去除室内噪点" checked={settings.autoCleanIndoor!==false} disabled={!!busy} onChange={event=>changeAutoCleaning('auto-indoor-v1',event.target.checked)}/>去除室内噪点</label>
            </div>
            <div className="auto-clean-actions">
              <button disabled={!source||!!busy||(settings.autoCleanOutdoor===false&&settings.autoCleanIndoor===false)} onClick={previewAutoCleaning}>预览候选点</button>
              <button disabled={!source||!!busy||(settings.autoCleanOutdoor===false&&settings.autoCleanIndoor===false)} onClick={runAutoCleaning}>应用自动清理</button>
            </div>
            {settings.autoCleanOutdoor===false&&settings.autoCleanIndoor===false ? (
              <p className="auto-clean-mode-note">高保真出图：保留斜墙与室内短拐角 (≥0.35m)</p>
            ) : settings.autoCleanIndoor===false ? (
              <p className="auto-clean-mode-note">保留室内结构：斜墙与隔断不隐藏</p>
            ) : null}
            {autoCleanState && (
              <div className="auto-clean-summary" role="status" aria-label="自动清理结果">
                <p>{autoCleanState.applied ? formatAutoCleanWallSummary(autoCleanState) : `待清理候选：室外 ${autoCleanState.outdoorRemoved.toLocaleString()} / 室内 ${autoCleanState.indoorRemoved.toLocaleString()} 点（${autoCleanState.visibleBefore ? (((autoCleanState.outdoorRemoved + autoCleanState.indoorRemoved) / autoCleanState.visibleBefore) * 100).toFixed(2) : "0.00"}%），${autoCleanState.discoveredWallCount > 0 ? `预计新显露 ${autoCleanState.discoveredWallCount} 段墙线` : "本次墙线预计保持不变"}`}</p>
                {autoCleanState.warnings.length > 0 && <p className="help">{autoCleanState.warnings.join("；")}</p>}
                {(autoCleanState.outdoorRemoved + autoCleanState.indoorRemoved > 0 || !autoCleanState.applied) && (
                  <div className="auto-clean-compare">
                    {autoCleanState.applied ? (
                      <button
                        aria-pressed={autoCleanState.mode === "before"}
                        onClick={() => setAutoCleanState(cur => cur ? { ...cur, mode: cur.mode === "before" ? "after" : "before" } : cur)}
                      >
                        {autoCleanState.mode === "before" ? "回到清理后" : "清理前对照"}
                      </button>
                    ) : (
                      <button onClick={() => setAutoCleanState(undefined)}>取消预览</button>
                    )}
                    {(autoCleanState.mode === "before" || autoCleanState.mode === "candidates") && autoCleanState.outdoorRemoved + autoCleanState.indoorRemoved > 0 && (
                      <span className="auto-clean-legend">橙：室外 · 红：室内</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="inspector-section">
            <h2>智能编辑 <span className="section-hint" title="自动连接不超过 120 mm 且不交叉的缺口；其余在画布中使用端点连线。">?</span></h2>
            <button disabled={!drawing||stale||!!busy||cadLayoutMode||projection!=="xy"||!openEndpointCount} onClick={autoConnect}>自动连接小缺口</button>
            <p className="help connection-summary">{drawing ? `${openEndpointCount} 处缺口 · ${manualConnectionCount} 连线` : "出图后可用"}</p>
          </div>
          <details className="inspector-section">
            <summary>出图设置</summary>
            <div className="inspector-grid-2">
              <label>分析方式<select aria-label="分析方式" value={settings.orthogonalizeWalls ? "walls" : "projection"} disabled={!!busy} onChange={e => updateSettings({ orthogonalizeWalls: e.target.value === "walls" })}><option value="walls">智能墙线提取</option><option value="projection">投影轮廓</option></select></label>
              <label>出图朝向<select aria-label="出图朝向" value={settings.alignToPrincipalAxis?"building":"source"} disabled={!!busy||projection!=="xy"||!settings.orthogonalizeWalls} onChange={e=>updateSettings({alignToPrincipalAxis:e.target.value==="building"})}><option value="building">建筑主轴</option><option value="source">采集坐标</option></select></label>
            </div>
            <div className="inspector-grid-3">
              <label>图幅<select aria-label="图幅" value={settings.paperSize} disabled={!!busy} onChange={e => updateSettings({ paperSize: e.target.value as CadDrawingSettings["paperSize"] })}>{["A4", "A3", "A2", "A1", "A0"].map(s => <option key={s}>{s}</option>)}</select></label>
              <label>比例<select aria-label="出图比例" value={settings.scale} disabled={!!busy} onChange={e => updateSettings({ scale: e.target.value })}>{["1:50", "1:100", "1:200"].map(s => <option key={s}>{s}</option>)}</select></label>
              <label>尺寸取整<select aria-label="尺寸取整 mm" disabled={!!busy} value={settings.roundingMm} onChange={e=>updateSettings({roundingMm:Number(e.target.value)})}>{[.1,1,5,10].map(v=><option key={v} value={v}>{v} mm</option>)}</select></label>
            </div>
            <label>尺寸单位<select aria-label="尺寸单位" disabled={!!busy} value={settings.dimensionUnit??'mm'} onChange={e=>updateSettings({dimensionUnit:e.target.value as 'mm'|'m'})}><option value="m">米 (m)</option><option value="mm">毫米 (mm)</option></select></label>
          </details>
          <details className="inspector-section">
            <summary>尺寸与工程标注</summary>
            <div className="inspector-inline-action">
              <label>方向<select aria-label="尺寸方向" value={dimensionKind} onChange={e=>{setDimensionKind(e.target.value as CadDimension['kind']);setDimensionMode(undefined);setConnectionMode(false);}}><option value="aligned">对齐</option><option value="horizontal">水平</option><option value="vertical">垂直</option></select></label>
              <button aria-pressed={!!dimensionMode} disabled={!drawing||stale||!!busy||cadLayoutMode} onClick={()=>{setPlacing(undefined);setConnectionMode(false);setDimensionMode(dimensionMode?undefined:dimensionKind);}}>标注尺寸</button>
            </div>
            <div className="inspector-grid-2 annotation-fields">
              <label>类型<select aria-label="标注类型" value={category} onChange={e => setCategory(e.target.value as typeof category)}><option value="text">文字说明</option><option value="room">房间标签</option><option value="door">门标签</option><option value="window">窗标签</option></select></label>
              <label>内容<input aria-label="标注内容" placeholder="输入标签文本" value={label} maxLength={100} onChange={e => setLabel(e.target.value)}/></label>
            </div>
            <button disabled={!drawing || stale || cadLayoutMode || !label.trim() || !!busy} onClick={() => {setDimensionMode(undefined);setConnectionMode(false);setPlacing({ text: label.trim(), category });}}>{placing ? "重新选择标注" : "在图纸放置标注"}</button>
          </details>
          <div className="inspector-section inspector-footer">
            <h2>成果检查</h2>
            {drawing ? <>
              <p className="stats-summary">{drawing.entities.filter(e=>e.category==="wall").length} 个墙体 · {annotations.length} 条人工标注</p>
              <details className="warnings-box"><summary>{warningList.length} 项复核提示</summary><div className="warnings-list">{warningList.map(w => <p className="help" key={w.code}>{w.message}</p>)}</div></details>
            </> : null}
            <button className="primary export" disabled={!drawing || stale || !!busy} onClick={exportCad}><PackageCheck size={15}/>{buildingDerived?"导出 DXF 成果包":"导出三视图成果包"}</button>
          </div>
        </aside>
      </div>
    </main>
    : view === "keyframes" ? <PairedWorkspace pages={source?.native?.keyframePages} activePage={activeKeyframePage} onPage={switchKeyframePage} review={pairedReview} cloud={cloud} busy={!!busy} onImport={importFrames} onChange={r=>{setPairedReview(r);markDirty();}} onExport={exportReview} model={building} onBuild={buildPairedModel} onAdd={addPairedOpening} onLink={linkPairedOpening} onRecognize={recognizeFrames}/>
    : view === "bim" ? <BuildingWorkspace accuracy={accuracy} onAccuracy={r=>{setAccuracy(r);markDirty();}} onElevation={getWallElevation} model={building} source={source} cloud={cloud} busy={!!busy} onChange={changeBuilding} onGenerate={generateBuilding} onExport={exportBuilding} onExportUnified={exportUnified} onDrawing={modelDrawing} onNotice={setNotice} canUndo={!!modelHistory.undo.length} canRedo={!!modelHistory.redo.length} onUndo={()=>changeBuilding(modelHistory.undo.at(-1),"undo")} onRedo={()=>changeBuilding(modelHistory.redo.at(-1),"redo")}/>
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
              <p>{buildingDerived?"DXF 图纸、尺寸标注与复核清单":"俯视、正视、侧视整体编辑，合并 DXF、单页 PDF 与复核清单"}</p>
              {drawing && <div className="delivery-meta"><span>墙体图元 {drawing.statistics.observedWallEntities}</span>{manualDimCount > 0 && <span>人工尺寸 {manualDimCount}</span>}{manualConnectionCount>0&&<span>人工连线 {manualConnectionCount}</span>}<span>复核提示 {warningList.length} 项</span></div>}
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
    : <RenderWorkspace model={building} settings={renderScene} stale={!!building&&!!source&&building.sourceStamp!==sourceStamp(source)} busy={!!busy} onChange={(s,cameraOnly)=>{setRenderScene(s);if(!cameraOnly)markDirty();}} onNotice={setNotice} onBuilding={()=>setView("bim")} onExporting={active=>setBusy(active?"保存建筑效果图与约束":"")}/>}
    <footer className={`status-bar ${busy ? "is-busy" : ""}`} role="status">
      <span>{busy || notice || "就绪"}</span>
      {busy && !busy.startsWith("保存建筑效果图") && <button onClick={cancel}><X size={14}/>取消</button>}
    </footer>
  </div>;
}
