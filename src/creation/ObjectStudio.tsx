import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Box, BoxSelect, Check, Download, Eye, FolderOpen, LoaderCircle, Minus, MousePointer2, Plus, RotateCcw, Save, Undo2, X } from "lucide-react";
import type { EditOperation, PointCloudData } from "../domain/types";
import { PointCloudCanvas } from "../components/PointCloudCanvas";
import { exportObjectPly } from "./ply";
import { saveBinaryFile } from "../platform/files";
import { createObject, pointBounds, subjectBounds } from "./objects";
import { ObjectPreview } from "./ObjectPreview";
import { CaptureViews } from "./CaptureViews";
import { exportObjectGlb, MATERIALS } from "./materials";
import { listDrafts, loadDraft, saveDraft, listObjects, loadObject, saveObject } from "./store";
import { exportObjectProject, importObjectProject } from "./project";
import type { StudioDraft } from "./store";
import type { MaterialPreset, ObjectAsset, SurfaceMethod } from "./types";
import "./object-studio.css";

export interface CreationContext { cloud: PointCloudData; sourceName: string; sourceBlob?: Blob; edits: EditOperation[] }
export function ObjectStudio({ context, onClose, onImport, registerExit, lightMode = false }: { context: CreationContext; onClose(): void; onImport(): void; registerExit?(handler: (() => Promise<boolean>) | undefined): void; lightMode?: boolean }) {
  const [cloud, setCloud] = useState(context.cloud);
  const [sourceName, setSourceName] = useState(context.sourceName);
  // 场景编辑属于选区来源；打开其他作品时，其编辑仍独立保留在 asset.sourceEdits。
  const [sceneSourceEdits, setSceneSourceEdits] = useState(context.edits);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [draftList, setDraftList] = useState<Awaited<ReturnType<typeof listDrafts>>>([]);
  const [draftStatus, setDraftStatus] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(context.sourceBlob && context.cloud.sourcePointIndices));
  const [baseSelection, setSelection] = useState(new Set<number>());
  const [mode, setMode] = useState<"orbit" | "add" | "subtract">("orbit");
  const [history, setHistory] = useState<Set<number>[]>([]);
  const [axis, setAxis] = useState(2), [range, setRange] = useState<[number, number]>([0, 100]);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [asset, setAsset] = useState<ObjectAsset>();
  const [method, setMethod] = useState<SurfaceMethod>("bpa");
  const [detail, setDetail] = useState<"preview" | "fine">("preview");
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [stage, setStage] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string }>();
  const [capability, setCapability] = useState<{ available: boolean; reason?: string }>();
  const [original, setOriginal] = useState(false), [reset, setReset] = useState(0);
  const [showAllPoints, setShowAllPoints] = useState(false);
  const [unitsChecked, setUnitsChecked] = useState(false);
  const [library, setLibrary] = useState<Awaited<ReturnType<typeof listObjects>>>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const libraryRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (libraryOpen) libraryRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [libraryOpen]);
  const thumbnail = useRef<string | undefined>(undefined);
  const taskVersion = useRef(0);
  const mounted = useRef(true);
  const stats = useRef({ fps: 0, visible: 0 });
  const selectionBounds = useMemo(() => pointBounds(cloud, baseSelection), [cloud, baseSelection]);
  const selection = useMemo(() => {
    if (range[0] === 0 && range[1] === 100) return baseSelection;
    const min = selectionBounds.min[axis]!, size = selectionBounds.size[axis]!;
    return new Set([...baseSelection].filter(i => { const value = cloud.positions[i * 3 + axis]!; return value >= min + size * range[0] / 100 && value <= min + size * range[1] / 100; }));
  }, [baseSelection, range, axis, selectionBounds, cloud]);
  const sceneBounds = useMemo(() => pointBounds(cloud), [cloud]);
  const mainBounds = useMemo(() => subjectBounds(cloud, sceneBounds), [cloud, sceneBounds]);
  const viewBounds = showAllPoints ? sceneBounds : mainBounds;
  const dimensions = useMemo(() => asset ? pointBounds(asset.cloud).size : undefined, [asset?.cloud]);
  const outputDimensions = useMemo(() => {
    if (!asset?.mesh) return undefined;
    const p = asset.mesh.positions, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) { const a = i % 3; min[a] = Math.min(min[a]!, p[i]!); max[a] = Math.max(max[a]!, p[i]!); }
    return min.map((v, a) => max[a]! - v);
  }, [asset?.mesh]);
  const draft = useMemo<StudioDraft | undefined>(() => asset || selection.size ? ({
    id: draftId, updatedAt: new Date().toISOString(), sourceName, sourceEdits: sceneSourceEdits, cloud, selection: [...selection], asset,
  }) : undefined, [draftId, sourceName, sceneSourceEdits, cloud, selection, asset]);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const persistedDraft = useRef<StudioDraft | undefined>(undefined);
  const deliveredDraft = useRef<StudioDraft | undefined>(undefined);
  const pendingDraft = useRef<Promise<void> | undefined>(undefined);
  const exitInFlight = useRef(false);
  const persist = () => {
    if (pendingDraft.current) return pendingDraft.current;
    const write = async () => {
      while (latestDraft.current && latestDraft.current !== persistedDraft.current) {
        const current = latestDraft.current;
        await saveDraft(current);
        persistedDraft.current = current;
      }
    };
    const task = write().finally(() => { pendingDraft.current = undefined; });
    pendingDraft.current = task;
    return task;
  };
  const protect = async () => {
    try { await persist(); }
    catch (error) { if (latestDraft.current !== deliveredDraft.current) throw error; }
  };
  useEffect(() => {
    if (!draft) return;
    setDraftStatus("有编辑待保存");
    const timer = setTimeout(() => {
      void persist().then(() => { if (mounted.current && latestDraft.current === draft) setDraftStatus("草稿已保存到本机"); })
        .catch(() => { if (mounted.current) setDraftStatus("草稿保存失败，请保存制作工程后再退出"); });
    }, 700);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (latestDraft.current && latestDraft.current !== persistedDraft.current && latestDraft.current !== deliveredDraft.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  const prepareExit = async () => {
    if (attachmentBusy || busy || selectionBusy || saving || libraryBusy || exitInFlight.current) {
      setMessage({ error: false, text: "正在生成、整理素材或保存，请稍候；表面生成可先取消。" }); return false;
    }
    exitInFlight.current = true; setLeaving(true);
    try { await protect(); return true; }
    catch (error) { setMessage({ error: true, text: `草稿保存失败，已保留当前编辑。请保存制作工程后再返回：${String(error)}` }); return false; }
    finally { exitInFlight.current = false; if (mounted.current) setLeaving(false); }
  };
  const close = async () => { if (await prepareExit()) onClose(); };
  useEffect(() => { registerExit?.(prepareExit); return () => registerExit?.(undefined); });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (libraryOpen) { if (!libraryBusy) setLibraryOpen(false); }
      else void close();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const focus = useMemo(() => viewBounds.count ? { token: reset, center: viewBounds.center, radius: Math.hypot(...viewBounds.size) / 2, fit: true } : undefined, [viewBounds, reset]);
  useEffect(() => {
    mounted.current = true;
    const desktop = window.pointViewDesktop;
    if (desktop?.objectCapability) void desktop.objectCapability().then(setCapability).catch(error => setCapability({ available: false, reason: String(error) }));
    else setCapability({ available: false, reason: "表面生成在桌面应用中运行；浏览器仍可选取、收藏与查看物体。" });
    const removeProgress = desktop?.onObjectProgress?.(setStage);
    return () => { mounted.current = false; taskVersion.current++; removeProgress?.(); void desktop?.cancelObject?.(); };
  }, []);
  useEffect(() => {
    if (!context.sourceBlob || !context.cloud.sourcePointIndices) return;
    const worker = new Worker(new URL("./source.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = event => {
      if (event.data.error) setMessage({ error: true, text: `完整源读取失败：${event.data.error}。当前保留采样快照。` });
      else setCloud(event.data.cloud);
      setLoading(false); worker.terminate();
    };
    worker.onerror = event => { setLoading(false); setMessage({ error: true, text: `完整源读取失败：${event.message}。当前保留采样快照。` }); worker.terminate(); };
    worker.postMessage({ blob: context.sourceBlob, id: context.cloud.id, edits: context.edits, sourceIndices: context.cloud.sourcePointIndices });
    return () => worker.terminate();
  }, [context]);
  const updateSelection = (indices: number[]) => {
    setHistory(current => [...current.slice(-11), baseSelection]);
    const next = new Set(selection);
    for (const index of indices) { if (mode === "subtract") next.delete(index); else next.add(index); }
    setSelection(next); setRange([0, 100]);
  };
  const pickPoint = (index: number) => {
    const radius = Math.max(Math.hypot(...sceneBounds.size) / 150, 0.001);
    const p = cloud.positions.subarray(index * 3, index * 3 + 3), hits = [];
    for (let i = 0; i < cloud.visible.length; i++) if (cloud.visible[i] && Math.hypot(cloud.positions[i * 3]! - p[0]!, cloud.positions[i * 3 + 1]! - p[1]!, cloud.positions[i * 3 + 2]! - p[2]!) < radius) hits.push(i);
    updateSelection(hits);
  };
  const confirmSelection = () => {
    try { thumbnail.current = undefined; setAsset({ ...createObject(cloud, selection, sourceName), sourceEdits: structuredClone(sceneSourceEdits) }); setOriginal(false); setMode("orbit"); setMessage(undefined); setUnitsChecked(false); }
    catch (error) { setMessage({ error: true, text: String(error) }); }
  };
  const generate = async () => {
    if (!asset || !window.pointViewDesktop || busy) return;
    const version = ++taskVersion.current;
    setBusy(true); setStage("准备物体数据"); setMessage(undefined);
    try {
      const result = await window.pointViewDesktop.reconstructObject({ positions: asset.cloud.positions.slice().buffer, colors: asset.cloud.colors.slice().buffer, hasColor: Boolean(asset.cloud.attributes?.hasColor), method, detail });
      if (!mounted.current || version !== taskVersion.current) return;
      setAsset(current => current && ({ ...current, mesh: { positions: new Float32Array(result.positions), normals: new Float32Array(result.normals), colors: new Uint8Array(result.colors), indices: new Uint32Array(result.indices), report: result.report } }));
      setOriginal(false); setUnitsChecked(false); setMessage({ error: false, text: "表面已生成。旋转检查边界，或对照扫描原貌。" });
    } catch (error) { if (mounted.current && version === taskVersion.current) setMessage({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { if (mounted.current) setBusy(false); }
  };
  const cancel = async () => { taskVersion.current++; await window.pointViewDesktop?.cancelObject(); setMessage({ error: false, text: "已取消生成，原始物体仍然保留。" }); };
  const save = async (format: "library" | "glb" | "ply" | "project") => {
    if (!asset || saving || attachmentBusy) return;
    const savedSnapshot = latestDraft.current;
    setSaving(true); setMessage(undefined);
    try {
      const named = { ...asset, name: asset.name.trim() || "未命名物体", thumbnail: thumbnail.current ?? asset.thumbnail };
      const safe = named.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100);
      if (format === "library") { await saveObject(named); deliveredDraft.current = savedSnapshot; setMessage({ error: false, text: "作品已收藏，可在“我的作品”中继续创作。" }); }
      else {
        const bytes = format === "project" ? await exportObjectProject(named) : format === "glb" ? await exportObjectGlb(named) : exportObjectPly(named);
        const saved = await saveBinaryFile(`${safe}.${format === "project" ? "pvobject" : format}`, bytes, format === "glb" ? "model/gltf-binary" : "application/octet-stream");
        if (saved && format === "project") deliveredDraft.current = savedSnapshot;
        if (mounted.current) setMessage({ error: false, text: saved ? (format === "project" ? "制作工程已保存，包含局部点云、网格及已关联的原图，可重新打开编辑。" : format === "glb" ? "GLB 已保存，可在 Blender 的“文件 → 导入 → glTF 2.0”中打开。" : "原始物体点云已保存；PLY 不包含连续表面。") : "已取消保存。" });
      }
    } catch (error) { if (mounted.current) setMessage({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { if (mounted.current) setSaving(false); }
  };
  const openLibrary = async () => {
    setLibraryBusy(true);
    try { await protect(); setLibrary(await listObjects()); setDraftList(await listDrafts()); setLibraryOpen(true); }
    catch (error) { setMessage({ error: true, text: `无法读取作品：${String(error)}` }); }
    finally { setLibraryBusy(false); }
  };
  const restore = async (id: string) => {
    setLibraryBusy(true);
    try { await protect(); const saved = await loadObject(id); if (!saved) throw new Error("未找到作品"); setDraftId(crypto.randomUUID()); setAsset(saved); thumbnail.current = saved.thumbnail; setLibraryOpen(false); setOriginal(false); setUnitsChecked(false); setMessage(undefined); }
    catch (error) { setMessage({ error: true, text: String(error) }); }
    finally { setLibraryBusy(false); }
  };
  const restoreDraft = async (id: string) => {
    setLibraryBusy(true);
    try {
      await protect();
      const saved = await loadDraft(id);
      if (!saved) throw new Error("未找到草稿");
      setDraftId(saved.id); setCloud(saved.cloud); setSourceName(saved.sourceName); setSceneSourceEdits(saved.sourceEdits ?? []);
      setSelection(new Set(saved.selection)); setRange([0, 100]); setHistory([]); setAsset(saved.asset);
      thumbnail.current = saved.asset?.thumbnail; setOriginal(false); setUnitsChecked(false); setLibraryOpen(false); setMessage(undefined);
    } catch (error) { setMessage({ error: true, text: String(error) }); }
    finally { setLibraryBusy(false); }
  };
  const openProject = async (file: File) => {
    setLibraryBusy(true);
    try {
      const restored = await importObjectProject(file);
      await protect();
      setDraftId(crypto.randomUUID()); setAsset(restored); thumbnail.current = restored.thumbnail;
      setOriginal(false); setUnitsChecked(false); setMessage({ error: false, text: "制作工程已打开，原图空间对齐仍需核验。" });
    } catch (error) { setMessage({ error: true, text: `工程未替换当前编辑：${String(error)}` }); }
    finally { setLibraryBusy(false); }
  };
  const reselect = async () => {
    if (!(await prepareExit())) return;
    setDraftId(crypto.randomUUID()); setAsset(undefined); setOriginal(false); setUnitsChecked(false);
    setMessage({ error: false, text: latestDraft.current === persistedDraft.current ? "上一件物体已保留在草稿中，可从“作品与草稿”恢复。" : "上一件物体已保存为工程或收藏，可重新打开继续编辑。" });
  };
  const sampled = (cloud.sourcePointCount ?? cloud.visible.length) > cloud.visible.length;
  return <section className="object-studio" inert={leaving || libraryBusy || saving} aria-busy={leaving || libraryBusy || saving} aria-label="物体创作台">
    <div className="object-stage">
      {!asset ? <PointCloudCanvas lightMode={lightMode} cloud={cloud} colorMode="rgb" pointSize={0} selected={selection} selectionEnabled={!loading && !selectionBusy && mode !== "orbit"} moveEnabled={false} showReferenceGuides={false} resetToken={reset} focusRequest={focus} fullSelection dimUnselected onSelectionBusy={setSelectionBusy} onSelectPoints={updateSelection} onTogglePoint={pickPoint} onMoveSelected={() => {}} onStats={(fps, visible) => { stats.current = { fps, visible }; }} />
        : <ObjectPreview lightMode={lightMode} asset={asset} original={original} resetToken={reset} onThumbnail={data => { thumbnail.current = data; }} />}
      <div className="object-stage-heading"><span>POINT VIEW / OBJECT ATELIER</span><strong>{asset ? asset.name || "未命名物体" : "从空间里，留下一件。"}</strong><p>{asset ? "旋转、靠近，让你的物体成为主角。" : "先框出物体，再转动视角，减去多余背景。"}</p></div>
      <div className="object-stage-tools">
        {!asset && <><button aria-pressed={mode === "orbit"} onClick={() => setMode("orbit")}><MousePointer2 size={16} />转动查看</button><button aria-pressed={mode === "add"} onClick={() => setMode("add")} disabled={loading}><Plus size={16} />框选添加</button><button aria-pressed={mode === "subtract"} onClick={() => setMode("subtract")} disabled={loading}><Minus size={16} />框选减去</button></>}
        {asset?.mesh && <button aria-pressed={original} onClick={() => setOriginal(value => !value)}><Eye size={16} />{original ? "查看创作表面" : "对照扫描原貌"}</button>}
        {asset ? <button onClick={() => setReset(value => value + 1)} aria-label="物体回到全貌"><RotateCcw size={16} />全貌</button>
          : <><button aria-pressed={!showAllPoints} title="聚焦密集主体，仅调整视角" onClick={() => { setShowAllPoints(false); setReset(value => value + 1); }}><RotateCcw size={16} />主体</button>
            <button aria-pressed={showAllPoints} title="查看包括远处点在内的完整范围" onClick={() => { setShowAllPoints(true); setReset(value => value + 1); }}><Box size={16} />全部点</button></>}
      </div>
      <div className="object-stage-foot"><span>{asset ? `${asset.cloud.visible.length.toLocaleString()} 个扫描点${asset.mesh ? ` · ${asset.mesh.report.triangles.toLocaleString()} 个面` : ""}` : `${selection.size.toLocaleString()} 点已选 · ${cloud.visible.length.toLocaleString()} 点可用`}</span><span>{asset ? (original || !asset.mesh ? "扫描原貌" : MATERIALS[asset.material].label) : "空间快照 · 原工程保持可恢复"}</span></div>
      {loading && <div className="object-loading" role="status"><LoaderCircle className="button-spinner" />正在读取完整源数据<button onClick={() => void close()}>取消并返回</button></div>}
    </div>
    <aside className="object-inspector">
      <header><div><span className="object-eyebrow">空间记忆 / 创作</span><h1>物体创作台</h1></div><button className="object-icon" onClick={() => void close()} aria-label="关闭物体创作台"><X size={20} /></button></header>
      <ol className="object-steps" aria-label="创作步骤"><li aria-current={!asset ? "step" : undefined}><span>01</span>选一件</li><li aria-current={asset && !asset.mesh ? "step" : undefined}><span>02</span>成形</li><li aria-current={asset?.mesh ? "step" : undefined}><span>03</span>留下作品</li></ol>
      <div className="object-inspector-scroll">
        <label className="object-project-open">打开制作工程<input aria-label="打开制作工程" type="file" accept=".pvobject" disabled={busy || saving || attachmentBusy || libraryBusy || loading} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void openProject(file); }} /></label>
        {message && <div className={`object-message ${message.error ? "is-error" : ""}`} role={message.error ? "alert" : "status"}>{message.text}<button onClick={() => setMessage(undefined)} aria-label="关闭创作提示"><X size={14} /></button></div>}
        {!asset ? <>
          {!sceneBounds.count && <div className="object-empty"><p>先导入一处空间，或打开已收藏的作品。</p><button className="object-primary" onClick={() => { void prepareExit().then(ready => { if (ready) onImport(); }); }}><FolderOpen size={16} />导入点云</button></div>}
          <div className="object-intro"><BoxSelect size={28} /><h2>先把它选出来。</h2><p>添加与减去都可以反复操作。切回“转动查看”，检查物体背后是否夹带墙面或地面。</p></div>
          {sampled && <p className="object-warning">当前是采样快照。{context.sourceBlob ? "完整读取完成前暂不能确认选区。" : "重新导入原文件可恢复完整数据；此快照的作品会标记采样来源。"}</p>}
          <div className="object-selection-count"><strong>{selection.size.toLocaleString()}</strong><span>{selectionBusy ? "正在检查完整选区…" : "个点，组成你的物体"}</span></div>
          <div className="object-row"><button disabled={!history.length || selectionBusy} onClick={() => { setSelection(history.at(-1)!); setHistory(value => value.slice(0, -1)); setRange([0, 100]); }}><Undo2 size={16} />撤销选取</button><button disabled={!baseSelection.size} onClick={() => { setHistory(value => [...value.slice(-11), baseSelection]); setSelection(new Set()); setRange([0, 100]); }}>重新选择</button></div>
          <details className="object-details"><summary>进一步剔除背景</summary><p>沿空间方向收窄范围。确认后只保留亮起的点。</p><label>过滤方向<select aria-label="物体过滤方向" value={axis} onChange={event => { setAxis(Number(event.target.value)); setRange([0, 100]); }}><option value="0">X · 左右范围</option><option value="1">Y · 前后范围</option><option value="2">Z · 高度范围</option></select></label><label>起点 {range[0]}%<input aria-label="物体范围起点" type="range" min="0" max="100" value={range[0]} disabled={!baseSelection.size} onChange={event => setRange([Math.min(Number(event.target.value), range[1]), range[1]])} /></label><label>终点 {range[1]}%<input aria-label="物体范围终点" type="range" min="0" max="100" value={range[1]} disabled={!baseSelection.size} onChange={event => setRange([range[0], Math.max(Number(event.target.value), range[0])])} /></label></details>
          <p className="object-learning">点记录位置，面把附近的点连接成形体。</p>
        </> : <>
          <label className="object-name">作品名称<input aria-label="作品名称" maxLength={100} value={asset.name} onChange={event => setAsset({ ...asset, name: event.target.value })} /></label>
          <CaptureViews key={asset.id} sourceName={asset.source.name} sourceBlob={asset.source.id === context.cloud.id ? context.sourceBlob : undefined} value={asset.capture} onChange={capture => setAsset(current => current && ({ ...current, capture }))} onBusyChange={setAttachmentBusy} />
          <div className="object-dimensions"><span>扫描范围 · 空间 X / Y / Z 包围尺寸</span><strong>{dimensions?.map(value => (value * asset.metersPerUnit).toFixed(3)).join(" × ")} <small>米</small></strong><p>这是扫描包围范围，斜放物体不等同于自身长宽高。</p>{outputDimensions && <><span>输出网格 · 空间 X / Y / Z 包围尺寸</span><strong>{outputDimensions.map(value => (value * asset.metersPerUnit).toFixed(3)).join(" × ")} <small>米</small></strong></>}<p>实测尺寸约束尚未接入成形。</p><select aria-label="原始坐标单位" value={asset.metersPerUnit} onChange={event => { setAsset({ ...asset, metersPerUnit: Number(event.target.value) }); setUnitsChecked(false); }}><option value="1">原坐标单位：米</option><option value="0.01">原坐标单位：厘米</option><option value="0.001">原坐标单位：毫米</option></select></div>
          {!asset.mesh && <div className="object-intro compact"><h2>让记忆有形。</h2><p>当前支持自由曲面连接。纸箱的平面、正交关系和尺寸约束尚未接入，请对照扫描检查缺口与变形。</p></div>}
          <details className="object-details"><summary>外观 · 可选材质</summary><div className="object-materials" aria-label="创作材质">{(Object.keys(MATERIALS) as MaterialPreset[]).map(key => <button key={key} aria-pressed={asset.material === key} disabled={!asset.mesh || busy || (key === "original" && !asset.cloud.attributes?.hasColor)} onClick={() => { setAsset({ ...asset, material: key }); setOriginal(false); }}><span className={`material-swatch ${key}`} aria-hidden="true" /><span>{MATERIALS[key].label}</span>{asset.material === key && <Check size={14} />}</button>)}</div>
          <p className="object-learning">{asset.mesh ? MATERIALS[asset.material].copy : "形体生成后，即可切换外观。"}</p></details>
          {asset.mesh && <div className="object-check"><strong>检查形体</strong><p>{asset.mesh.report.boundaryEdges ? `有 ${asset.mesh.report.boundaryEdges.toLocaleString()} 条开放边界，请查看是否符合物体本身的开口。` : "没有开放边界；仍需对照原貌检查未扫描区域。"}</p>{asset.mesh.report.components > 1 && <p>有 {asset.mesh.report.components} 片分离表面，检查是否夹带背景或碎片。</p>}{asset.mesh.report.warnings.map(text => <p key={text}>{text}</p>)}</div>}
          <details className="object-details"><summary>表面生成选项</summary><label>生成方式<select aria-label="表面生成方式" disabled={busy} value={method} onChange={event => setMethod(event.target.value as SurfaceMethod)}><option value="bpa">贴近扫描 · BPA</option><option value="poisson">连续表面 · Poisson</option></select></label><label>细节<select aria-label="表面细节" disabled={busy} value={detail} onChange={event => setDetail(event.target.value as "preview" | "fine")}><option value="preview">快速预览</option><option value="fine">精细生成</option></select></label><p>连续表面可能补出缺口附近的形状，请对照原貌。尺寸与薄结构不能只凭表面光滑度判断。</p>{asset.mesh && <button disabled={busy || attachmentBusy || !capability?.available} onClick={generate}>重新生成表面</button>}</details>
          {asset.cloud.visible.length > 2_000_000 && <p className="object-warning">单物体表面生成最多接受 200 万点。请回到空间缩小选区；当前原貌仍可收藏。</p>}
          {!capability?.available && capability?.reason && <p className="object-warning">{capability.reason}</p>}
          {busy && <div className="object-progress" role="status"><LoaderCircle className="button-spinner" size={18} /><span>{stage}</span><button onClick={cancel}>取消</button></div>}
          <div className="object-source"><span>来自 {asset.source.name}</span><span>{asset.source.sampled ? "采样来源" : "完整可用数据"} · 创建于 {new Date(asset.createdAt).toLocaleString("zh-CN")}</span></div>
          <button className="object-text-button" disabled={busy || saving || attachmentBusy || libraryBusy || leaving} onClick={() => void reselect()}><ArrowLeft size={14} />回到当前空间重新选取</button>
        </>}
      </div>
      <footer>
        {!asset ? <button className="object-primary" disabled={loading || selectionBusy || selection.size < 3} onClick={confirmSelection}>确认物体<ArrowRight size={18} /></button>
          : <>{asset.mesh && <label className="object-unit-check"><input type="checkbox" checked={unitsChecked} onChange={event => setUnitsChecked(event.target.checked)} />已核对输出网格的坐标单位与尺寸</label>}<div className="object-row"><button disabled={busy || saving || attachmentBusy || libraryBusy || leaving} onClick={() => void save("library")}><Save size={16} />收藏到本机</button><button disabled={busy || saving || attachmentBusy || libraryBusy || leaving} onClick={() => void save("ply")}><Download size={16} />保存原貌</button></div>{asset.mesh ? <button className="object-primary" disabled={busy || saving || attachmentBusy || libraryBusy || leaving || !unitsChecked} onClick={() => void save("glb")}><Download size={18} />{saving ? "正在保存…" : "导出 Blender 模型 · GLB"}</button> : <button className="object-primary" disabled={busy || attachmentBusy || !capability?.available || asset.cloud.visible.length < 30 || asset.cloud.visible.length > 2_000_000} onClick={generate}><Box size={18} />{busy ? "正在生成表面…" : "生成物体表面"}</button>}</>}
        {asset && <button className="object-project-save" disabled={busy || saving || attachmentBusy || libraryBusy} onClick={() => void save("project")}><Save size={16} />保存制作工程 · 含原图</button>}
        <p role="status">{leaving ? "正在保存草稿…" : libraryBusy ? "正在打开作品…" : saving ? "正在保存作品…" : draftStatus}</p>
        <div className="object-footer-links"><button onClick={openLibrary} disabled={busy || saving || attachmentBusy || libraryBusy || leaving}><FolderOpen size={15} />作品与草稿</button><button onClick={() => void close()}>返回空间</button></div>
      </footer>
    </aside>
    {libraryOpen && <div ref={libraryRef} className="object-library" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (!libraryBusy) setLibraryOpen(false); } if (event.key === "Tab") { const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; const first = buttons[0], last = buttons.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }} role="dialog" aria-modal="true" aria-label="我的作品"><header><h2>我的作品</h2><button disabled={libraryBusy || loading} onClick={() => setLibraryOpen(false)} aria-label="关闭我的作品"><X /></button></header>{draftList.length > 0 && <><h3>自动草稿</h3><div className="object-library-grid">{draftList.map(item => <button disabled={libraryBusy || loading} key={item.id} onClick={() => void restoreDraft(item.id)}><strong>{item.sourceName}</strong><small>{new Date(item.updatedAt).toLocaleString("zh-CN")}</small></button>)}</div></>}{library.length ? <div className="object-library-grid">{library.map(item => <button disabled={libraryBusy || loading} key={item.id} onClick={() => void restore(item.id)}>{item.thumbnail && <img src={item.thumbnail} alt={item.name} />}<strong>{item.name}</strong><small>{new Date(item.createdAt).toLocaleDateString("zh-CN")}</small></button>)}</div> : <p>还没有收藏。选取一件物体，为它命名，留下你的第一件作品。</p>}</div>}
  </section>;
}
