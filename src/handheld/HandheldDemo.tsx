import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowLeftRight, ArrowRight, BatteryMedium, BookOpen, Box, Check,
  Camera, CheckCircle2, ChevronRight, CircleHelp, Cloud, CloudUpload, Compass,
  Crosshair, Download, Ellipsis, Expand, FolderOpen, Gauge, Grid2X2, HardDrive,
  Layers, LoaderCircle, MapPin, Move3D, Pause, Play, Plus, Radio,
  RotateCcw, Ruler, Scan, Settings2, ShieldCheck, SlidersHorizontal, Search,
  Satellite, Smartphone, Square, Timer, Trash2, Wifi, WifiOff, X,
} from "lucide-react";
import { DemoScene } from "./DemoScene";
import { RECORD_KEY, SEED_PROJECTS, demoDxf, downloadDemo, formatDate, formatDuration, readDemoProjects, type DemoProject } from "./demoData";
import { useScanner } from "./scanner/useScanner";
import { isLabMessage } from "./preview/protocol";

type ModalName = "connect" | "finish" | "discard" | "settings" | "display" | "help" | null;
interface Transfer { projectId: string; intent: "download" | "upload"; stage: "download" | "network" | "upload" | "done"; progress: number; paused: boolean }

function Modal({ title, children, onClose, locked = false }: { title: string; children: ReactNode; onClose(): void; locked?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={ref} className="demo-dialog" aria-labelledby="demo-dialog-title" onCancel={e => { e.preventDefault(); if (!locked) onClose(); }} onClick={e => { if (!locked && e.target === e.currentTarget) onClose(); }}>
    <div className="dialog-body"><header><div><h2 id="demo-dialog-title">{title}</h2></div><button className="icon-button" aria-label="关闭弹窗" disabled={locked} onClick={onClose}><X size={20} /></button></header>{children}</div>
  </dialog>;
}

function ModelThumb({ kind, large = false }: { kind: DemoProject["kind"]; large?: boolean }) {
  const shift = kind === "gallery" ? 12 : kind === "courtyard" ? -8 : 0;
  return <div className={`model-thumb ${kind} ${large ? "large" : ""}`}>
    <svg viewBox="0 0 360 220" role="img" aria-label="程序绘制的示例空间平面轴测图">
      <g transform={`translate(180 125) scale(1 .53) rotate(-30) translate(${shift} -12)`} strokeLinejoin="round">
        <path d="M-120 -76H110V76H-120Z" fill="#d4dfd8" stroke="#b3c4bb" strokeWidth="2" />
        {Array.from({ length: 9 }, (_, i) => <path key={i} d={`M${-100 + i * 25} -76V76`} stroke="#edf2ef" strokeWidth="1" />)}
        <path d="M-120 76V-76H110" fill="none" stroke="#80978a" strokeWidth="8" />
        <path d="M-120 -76L-120 -128H110V-76" fill="#e6ebe4" stroke="#acbeb1" strokeWidth="2" />
        <path d="M-120 76V-76L-120 -128V24Z" fill="#c0d0c4" />
        <path d="M20 -76V-6M20 25V76" stroke="#839d8f" strokeWidth="6" />
        <path d="M-93 -90H-39M-93 -108H-39" stroke="#9fae93" strokeWidth="10" />
        <rect x="-84" y="-25" width="72" height="42" rx="3" fill="#b9a180" stroke="#8f826d" />
        <path d="M-78 -38h17m17 0h17m-51 68h17m17 0h17" stroke="#6e9785" strokeWidth="13" />
        <rect x="47" y="-62" width="48" height="28" rx="3" fill={kind === "gallery" ? "#a6aaa0" : "#c3b59d"} stroke="#a99f8d" />
        <rect x="54" y="-8" width="32" height="16" rx="2" fill="#a68f74" />
        <circle cx="83" cy="48" r="13" fill="#86a38b" /><circle cx="77" cy="42" r="9" fill="#668c77" />
        {kind === "courtyard" && <><circle cx="-71" cy="52" r="19" fill="#769980" /><circle cx="7" cy="-48" r="13" fill="#729377" /></>}
      </g>
    </svg>
    <span className="thumb-type"><Box size={12} /> 示例空间</span>
  </div>;
}

function ProjectCard({ project, onOpen }: { project: DemoProject; onOpen(): void }) {
  return <button className="project-card" onClick={onOpen}>
    <ModelThumb kind={project.kind} />
    <div className="project-card-info"><div><h3>{project.name}</h3><span>{formatDate(project.date)} <i /> {project.location}</span></div><ArrowRight size={18} /></div>
    <div className="project-card-bottom"><span><Box size={13} />{project.points}点</span><span>{project.local ? "手机本地" : "设备项目"}</span></div>
  </button>;
}

export function HandheldDemo() {
  const [route, setRoute] = useState(() => location.hash.slice(2) || "scan");
  const [projects, setProjects] = useState(readDemoProjects);
  const { scanner, connection, phase, seconds, previewSeconds, savedProject } = useScanner();
  const [rtkConnected, setRtkConnected] = useState(false);
  const [modal, setModal] = useState<ModalName>(null);
  const [notice, setNotice] = useState("");
  const [demoDeviceUrl, setDemoDeviceUrl] = useState("omni-demo://handheld-001");
  const pendingAutoJump = useRef(false);
  const [name, setName] = useState("新的空间记录");
  const [viewMode, setViewMode] = useState<"points" | "solid">("points");
  const [opticalLens, setOpticalLens] = useState<"front" | "left" | "right" | "panorama">("front");
  const [cameraFullscreen, setCameraFullscreen] = useState(false);
  const [pipPosition, setPipPosition] = useState({ right: false, y: 100 });
  const pipDrag = useRef(false);
  const pipHandle = <>
    <button className="pip-drag" aria-label="拖动小窗贴边" onPointerDown={e => { pipDrag.current = true; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (!pipDrag.current) return; setPipPosition({ right: e.clientX > window.innerWidth / 2, y: e.clientY / window.innerHeight * 100 }); }} onPointerUp={() => { pipDrag.current = false; }} onPointerCancel={() => { pipDrag.current = false; }} />
    <button className="pip-expand" aria-label="全屏查看小窗" onClick={() => { setCameraMain(v => !v); setCameraFullscreen(true); }}><Expand size={17} /></button>
  </>;
  const [cameraMain, setCameraMain] = useState(false);
  const [top, setTop] = useState(false);
  const [heightColor, setHeightColor] = useState(false);
  const [pointSize, setPointSize] = useState(0.035);
  const [reset, setReset] = useState(0);
  const [recordTab, setRecordTab] = useState<"local" | "device">("local");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [tool, setTool] = useState<"view" | "measure" | "slice">("view");
  const [picks, setPicks] = useState<[number, number, number][]>([]);
  const [sliceHeight, setSliceHeight] = useState(1.2);
  const [sliceThickness, setSliceThickness] = useState(0.35);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [tutorial, setTutorial] = useState<number | null>(null);
  const [libraryTab, setLibraryTab] = useState("空间素材");
  const [storageFailed, setStorageFailed] = useState(false);
  const storageAlerted = useRef(false);
  const isExperience = route === "experience";
  const current = isExperience ? { ...SEED_PROJECTS[0], id: "experience", name: "光庭 · 体验空间", local: true } : route.startsWith("project/") ? projects.find(p => p.id === route.slice(8)) : undefined;
  const capture = route === "capture";
  const inSession = phase !== "idle";
  const connected = connection === "online";
  // 仅供前端演示：每 24 秒安排一次超速区间，阈值不是设备作业标准。
  const demoSpeedLimit = 1.0;
  const speedCycle = previewSeconds % 24;
  const movementSpeed = connected && phase === "scanning"
    ? Number((speedCycle >= 8 && speedCycle < 13 ? 1.25 + 0.08 * Math.sin(speedCycle) : 0.45 + 0.12 * Math.sin(speedCycle / 2)).toFixed(2))
    : null;
  const speeding = movementSpeed !== null && movementSpeed > demoSpeedLimit;

  const navigate = (destination: string) => { location.hash = `/${destination}`; };
  useEffect(() => {
    const onRoute = () => { setRoute(location.hash.slice(2) || "scan"); setTool("view"); setPicks([]); setTop(false); };
    window.addEventListener("hashchange", onRoute); return () => window.removeEventListener("hashchange", onRoute);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(RECORD_KEY, JSON.stringify(projects)); setStorageFailed(false); }
    catch { setStorageFailed(true); if (!storageAlerted.current) { setNotice("浏览器存储不可用，演示记录仅保留在本次打开期间"); storageAlerted.current = true; } }
  }, [projects]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 4200); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!connected) setRtkConnected(false); }, [connected]);
  useEffect(() => {
    if (!savedProject) return;
    setProjects(values => values.some(p => p.id === savedProject.id) ? values : [savedProject, ...values]);
    setModal(null); navigate(`project/${savedProject.id}`); setNotice("已保存到模拟设备项目");
  }, [savedProject]);
  useEffect(() => {
    // 浏览器调试返回键与原生返回事件共用退出规则，活动扫描先展示保存面板。
    const back = () => {
      if (modal) { setModal(null); return; }
      if (transferOpen) { setTransferOpen(false); return; }
      if (renameId || deleteId || tutorial !== null) { setRenameId(null); setDeleteId(null); setTutorial(null); return; }
      if (capture && ["initializing", "saving"].includes(phase)) { setNotice("请等待当前操作完成"); return; }
      if (capture && inSession) { setModal("finish"); return; }
      navigate(current ? isExperience ? "library" : "records" : "scan");
    };
    const receive = (event: MessageEvent) => {
      if (isLabMessage(event) && event.data.type === "omni-lab:back") back();
    };
    window.addEventListener("message", receive);
    window.addEventListener("omni:native-back", back);
    return () => { window.removeEventListener("message", receive); window.removeEventListener("omni:native-back", back); };
  }, [modal, transferOpen, renameId, deleteId, tutorial, capture, phase, inSession, current, isExperience]);
  useEffect(() => {
    if (!transfer || transfer.paused || !["download", "upload"].includes(transfer.stage)) return;
    const timer = window.setInterval(() => setTransfer(t => t ? { ...t, progress: Math.min(100, t.progress + 7) } : t), 200);
    return () => clearInterval(timer);
  }, [transfer?.stage, transfer?.paused, transfer?.projectId]);
  useEffect(() => {
    if (!transfer || transfer.progress < 100 || !["download", "upload"].includes(transfer.stage)) return;
    const completed = transfer;
    setProjects(list => list.map(p => p.id === completed.projectId ? { ...p, local: true, uploaded: p.uploaded || completed.stage === "upload" } : p));
    setTransfer(t => t ? { ...t, stage: t.stage === "download" && t.intent === "upload" ? "network" : "done", progress: t.stage === "download" && t.intent === "upload" ? 0 : 100 } : t);
  }, [transfer]);

  // 扫描前不收集名称；结束时才决定保存或丢弃。
  const beginCapture = () => {
    if (!connected || inSession) return;
    setName(""); setCameraMain(false); setCameraFullscreen(false); setOpticalLens("front"); scanner.start();
    setModal(null); setViewMode("points"); setTop(false); navigate("capture");
  };
  const connectAndStart = () => {
    if (connected) {
      start();
      return;
    }
    pendingAutoJump.current = true;
    scanner.connect();
  };
  const start = () => {
    if (inSession) { navigate("capture"); return; }
    if (connected) beginCapture(); else connectAndStart();
  };

  useEffect(() => {
    if (connected && pendingAutoJump.current) {
      pendingAutoJump.current = false;
      beginCapture();
      setNotice("模拟手持设备已就绪，已进入扫描工作台");
    }
  }, [connected]);
  const startTransfer = (project: DemoProject, intent: "download" | "upload") => {
    if (transfer && transfer.stage !== "done") { setTransferOpen(true); setNotice("请先完成或取消当前传输"); return; }
    setTransfer({ projectId: project.id, intent, stage: project.local ? "upload" : "download", progress: 0, paused: false });
    setTransferOpen(true);
  };
  const exportText = async (filename: string, content: string, type = "application/json") => {
    try { setNotice(`${await downloadDemo(filename, content, type)}；仅为演示成果`); }
    catch (error) { setNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const saveSample = (project: DemoProject) => {
    void exportText(`${project.name.replace(/[\\/]/g, "_")}-演示清单.json`, JSON.stringify({ demo: true, description: "前端模拟项目，不包含真实扫描数据", project }, null, 2));
  };
  const onPick = (point: [number, number, number]) => setPicks(values => values.length >= 2 ? [point] : [...values, point]);
  const distance = picks.length === 2 ? Math.hypot(picks[1][0] - picks[0][0], picks[1][2] - picks[0][2]) : null;
  const changeTool = (value: typeof tool) => { setTool(value); setPicks([]); if (value === "slice") { setTop(true); setViewMode("points"); } };
  const displaySettings = <>
    
    {!capture && <><label className="field-label">显示方式</label><div className="segmented"><button className={viewMode === "points" ? "active" : ""} onClick={() => setViewMode("points")}>点云预览</button><button className={viewMode === "solid" ? "active" : ""} onClick={() => setViewMode("solid")}>实体预览</button></div></>}
    <label className="field-label">点云颜色</label><div className="segmented"><button className={!heightColor ? "active" : ""} onClick={() => setHeightColor(false)}>材质颜色</button><button className={heightColor ? "active" : ""} onClick={() => setHeightColor(true)}>高度着色</button></div>
    <label className="range-label">点大小 <b>{Math.round(pointSize * 1000)}</b><input type="range" min="20" max="75" step="5" value={pointSize * 1000} onChange={e => setPointSize(Number(e.target.value) / 1000)} /></label>
    <button className="primary full" onClick={() => setModal(null)}>应用显示设置<Check size={17} /></button>
  </>;

  return <div className={`handheld-app ${capture ? "immersive" : ""}`}>
    {!capture && <aside className="side-nav"><button className="brand-symbol" aria-label="返回扫描工作台" onClick={() => navigate("scan")}><Scan size={30} strokeWidth={1.7} /><span /></button><div className="nav-items">{[{ id: "library", icon: Grid2X2, title: "素材" }, { id: "scan", icon: Scan, title: "扫描" }, { id: "records", icon: FolderOpen, title: "记录" }].map(({ id, icon: Icon, title }) => <button key={id} className={`${id === "scan" ? "nav-scan-add" : ""} ${(route === id || (id === "records" && current && !isExperience) || (id === "library" && isExperience)) ? "active" : ""}`} aria-label={title} aria-current={route === id || (id === "library" && isExperience) ? "page" : undefined} onClick={() => navigate(id)}>{id === "scan" ? <Plus size={32} strokeWidth={1.5} /> : <><Icon size={22} /><span>{title}</span></>}</button>)}</div><button className="nav-help" aria-label="演示使用帮助" onClick={() => setModal("help")}><CircleHelp size={21} /></button></aside>}
    <div className="app-body">
      {!capture && <header className="app-header"><div className="brand-name">观曜<span className="brand-divider" /><b>OMNI SCAN</b></div><div className="header-actions"><button className="avatar" aria-label="设置" onClick={() => setModal("settings")}>G</button></div></header>}

      {!capture && inSession && <button className="resume-banner" onClick={() => navigate("capture")}><Radio size={16} />{phase === "saving" ? "项目正在保存" : "有一个进行中的扫描"}<span>{formatDuration(seconds)} · 返回扫描 <ArrowRight size={14} /></span></button>}

      {route === "scan" && <main className="home-page page-content">
        <div className="page-heading"><div><h1>扫描工作台</h1></div></div>
        <div className="scan-launch-layout">
          <section className="device-card">
            <div className="section-mini-title">
              <span>我的设备</span>
              <button
                type="button"
                className="rebind-action-btn"
                onClick={() => setModal("connect")}
                aria-label="换绑设备"
                title="更换绑定的手持设备或修改网络连接地址"
              >
                <ArrowLeftRight size={13} />
                <span>换绑设备</span>
              </button>
            </div>
            <div className="device-identity">
              <div className="device-icon"><Radio size={33} strokeWidth={1.4} /></div>
              <div>
                <h2>OMNI Handheld</h2>
                <span>手持激光扫描仪</span>
              </div>
            </div>
            <div className={`connection-state ${connected ? "online" : connection === "connecting" ? "connecting" : ""}`}>
              {connection === "connecting" ? (
                <><LoaderCircle className="spin" size={13} /> 正在连接设备…</>
              ) : (
                <><span className="small-dot" />{connected ? (inSession ? "采集中" : "已连接 · 就绪") : "未连接设备"}</>
              )}
            </div>
            <div className="device-metrics">
              <div>
                <BatteryMedium size={19} />
                <strong>{connected ? "86" : "—"}<small>{connected && "%"}</small></strong>
                <span>设备电量</span>
              </div>
              <div>
                <HardDrive size={17} />
                <strong>{connected ? "112" : "—"}<small>{connected && "GB"}</small></strong>
                <span>可用空间</span>
              </div>
            </div>
          </section>

          <div className="sensor-status" aria-label="传感器状态">
            {[{ icon: Radio, title: "激光雷达" }, { icon: Box, title: "三目相机" }, { icon: Compass, title: "惯性导航" }].map(({ icon: Icon, title }) => (
              <div key={title} className={connected ? "ready" : ""} role="img" aria-label={`${title}：${connected ? "已连接" : "未连接"}`}>
                <Icon size={23} />
                <span>{title}</span>
              </div>
            ))}
            <button
              className={connected && rtkConnected ? "ready" : ""}
              aria-label={`RTK：${connected && rtkConnected ? "已连接，点击断开" : "未连接，点击连接"}`}
              aria-pressed={connected && rtkConnected}
              onClick={() => { if (!connected) { setModal("connect"); return; } setRtkConnected(v => !v); }}
            >
              <Satellite size={23} />
              <span>RTK</span>
            </button>
          </div>

          {/* 黄金路径主按钮 */}
          <button
            className="primary full scan-start-button"
            disabled={phase === "initializing" || phase === "saving" || connection === "connecting"}
            onClick={connected ? start : connectAndStart}
          >
            {connection === "connecting" ? (
              <><LoaderCircle className="spin" size={18} /> 正在连接设备…</>
            ) : connected ? (
              <>{inSession ? "返回扫描" : "开始扫描"}<ArrowRight size={18} /></>
            ) : (
              <>连接设备并开始扫描<ArrowRight size={18} /></>
            )}
          </button>
        </div>
      </main>}

      {route === "records" && <main className="page-content records-page"><div className="page-heading"><div><h1>空间记录</h1></div><button className="primary" onClick={start}><Plus size={18} />新建扫描</button></div><div className="record-toolbar"><div className="segmented record-tabs"><button className={recordTab === "local" ? "active" : ""} onClick={() => setRecordTab("local")}><Smartphone size={16} />手机本地 <span>{projects.filter(p => p.local).length}</span></button><button className={recordTab === "device" ? "active" : ""} onClick={() => setRecordTab("device")}><HardDrive size={16} />设备项目 <span>{projects.length}</span></button></div><div className="search-sort"><label className="search-field"><Search size={17} /><input placeholder="搜索记录" aria-label="搜索项目名称" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="项目排序" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">最近创建</option><option value="name">名称排序</option><option value="size">文件大小</option></select></div></div><div className="records-grid">{projects.filter(p => (recordTab === "device" || p.local) && p.name.includes(query.trim())).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : sort === "size" ? b.size - a.size : b.date.localeCompare(a.date)).map(project => <ProjectCard key={project.id} project={project} onOpen={() => navigate(`project/${project.id}`)} />)}</div>{!projects.some(p => (recordTab === "device" || p.local) && p.name.includes(query.trim())) && <div className="empty-state"><FolderOpen size={38} /><h2>{query ? "没有找到相关记录" : "这里还没有空间记录"}</h2><p>{query ? "尝试另一个名称，或清空搜索条件。" : "从设备项目下载一份示例，或开始新扫描。"}</p><button className="secondary" onClick={() => { setQuery(""); setRecordTab("device"); }}>查看设备项目</button></div>}</main>}

      {current && <main className="page-content detail-page"><button className="back-link" onClick={() => navigate(isExperience ? "library" : "records")}><ArrowLeft size={17} />{isExperience ? "返回素材" : "全部记录"}</button><div className="page-heading"><div><h1>{current.name}</h1>{!isExperience && <p><MapPin size={14} />{current.location}<span>·</span>{formatDate(current.date)}</p>}</div>{!isExperience && <button className="secondary" onClick={() => { setRenameId(current.id); setRenameText(current.name); }}><Settings2 size={16} />编辑名称</button>}</div><div className="detail-layout"><section className="detail-viewport"><DemoScene mode={viewMode} top={top} reset={reset} heightColor={heightColor} pointSize={pointSize} slice={tool === "slice" ? { height: sliceHeight, thickness: sliceThickness } : undefined} picking={tool === "measure"} onPick={onPick} /><div className="viewport-tag"><span className="small-dot" />示例空间 · {tool === "slice" ? "水平切片" : tool === "measure" ? "地面测量" : "三维预览"}</div><div className="viewport-actions"><button className="icon-button" aria-label="复位项目视角" onClick={() => { setReset(n => n + 1); setTop(false); }}><RotateCcw size={18} /></button><button className="icon-button" aria-label="切换项目俯视" onClick={() => setTop(!top)}><Layers size={18} /></button></div><div className="viewer-toolstrip">{[{ key: "view", label: "查看", icon: Move3D }, { key: "measure", label: "测量", icon: Ruler }, { key: "slice", label: "切片", icon: Layers }].map(({ key, label, icon: Icon }) => <button key={key} className={tool === key ? "active" : ""} disabled={key !== "view" && !current.local} onClick={() => changeTool(key as typeof tool)}><Icon size={18} />{label}</button>)}<button onClick={() => setModal("display")}><SlidersHorizontal size={18} />显示</button></div></section><aside className="detail-sidebar">
          {tool === "measure" ? <section className="white-card tool-card"><h2>地面两点测量</h2><p>在示例地面上点选两个位置，计算平面距离。拖动仍可旋转视角。</p><div className="measure-result"><Ruler size={21} /><strong>{distance === null ? "— —" : distance.toFixed(2)}</strong><span>m</span></div><div className="step-status"><span className={picks.length > 0 ? "done" : ""}>1</span>选择起点 A {picks.length > 0 && <Check size={15} />}</div><div className="step-status"><span className={picks.length > 1 ? "done" : ""}>2</span>选择终点 B {picks.length > 1 && <Check size={15} />}</div><small>基于程序模型坐标计算，不能作为实测结果。</small><button className="secondary full" onClick={() => { setPicks([]); setTool("view"); }}>退出测量</button></section> : tool === "slice" ? <section className="white-card tool-card"><h2>水平切片</h2><p>调整切片范围，在俯视图中观察空间结构。</p><label className="range-label">中心高度 <b>{sliceHeight.toFixed(2)} m</b><input type="range" min="0.1" max="2.8" step="0.05" value={sliceHeight} onChange={e => setSliceHeight(Number(e.target.value))} /></label><label className="range-label">切片厚度 <b>{sliceThickness.toFixed(2)} m</b><input type="range" min="0.1" max="2" step="0.05" value={sliceThickness} onChange={e => setSliceThickness(Number(e.target.value))} /></label><div className="info-note">范围 {(sliceHeight - sliceThickness / 2).toFixed(2)}—{(sliceHeight + sliceThickness / 2).toFixed(2)} m</div><button className="primary full" onClick={() => { void exportText("示例平面-DEMO.dxf", demoDxf(sliceHeight, sliceThickness), "application/dxf"); }}><Download size={16} />导出示意 DXF</button><small>演示文件为固定示意平面；滑块仅控制三维预览。</small></section> : isExperience ? <section className="white-card experience-tools"><h2>动手探索</h2><button className="secondary full" onClick={() => changeTool("measure")}><Ruler size={18} />试试两点测量</button><button className="secondary full" onClick={() => changeTool("slice")}><Layers size={18} />看看水平切片</button></section> : <section className="white-card"><h2>项目概览</h2><dl className="project-properties"><div><dt>采集时长</dt><dd>{formatDuration(current.seconds)}</dd></div><div><dt>点数</dt><dd>{current.points}</dd></div><div><dt>数据量</dt><dd>{current.size} MB</dd></div><div><dt>设备副本</dt><dd><CheckCircle2 size={14} />已保存</dd></div><div><dt>手机副本</dt><dd>{current.local ? "已下载" : "未下载"}</dd></div><div><dt>云端状态</dt><dd>{current.uploaded ? "已上传" : "未上传"}</dd></div></dl></section>}
          {!isExperience && <section className="white-card action-card">{!current.local ? <button className="primary full" onClick={() => startTransfer(current, "download")}><ArrowDownToLine size={17} />下载到手机</button> : <button className="primary full" onClick={() => saveSample(current)}><Download size={17} />导出演示清单</button>}<button className="secondary full" onClick={() => startTransfer(current, "upload")}><CloudUpload size={17} />上传项目</button>{!current.local && <p>下载后可体验测量与切片。</p>}<button className="danger-text" onClick={() => setDeleteId(current.id)}><Trash2 size={14} />删除记录</button></section>}</aside></div></main>}

      {route === "library" && <main className="page-content library-page"><div className="page-heading"><div><h1>空间素材</h1></div><BookOpen className="heading-icon" size={36} strokeWidth={1.3} /></div><div className="segmented library-tabs">{["空间素材", "采集指南"].map(tab => <button key={tab} className={libraryTab === tab ? "active" : ""} onClick={() => setLibraryTab(tab)}>{tab}</button>)}</div>{libraryTab === "空间素材" ? <><section className="experience-card"><div className="experience-art"><ModelThumb kind="studio" /><span className="experience-label">交互体验空间</span></div><div className="experience-content"><h2>光庭 · 体验空间</h2><p>用一个空间，认识三维扫描。</p><div className="experience-features"><span><Move3D size={15} />旋转</span><span><Ruler size={15} />测量</span><span><Layers size={15} />切片</span></div><button className="primary full" onClick={() => navigate("experience")}>进入体验<ArrowRight size={18} /></button></div></section></> : <div className="guide-list">{["第一次扫描，从这里开始", "怎样获得更完整的空间", "记录、下载与成果分享"].map((title, i) => <button className="guide-card" key={title} onClick={() => setTutorial(i)}><span className="guide-symbol"><BookOpen size={27} /></span><div><h2>{title}</h2><p>{["连接、初始化、采集与保存的完整流程", "观察点云、慢速移动、检查遗漏区域", "认识设备项目、手机副本与演示导出"][i]}</p></div><ChevronRight size={20} /></button>)}</div>}</main>}

      {capture && <main className={`capture-page pip-view compact-pip ${cameraMain ? "camera-main" : "cloud-main"} ${cameraFullscreen ? "camera-fullscreen" : ""} ${pipPosition.right ? "pip-right" : ""}`} style={{ "--pip-y": `${pipPosition.y}%` } as CSSProperties}><div className="capture-panes"><section className="capture-cloud-pane" aria-label="扫描点云">{cameraMain && pipHandle}<DemoScene mode="points" top={top} heightColor={heightColor} pointSize={pointSize} reset={reset} progress={phase === "scanning" || phase === "paused" ? Math.min(1, 0.15 + previewSeconds / 80) : 1} /></section><section className="capture-camera-pane" aria-label="可见光画面">{!cameraMain && pipHandle}<DemoScene optical lens={opticalLens} opticalSeconds={previewSeconds} /></section></div>{cameraFullscreen && <button className="exit-camera-fullscreen" onClick={() => setCameraFullscreen(false)}><Expand size={17} />退出全屏</button>}<header className="capture-header"><button className="icon-button" aria-label="返回扫描工作台" onClick={() => { if (phase === "scanning" || phase === "paused") setModal("finish"); else if (phase === "idle") navigate("scan"); else setNotice("请等待当前操作完成"); }}><ArrowLeft size={21} /></button><div className="capture-title"><h1>{phase === "idle" ? "实时预览" : "正在扫描"}</h1></div><button className="icon-button" aria-label="连接管理" onClick={() => setModal("connect")}>{connected ? <Wifi size={20} /> : <WifiOff size={20} />}</button><button className="icon-button" aria-label="扫描显示设置" onClick={() => setModal("display")}><SlidersHorizontal size={20} /></button></header><div className="capture-telemetry"><span><BatteryMedium size={16} />86%</span><span><HardDrive size={15} />112 GB</span><span><Box size={15} />{(previewSeconds * 1.8).toFixed(1)} 万点</span><span className={`movement-speed ${speeding ? "is-speeding" : ""}`} aria-label="移动速度" title="模拟移动速度，演示提醒阈值为 1.00 m/s"><Gauge size={16} /><span>{movementSpeed === null ? "—" : movementSpeed.toFixed(2)} m/s</span></span></div>{!connected && inSession && <div className="connection-warning"><WifiOff size={18} /><div><b>预览连接已中断</b><span>设备继续采集，重新连接后恢复控制。</span></div><button onClick={() => scanner.connect()}>{connection === "connecting" ? "重连中…" : "重新连接"}</button></div>}
        <div className={`capture-guide ${speeding ? "speed-warning" : ""}`} role="status" aria-live="polite">{speeding ? <AlertTriangle size={16} /> : <span className={`status-orb ${phase === "scanning" ? "recording" : ""}`} />}<span>{speeding ? "移动过快，请减速" : phase === "scanning" ? "采集中 · 匀速平稳行走" : phase === "paused" ? "采集已暂停" : phase === "idle" ? "实时预览已就绪" : phase === "initializing" ? "设备初始化中，请保持静止" : "正在保存点云…"}</span></div><div className="capture-controls"><span className="capture-time">{formatDuration(seconds)}</span><span className="capture-time-label">{phase === "scanning" ? "● REC" : phase === "paused" ? "PAUSED" : "就绪"}</span><button className={`shutter ${phase === "scanning" || phase === "paused" ? "is-recording" : ""}`} aria-label={phase === "scanning" || phase === "paused" ? "结束扫描" : "开始扫描"} disabled={phase === "initializing" || phase === "saving" || !connected} onClick={() => { if (phase === "scanning" || phase === "paused") setModal("finish"); else beginCapture(); }}>{phase === "initializing" || phase === "saving" ? <LoaderCircle className="spin" size={30} /> : phase === "scanning" || phase === "paused" ? <Square size={27} fill="currentColor" /> : <span />}</button><span className="shutter-label">{phase === "scanning" || phase === "paused" ? "结束扫描" : "开始扫描"}</span>{(phase === "scanning" || phase === "paused") && <button className="pause-button" disabled={!connected} onClick={() => phase === "scanning" ? scanner.pause() : scanner.resume()}>{phase === "scanning" ? <Pause size={17} /> : <Play size={17} />}{phase === "scanning" ? "暂停" : "继续"}</button>}</div><div className="capture-bottom"><div className="capture-switch-tools"><button className="icon-button" aria-label="切换主画面" title="切换主画面" onClick={() => { setCameraFullscreen(false); setCameraMain(v => !v); }}>{cameraMain ? <Camera size={19} /> : <Box size={19} />}<span>{cameraMain ? "可见光" : "点云"}</span></button><button className="icon-button" aria-label={`切换镜头，当前${{ front: "前", left: "左", right: "右", panorama: "全景" }[opticalLens]}`} onClick={() => setOpticalLens(current => ({ front: "left", left: "right", right: "panorama", panorama: "front" } as const)[current])}><Camera size={19} /><span>{{ front: "前", left: "左", right: "右", panorama: "全景" }[opticalLens]}</span></button></div><div className="capture-bottom-tools"><button className="icon-button" aria-label="扫描俯视切换" onClick={() => setTop(!top)}><Compass size={20} /></button><button className="icon-button" aria-label="扫描视角复位" onClick={() => { setTop(false); setReset(n => n + 1); }}><Crosshair size={20} /></button></div></div>{(phase === "initializing" || phase === "saving") && <div className="phase-overlay"><div><LoaderCircle className="spin" size={34} /><h2>{phase === "initializing" ? "正在初始化设备" : "正在保存项目"}</h2><p>{phase === "initializing" ? "静置 → 检查传感器 → 建立初始地图" : "整理数据 → 保存项目"}</p></div></div>}</main>}

      {!capture && route !== "scan" && route !== "library" && route !== "records" && !current && <main className="empty-state"><FolderOpen size={40} /><h1>没有找到这个演示页面</h1><p>项目可能已删除，或链接已经失效。</p><button className="primary" onClick={() => navigate("scan")}>返回扫描工作台</button></main>}
    </div>

    {transfer && !transferOpen && <button className="transfer-float" onClick={() => setTransferOpen(true)}><CloudUpload size={18} />{transfer.stage === "done" ? "传输已完成" : transfer.stage === "network" ? "等待切换网络" : `传输 ${transfer.progress}%`}<ChevronRight size={16} /></button>}
    {notice && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}

    {modal && <Modal title={{ connect: "换绑设备", finish: "保存扫描", discard: "放弃本次扫描？", settings: "设置与偏好", display: "显示设置", help: "快速入门" }[modal]} onClose={() => setModal(null)}>
      {modal === "connect" && <>
        <div className="modal-device-card">
          <div className="device-avatar">
            <Radio size={22} />
          </div>
          <div className="device-info">
            <h3>OMNI Handheld</h3>
            <p>手持激光扫描仪</p>
          </div>
          <div className={`status-pill ${connected ? "online" : ""}`}>
            <span className="dot" />
            <span>{connected ? "已连接" : "未连接"}</span>
          </div>
        </div>

        <div className="rebind-hint-box">
          更换设备时，在此输入设备连接地址：
        </div>

        <form onSubmit={e => {
          e.preventDefault();
          pendingAutoJump.current = true;
          setModal(null);
          scanner.connect();
          setNotice("正在连接设备…");
        }}>
          <label className="field-label" htmlFor="demo-device-id">设备连接地址</label>
          <input
            id="demo-device-id"
            className="text-input"
            value={demoDeviceUrl}
            onChange={e => setDemoDeviceUrl(e.target.value)}
            placeholder="omni-demo://handheld-001"
            required
          />

          <div className="preset-chips">
            <span className="chips-label">快捷选择：</span>
            <button
              type="button"
              className="chip-btn"
              onClick={() => setDemoDeviceUrl("omni-demo://handheld-001")}
            >
              默认设备
            </button>
            <button
              type="button"
              className="chip-btn"
              onClick={() => setDemoDeviceUrl("omni-demo://handheld-002")}
            >
              备用设备
            </button>
          </div>

          <button type="submit" className="primary full" style={{ marginTop: 18 }} disabled={connection === "connecting"}>
            {connection === "connecting" ? <><LoaderCircle className="spin" size={17} />正在连接…</> : "保存并连接"}
          </button>
        </form>

        {connected && (
          <button
            className="secondary full"
            style={{ marginTop: 10 }}
            onClick={() => {
              scanner.disconnect();
              setNotice(inSession ? "连接已断开，采集继续" : "设备已断开");
            }}
          >
            断开连接
          </button>
        )}
      </>}
      {modal === "finish" && <><p className="dialog-description">扫描已完成，请输入空间名称保存：</p><div className="finish-summary"><div><Timer size={21} /><strong>{formatDuration(seconds)}</strong><span>采集时长</span></div><div><Box size={21} /><strong>{(seconds * 1.8).toFixed(1)} 万</strong><span>点数</span></div></div><form onSubmit={e => { e.preventDefault(); if (!name.trim() || !connected) return; setModal(null); scanner.save(name); }}><label className="field-label" htmlFor="scan-name">项目名称</label><input id="scan-name" className="text-input" maxLength={40} required placeholder="例如：二楼会议室" value={name} onChange={e => setName(e.target.value)} /><button type="submit" className="primary full" disabled={!name.trim() || !connected || phase === "saving"}>保存扫描<Check size={17} /></button></form>{!connected && <p className="form-error">请重新连接设备后保存。</p>}<button className="secondary full" onClick={() => setModal(null)}>返回扫描</button><button className="danger-text full" onClick={() => setModal("discard")}><Trash2 size={16} />放弃本次扫描</button></>}
      {modal === "discard" && <><p className="dialog-description">确定放弃本次扫描吗？放弃后数据将不会保存。已有记录不受影响。</p><button className="danger-button full" disabled={!connected} onClick={() => { scanner.discard(); setName(""); setModal(null); navigate("scan"); setNotice("已放弃本次扫描"); }}>放弃扫描</button><button className="secondary full" onClick={() => setModal("finish")}>返回继续保存</button></>}
      {modal === "display" && displaySettings}
      {modal === "settings" && <>
        {/* 顶部作业员名片 */}
        <div className="settings-profile-card">
          <div className="avatar-badge">G</div>
          <div className="profile-info">
            <h3>现场作业员</h3>
            <p>{connected ? "演示设备已就绪" : "演示设备未连接"}</p>
          </div>
          <span className={`profile-status-badge ${connected ? "online" : ""}`}>
            {connected ? "已连接" : "未连接"}
          </span>
        </div>

        {/* 模拟设备参数 */}
        <form onSubmit={e => {
          e.preventDefault();
          scanner.connect();
          setNotice("已保存并连接设备");
        }}>
          <label className="field-label" htmlFor="settings-demo-url">设备连接地址</label>
          <input
            id="settings-demo-url"
            className="text-input"
            value={demoDeviceUrl}
            onChange={e => setDemoDeviceUrl(e.target.value)}
            placeholder="omni-demo://handheld-001"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <div className="settings-actions-group">
            <button type="submit" className="primary" disabled={connection === "connecting"}>
              {connection === "connecting" ? <><LoaderCircle className="spin" size={16} /> 连接中…</> : "保存并连接"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                scanner.disconnect();
                setNotice("设备预览已断开");
              }}
            >
              断开预览
            </button>
          </div>
        </form>

        <div style={{ marginTop: 14 }}>
          <button className="secondary full" onClick={() => { setModal(null); navigate("library"); setLibraryTab("采集指南"); }}>
            <BookOpen size={16} />查看使用指南
          </button>
        </div>
      </>}
      {modal === "help" && <><p className="dialog-description">简单三步，完成空间扫描：</p><ol className="help-steps"><li><b>连接设备</b><span>手机连接手持设备 Wi-Fi 热点。</span></li><li><b>匀速行走</b><span>点击“开始扫描”，平稳环绕目标空间行走。</span></li><li><b>保存成果</b><span>扫描结束后输入空间名称保存。</span></li></ol><button className="primary full" onClick={() => setModal(null)}>我知道了<ArrowRight size={17} /></button></>}
    </Modal>}

    {transferOpen && transfer && <Modal title="项目传输" onClose={() => setTransferOpen(false)}><p className="dialog-description">{projects.find(p => p.id === transfer.projectId)?.name ?? "演示项目"}</p><div className="transfer-steps"><div className={transfer.stage !== "download" ? "done" : "active"}><span><Smartphone size={20} /></span><div><b>设备 → 手机</b><small>{transfer.stage === "download" ? "正在下载" : "本地副本已就绪"}</small></div>{transfer.stage !== "download" && <CheckCircle2 size={19} />}</div>{transfer.intent === "upload" && <div className={transfer.stage === "done" ? "done" : transfer.stage === "upload" ? "active" : ""}><span><Cloud size={20} /></span><div><b>手机 → 云端</b><small>{transfer.stage === "network" ? "等待切换网络" : transfer.stage === "upload" ? "正在上传" : transfer.stage === "done" ? "上传完成" : "等待下载完成"}</small></div>{transfer.stage === "done" && <CheckCircle2 size={19} />}</div>}</div>{transfer.stage === "network" ? <><div className="info-note">设备热点通常不提供互联网。先保留手机副本，再选择互联网连接完成上传。</div><button className="primary full" onClick={() => setTransfer(t => t ? { ...t, stage: "upload", progress: 0 } : t)}><Wifi size={17} />切换到互联网</button></> : transfer.stage === "done" ? <><div className="transfer-complete"><CheckCircle2 size={38} /><h3>传输完成</h3><p>{transfer.intent === "upload" ? "已上传到云端。" : "可在手机本地查看此项目。"}</p></div><button className="primary full" onClick={() => { navigate(`project/${transfer.projectId}`); setTransferOpen(false); setTransfer(null); }}>查看项目<ArrowRight size={17} /></button></> : <><div className="progress-label"><span>{transfer.paused ? "传输已暂停" : transfer.stage === "download" ? "下载中" : "上传中"}</span><b>{transfer.progress}%</b></div><progress max={100} value={transfer.progress} aria-label="传输进度" /><button className="secondary full" onClick={() => setTransfer(t => t ? { ...t, paused: !t.paused } : t)}>{transfer.paused ? <Play size={16} /> : <Pause size={16} />}{transfer.paused ? "继续传输" : "暂停传输"}</button><button className="text-button full" onClick={() => { setTransfer(null); setTransferOpen(false); setNotice("已取消传输"); }}>取消传输</button></>}</Modal>}
    {deleteId && <Modal title="删除记录？" onClose={() => setDeleteId(null)}><p className="dialog-description">仅删除“{projects.find(p => p.id === deleteId)?.name}”的浏览器演示记录，不影响真实文件。演示的设备、本地和云端状态会一并移除。</p><button className="danger-button full" onClick={() => { setProjects(list => list.filter(p => p.id !== deleteId)); if (transfer?.projectId === deleteId) { setTransfer(null); setTransferOpen(false); } setDeleteId(null); navigate("records"); setNotice("记录已删除"); }}>确认删除记录</button><button className="secondary full" onClick={() => setDeleteId(null)}>保留记录</button></Modal>}
    {renameId && <Modal title="编辑项目名称" onClose={() => setRenameId(null)}><form onSubmit={e => { e.preventDefault(); if (!renameText.trim()) return; setProjects(list => list.map(p => p.id === renameId ? { ...p, name: renameText.trim() } : p)); setRenameId(null); setNotice("项目名称已更新"); }}><label className="field-label" htmlFor="rename-project">项目名称</label><input id="rename-project" className="text-input" value={renameText} maxLength={40} required onChange={e => setRenameText(e.target.value)} /><button type="submit" className="primary full" disabled={!renameText.trim()}>保存名称<Check size={17} /></button></form></Modal>}
    {tutorial !== null && <Modal title={["第一次扫描，从这里开始", "怎样获得更完整的空间", "记录、下载与成果分享"][tutorial]} onClose={() => setTutorial(null)}><p className="dialog-description">采集指南 · 交互演示说明</p><ol className="help-steps">{(tutorial === 0 ? [["连接设备", "在扫描页选择演示设备，等待模拟网络与设备状态就绪。"], ["放稳并初始化", "点击大加号开始。初始化完成后进入扫描，计时自动开始。"], ["结束并保存", "点击方形结束按钮，满意后填写名称保存；不满意可放弃重扫。"]] : tutorial === 1 ? [["留意视图覆盖", "拖动场景查看遮挡区域，结合高度颜色与俯视观察结构。"], ["稳定移动", "实际采集遵循设备操作要求；此演示不评估真实移动速度或覆盖质量。"], ["检查成果", "保存后在项目中旋转、测量和切片，了解成果查看流程。"]] : [["设备与手机分开", "新模拟项目位于设备页签，下载后出现在手机本地。"], ["体验两阶段上云", "先模拟下载，再模拟切换互联网，最后模拟上传。"], ["导出演示文件", "清单是带 demo 标记的 JSON；切片工具可导出固定示意 DXF。"]]).map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}</ol><button className="primary full" onClick={() => { setTutorial(null); navigate("scan"); }}>回到扫描工作台<ArrowRight size={17} /></button></Modal>}
  </div>;
}
