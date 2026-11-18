import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  BoxSelect, Camera, ChevronDown, Circle, CircleX, CloudDownload, Crop, Database, FileDown, FileOutput, FolderOpen,
  Eye, EyeOff, Gauge, Layers3, LoaderCircle, MapPinned, Move, PackageCheck, Palette, PlugZap, Ruler, RotateCcw, Save,
  Settings, Square, Sun, Moon, TimerReset, Trash2, Undo2, X,
} from "lucide-react";
import type { Channel } from "@foxglove/ws-protocol";
import { CameraView } from "./components/CameraView";
import { CadPanel, type CadWorkflowView } from "./components/CadPanel";
import { PointCloudCanvas } from "./components/PointCloudCanvas";
import { QualityPanel } from "./components/QualityPanel";
import { StatusCards } from "./components/StatusCards";
import { SpatialWelcome } from "./components/SpatialWelcome";
import { useCadLinking } from "./components/useCadLinking";
import type { CreationContext } from "./creation/ObjectStudio";
import type { CadPreviewSource } from "./cad/linking";
import { mergeCommonFrameClouds, pruneDecayFrames, type TimedPointCloud } from "./domain/decay";
import { applyEdit, visibleIndices } from "./domain/edits";
import { exportPcd, parsePcd } from "./domain/pcd";
import { exportPly, parsePly } from "./domain/ply";
import { exportLas, parseLasOrLaz } from "./domain/las";
import { loadMcapPointCloud } from "./domain/mcapImport";
import type { CameraDirection, ColorMode, DeviceProfile, EditOperation, GeoPosition, PointCloudData, PointCloudStream, ProjectManifest } from "./domain/types";
import { CAMERA_DIRECTIONS, DEFAULT_COLOR_MODE, DEFAULT_DEVICE_PROFILE, POINT_CLOUD_STREAMS, pointCloudTopicEntries, pointCount } from "./domain/types";
import { exportPointCloudMcap } from "./export/mcap";
import { exportThreeDgsDataset } from "./export/threeDgs";
import {
  applyCadAnnotations,
  buildDrawingModel,
  DEFAULT_CAD_DRAWING_SETTINGS,
  type CadAnnotation,
  type CadDrawingSettings,
} from "./cad/model";
import { createCadDelivery } from "./cad/package";
import {
  computeCadSummary,
  findTopPlaneIndices,
  type CadProjection,
} from "./cad/geometry";
import { openColmapDirectory, openPointCloudFile, pointCloudImportLimit, saveBinaryFile, saveTextFile } from "./platform/files";
import { buildQualityReport, createStableQualitySample } from "./quality/analyze";
import type { QualityProfileId, StaticQualityEvidence } from "./quality/types";
import { LiveMcapRecorder } from "./storage/liveMcapRecorder";
import { listProjects, loadProjectCloud, saveProject, saveProjectCloud } from "./storage/projectStore";
import { FoxgloveSource, type SourceState } from "./transport/foxgloveSource";
import "./styles.css";
import "./adaptive-workbench.css";
import "./spatial-experience.css";
import "./cad-linking.css";
import "./theme.css";

const ObjectStudio = lazy(() => import("./creation/ObjectStudio").then(module => ({ default: module.ObjectStudio })));
const RtkMap = lazy(() => import("./components/RtkMap").then((module) => ({ default: module.RtkMap })));
const LIVE_CLOUD_REFRESH_MS = 100;
const DEFAULT_DECAY_SECONDS = 0;
const DEFAULT_CAD_TOP_TOLERANCE_M = 0.08;
type Notice = { kind: "success" | "error" | "info"; message: string };
const mediaPanelsVisibleByDefault = () => !window.matchMedia("(max-width: 760px)").matches;

const createEmptyCloud = (): PointCloudData => ({
  id: "empty",
  frameId: "map",
  stampNs: 0n,
  positions: new Float32Array(),
  colors: new Uint8Array(),
  visible: new Uint8Array(),
});

const newProject = (profile: DeviceProfile): ProjectManifest => ({
  formatVersion: 1,
  id: crypto.randomUUID(),
  name: `手持采集 ${new Date().toLocaleDateString("zh-CN")}`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deviceProfile: profile,
  crs: "LOCAL_ENU",
  sourceFiles: [],
  edits: [],
});

function operation(kind: EditOperation["kind"], indices: number[], payload?: EditOperation["payload"]): EditOperation {
  return { id: crypto.randomUUID(), kind, indices, payload, createdAt: new Date().toISOString() };
}

export default function App() {
  const [lightMode, setLightMode] = useState(() => {
    try { return localStorage.getItem("point-view-theme") === "light"; } catch { return false; }
  });
  useEffect(() => {
    const theme = lightMode ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("point-view-theme", theme); } catch { /* 存储不可用时仍允许切换。 */ }
  }, [lightMode]);
  const [workspaceEntered, setWorkspaceEntered] = useState(false);
  const [profile, setProfile] = useState<DeviceProfile>(DEFAULT_DEVICE_PROFILE);
  const [project, setProject] = useState(() => newProject(DEFAULT_DEVICE_PROFILE));
  const [baseCloud, setBaseCloud] = useState<PointCloudData>(createEmptyCloud);
  const [edits, setEdits] = useState<EditOperation[]>([]);
  const cloud = useMemo(() => edits.reduce(applyEdit, baseCloud), [baseCloud, edits]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionEnabled, setSelectionEnabled] = useState(false);
  const [moveEnabled, setMoveEnabled] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>(DEFAULT_COLOR_MODE);
  const [pointSize, setPointSize] = useState(0);
  const [decaySeconds, setDecaySeconds] = useState(DEFAULT_DECAY_SECONDS);
  const [showReferenceGuides, setShowReferenceGuides] = useState(true);
  const [resetToken, setResetToken] = useState(0);
  const [sourceState, setSourceState] = useState<SourceState>("idle");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [imageUrls, setImageUrls] = useState<Partial<Record<CameraDirection, string>>>({});
  const [position, setPosition] = useState<GeoPosition>();
  const [syncStatus, setSyncStatus] = useState("等待");
  const [stats, setStats] = useState({ fps: 0, visible: pointCount(baseCloud) });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [savedProjects, setSavedProjects] = useState<ProjectManifest[]>([]);
  const [activeCamera, setActiveCamera] = useState<CameraDirection>("front");
  const [cameraFull, setCameraFull] = useState<CameraDirection>();
  const [recording, setRecording] = useState(false);
  const [recordStartedAt, setRecordStartedAt] = useState<number>();
  const [mapReady, setMapReady] = useState(false);
  const [elapsed, setElapsed] = useState("00:00:00");
  const [cameraPanelVisible, setCameraPanelVisible] = useState(mediaPanelsVisibleByDefault);
  const [mapPanelVisible, setMapPanelVisible] = useState(mediaPanelsVisibleByDefault);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<"import" | "save" | "export">();
  const [notice, setNotice] = useState<Notice>();
  const [qualityOpen, setQualityOpen] = useState(false);
  const [cadOpen, setCadOpen] = useState(false);
  const creationExit = useRef<(() => Promise<boolean>) | undefined>(undefined);
  const [creationContext, setCreationContext] = useState<CreationContext>();
  const originalSourceRef = useRef<{ id: string; name: string; blob: Blob } | undefined>(undefined);
  const [cadProjection, setCadProjection] = useState<CadProjection>("xy");
  const cadTopTolerance = DEFAULT_CAD_TOP_TOLERANCE_M;
  const [cadSettings, setCadSettings] = useState<CadDrawingSettings>(DEFAULT_CAD_DRAWING_SETTINGS);
  const [cadAnnotations, setCadAnnotations] = useState<CadAnnotation[]>([]);
  const [cadWorkflow, setCadWorkflow] = useState<CadWorkflowView>({ status: "idle" });
  const [cadSource, setCadSource] = useState<CadPreviewSource>();
  const cadSourceSelectionRef = useRef(selected);
  const [cadMobileView, setCadMobileView] = useState<"cloud" | "cad">("cad");
  const [qualityAnalyzing, setQualityAnalyzing] = useState(false);
  const [qualityError, setQualityError] = useState<string>();
  const [qualityEvidence, setQualityEvidence] = useState<StaticQualityEvidence>();
  const [qualityProfileId, setQualityProfileId] = useState<QualityProfileId>("metric-map");
  const sourceRef = useRef<FoxgloveSource | undefined>(undefined);
  const pendingLiveRefreshRef = useRef<number | undefined>(undefined);
  const recorderRef = useRef<LiveMcapRecorder | undefined>(undefined);
  const qualityWorkerRef = useRef<Worker | undefined>(undefined);
  const qualityRequestRef = useRef(0);
  const knownChannelsRef = useRef<Channel[]>([]);
  const decaySecondsRef = useRef(0);
  const decayFramesRef = useRef<TimedPointCloud[]>([]);
  const latestCloudFramesRef = useRef<Partial<Record<PointCloudStream, TimedPointCloud>>>({});
  const lastLiveFrameRef = useRef<TimedPointCloud | undefined>(undefined);
  const displayedLiveFrameRef = useRef<{ display: PointCloudData; frame: PointCloudData } | undefined>(undefined);
  const decayPointBudgetRef = useRef(window.matchMedia("(max-width: 700px)").matches ? 1_000_000 : 4_000_000);
  const selectionEnabledRef = useRef(false);
  const cadTaskRef = useRef(0);
  const qualityReport = useMemo(
    () => qualityEvidence ? buildQualityReport(qualityEvidence, qualityProfileId) : undefined,
    [qualityEvidence, qualityProfileId],
  );
  const cadIndices = useMemo(() => {
    // 这里只保留用户手动选中的索引；连通块/孤立点过滤延迟到显式 CAD 导出，
    // 避免导入大点云时在 React 渲染阶段扫描整份数据导致黑屏。
    if (!cadOpen || cloud.positions.length === 0 || selected.size === 0) return undefined;
    return [...selected].filter((index) => Boolean(cloud.visible[index]));
  }, [cadOpen, cloud, selected]);
  const cadSummary = useMemo(
    () => cadOpen ? computeCadSummary(cloud, cadProjection, cadIndices) : undefined,
    [cadOpen, cloud, cadProjection, cadIndices],
  );
  const cadSourceCurrent = Boolean(cadSource && cadSource.cloud === cloud && cadSourceSelectionRef.current === selected && cadSource.drawingId === cadWorkflow.model?.drawingId);
  const cadStale = Boolean(cadWorkflow.model && (!cadSourceCurrent || (cadWorkflow.status === "preview-ready" && cadWorkflow.stale)));
  const cadLink = useCadLinking(cadSource, cadWorkflow.model, cadOpen && !cadStale && cadWorkflow.status !== "preparing" && cadWorkflow.status !== "exporting" && cadWorkflow.status !== "error");

  useEffect(() => {
    if (pointCount(baseCloud) > 0) setWorkspaceEntered(true);
  }, [baseCloud]);

  useEffect(() => {
    if (!recordStartedAt) { setElapsed("00:00:00"); return; }
    const update = () => {
      const seconds = Math.floor((Date.now() - recordStartedAt) / 1_000);
      setElapsed([Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((v) => String(v).padStart(2, "0")).join(":"));
    };
    update(); const timer = window.setInterval(update, 1_000); return () => clearInterval(timer);
  }, [recordStartedAt]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (creationContext) return; // 制作台负责保存草稿后处理 Escape。
      if (cameraFull) setCameraFull(undefined);
      else if (exportMenuOpen) setExportMenuOpen(false);
      else if (cadOpen && cadLink.hasSelection) cadLink.clear();
      else if (settingsOpen || projectsOpen || qualityOpen || cadOpen) {
        setSettingsOpen(false); setProjectsOpen(false); setQualityOpen(false); setCadOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [creationContext, cameraFull, exportMenuOpen, settingsOpen, projectsOpen, qualityOpen, cadOpen, cadLink.hasSelection, cadLink.clear]);

  useEffect(() => () => {
    sourceRef.current?.disconnect();
    if (pendingLiveRefreshRef.current !== undefined) window.clearTimeout(pendingLiveRefreshRef.current);
    cadTaskRef.current += 1;
  }, []);
  useEffect(() => {
    decaySecondsRef.current = decaySeconds;
    const latest = lastLiveFrameRef.current;
    if (decaySeconds === 0) {
      decayFramesRef.current = Object.values(latestCloudFramesRef.current);
      if (latest && !selectionEnabledRef.current) {
        displayedLiveFrameRef.current = { display: latest.cloud, frame: latest.cloud };
        setBaseCloud(latest.cloud);
      }
      return;
    }

    if (latest && decayFramesRef.current.length === 0) {
      decayFramesRef.current = Object.values(latestCloudFramesRef.current);
    }
    const refresh = () => {
      const before = decayFramesRef.current;
      const after = pruneDecayFrames(before, Date.now(), decaySeconds * 1_000, decayPointBudgetRef.current);
      if (after.length === before.length) return;
      decayFramesRef.current = after;
      if (!selectionEnabledRef.current) {
        const display = mergeCommonFrameClouds(after);
        const currentFrame = lastLiveFrameRef.current;
        displayedLiveFrameRef.current = currentFrame ? { display, frame: currentFrame.cloud } : undefined;
        setBaseCloud(display);
        setSelected(new Set());
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 250);
    return () => window.clearInterval(timer);
  }, [decaySeconds]);
  useEffect(() => {
    const worker = new Worker(new URL("./workers/quality.worker.ts", import.meta.url), { type: "module" });
    qualityWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent<{ requestId: number; evidence?: StaticQualityEvidence; error?: string }>) => {
      if (event.data.requestId !== qualityRequestRef.current) return;
      setQualityAnalyzing(false);
      if (event.data.error || !event.data.evidence) {
        setQualityEvidence(undefined);
        setQualityError(event.data.error ?? "质量分析未返回结果");
        setNotice({ kind: "error", message: `PCD 质量分析失败：${event.data.error ?? "未知错误"}` });
        return;
      }
      setQualityError(undefined);
      setQualityEvidence(event.data.evidence);
      setNotice({ kind: "success", message: "PCD 质量分析完成，可在“质量评估”中查看" });
    };
    worker.onerror = (event) => {
      setQualityAnalyzing(false);
      setQualityError(event.message || "质量分析 Worker 异常");
    };
    return () => {
      worker.terminate();
      if (qualityWorkerRef.current === worker) qualityWorkerRef.current = undefined;
    };
  }, []);
  useEffect(() => {
    selectionEnabledRef.current = selectionEnabled;
    if (selectionEnabled) return;
    const latest = lastLiveFrameRef.current;
    if (!latest) return;
    const display = decaySecondsRef.current > 0 ? mergeCommonFrameClouds(decayFramesRef.current) : latest.cloud;
    displayedLiveFrameRef.current = { display, frame: latest.cloud };
    setBaseCloud(display);
    setEdits([]);
    setSelected(new Set());
  }, [selectionEnabled]);
  useEffect(() => {
    const timer = window.setTimeout(() => setMapReady(true), 1_200);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    if (notice.kind === "error") return;
    const timer = window.setTimeout(() => setNotice(undefined), 3_200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const connect = () => {
    setWorkspaceEntered(true);
    sourceRef.current?.disconnect();
    if (pendingLiveRefreshRef.current !== undefined) window.clearTimeout(pendingLiveRefreshRef.current);
    pendingLiveRefreshRef.current = undefined;
    setImageUrls({});
    setSyncStatus("等待");
    latestCloudFramesRef.current = {};
    decayFramesRef.current = [];
    lastLiveFrameRef.current = undefined;
    const source = new FoxgloveSource(profile, {
      onState: setSourceState,
      onPointCloud: (direction, next) => {
        const now = Date.now();
        latestCloudFramesRef.current[direction] = { receivedAt: now, cloud: next };
        if (pendingLiveRefreshRef.current !== undefined) return;

        // 三路点云合计约 30 条消息/秒；按 10 Hz 合并最新三路，避免每条消息都
        // 复制历史窗口并重建 GPU Buffer，同时保留足够流畅的实时响应。
        pendingLiveRefreshRef.current = window.setTimeout(() => {
          pendingLiveRefreshRef.current = undefined;
          try {
            const receivedAt = Date.now();
            const latestFrames = pointCloudTopicEntries(profile).flatMap(([stream]) => {
              const latest = latestCloudFramesRef.current[stream];
              return latest ? [latest] : [];
            });
            const latestCloud = mergeCommonFrameClouds(latestFrames);
            const combinedFrame = { receivedAt, cloud: latestCloud };
            lastLiveFrameRef.current = combinedFrame;
            let displayCloud = latestCloud;
            if (decaySecondsRef.current > 0) {
              const frames = pruneDecayFrames(
                [...decayFramesRef.current, combinedFrame],
                receivedAt,
                decaySecondsRef.current * 1_000,
                decayPointBudgetRef.current,
              );
              decayFramesRef.current = frames;
              displayCloud = mergeCommonFrameClouds(frames);
            } else {
              decayFramesRef.current = [combinedFrame];
            }
            if (!selectionEnabledRef.current) {
              displayedLiveFrameRef.current = { display: displayCloud, frame: latestCloud };
              setBaseCloud(displayCloud);
              setEdits((current) => current.length ? [] : current);
              setSelected((current) => current.size ? new Set() : current);
            }
          } catch {
            setSourceState("error");
          }
        }, LIVE_CLOUD_REFRESH_MS);
      },
      onImageUrl: (direction, url) => setImageUrls((current) => ({ ...current, [direction]: url })),
      onPosition: setPosition,
      onSyncStatus: setSyncStatus,
      onChannels: (next) => { setChannels(next); knownChannelsRef.current = next; },
      onRawChannel: (channel) => recorderRef.current?.addChannel(channel),
      onRawMessage: (channel, timestamp, data) => recorderRef.current?.addMessage(channel, timestamp, data),
    }, activeCamera);
    sourceRef.current = source; source.connect();
  };

  const disconnect = () => {
    sourceRef.current?.disconnect();
    if (pendingLiveRefreshRef.current !== undefined) window.clearTimeout(pendingLiveRefreshRef.current);
    pendingLiveRefreshRef.current = undefined;
    latestCloudFramesRef.current = {};
    decayFramesRef.current = [];
    lastLiveFrameRef.current = undefined;
    setImageUrls({}); setSyncStatus("等待"); setSourceState("idle");
  };

  const refreshPointCloud = () => {
    // 保持 Foxglove 连接，只丢弃点击前已经累计或等待合并的点云帧。
    // 下一条实时消息会从空窗口重新开始，避免旧颜色继续残留在 Decay 缓存中。
    if (pendingLiveRefreshRef.current !== undefined) {
      window.clearTimeout(pendingLiveRefreshRef.current);
      pendingLiveRefreshRef.current = undefined;
    }
    latestCloudFramesRef.current = {};
    decayFramesRef.current = [];
    lastLiveFrameRef.current = undefined;
    selectionEnabledRef.current = false;
    setBaseCloud(createEmptyCloud());
    setEdits([]);
    setSelected(new Set());
    setSelectionEnabled(false);
    setMoveEnabled(false);
    setQualityEvidence(undefined);
    setQualityError(undefined);
    setStats((current) => ({ ...current, visible: 0 }));
    setResetToken((value) => value + 1);
    setNotice({ kind: "success", message: "点云缓存已清空，等待下一帧" });
  };

  const togglePointCloudStream = (stream: PointCloudStream, enabled: boolean) => {
    setProfile((current) => {
      const selected = current.pointCloudSelection ?? ["merged"];
      let next: PointCloudStream[];
      if (stream === "merged") {
        next = enabled ? ["merged"] : [];
      } else {
        const independent = selected.filter((item) => item !== "merged" && item !== stream);
        next = enabled ? [...independent, stream] : independent;
      }
      return { ...current, pointCloudSelection: next };
    });
  };

  const selectCamera = (direction: CameraDirection) => {
    setActiveCamera(direction);
    setCameraFull(undefined);
    setImageUrls((current) => ({ ...current, [direction]: undefined }));
    sourceRef.current?.setActiveCamera(direction);
  };

  const selectNextCamera = () => {
    const currentIndex = CAMERA_DIRECTIONS.indexOf(activeCamera);
    selectCamera(CAMERA_DIRECTIONS[(currentIndex + 1) % CAMERA_DIRECTIONS.length]!);
  };

  const appendEdit = (edit: EditOperation) => {
    setEdits((current) => [...current, edit]);
    setProject((current) => ({ ...current, edits: [...current.edits, edit] }));
    setSelected(new Set());
  };

  const togglePoint = (index: number) => {
    const next = new Set(selected);
    const x = cloud.positions[index * 3]!, y = cloud.positions[index * 3 + 1]!, z = cloud.positions[index * 3 + 2]!;
    // 点击选中一个小邻域，触屏上无需精确命中单个像素点。
    for (let i = 0; i < cloud.visible.length; i++) {
      if (!cloud.visible[i]) continue;
      const d = Math.hypot(cloud.positions[i * 3]! - x, cloud.positions[i * 3 + 1]! - y, cloud.positions[i * 3 + 2]! - z);
      if (d < 0.22) next.add(i);
    }
    setSelected(next);
  };

  const importCloud = async () => {
    try {
      const file = await openPointCloudFile();
      if (!file) return;
      setBusyAction("import");
      const lower = file.name.toLowerCase();
      const next = lower.endsWith(".pcd") ? parsePcd(file.data, undefined, { maxPoints: pointCloudImportLimit() })
        : lower.endsWith(".ply") ? parsePly(file.data)
        : lower.endsWith(".las") || lower.endsWith(".laz") ? await parseLasOrLaz(file.data)
        : lower.endsWith(".mcap") ? await loadMcapPointCloud(file.data, pointCloudTopicEntries(profile)[0]?.[1] ?? profile.topics.pointCloud)
        : undefined;
      if (!next) throw new Error("不支持该文件格式");
      const sampled = next.sourcePointCount && next.sourcePointCount > pointCount(next)
        ? ` · 显示 ${pointCount(next).toLocaleString()}/${next.sourcePointCount.toLocaleString()} 点`
        : "";
      originalSourceRef.current = lower.endsWith(".pcd") ? { id: next.id, name: file.name, blob: new Blob([file.data]) } : undefined;
      // 新导入从零值开始，丢弃旧的轨迹缓存和等待合并的帧。
      if (pendingLiveRefreshRef.current !== undefined) window.clearTimeout(pendingLiveRefreshRef.current);
      pendingLiveRefreshRef.current = undefined;
      latestCloudFramesRef.current = {};
      decayFramesRef.current = [];
      lastLiveFrameRef.current = undefined;
      displayedLiveFrameRef.current = undefined;
      decaySecondsRef.current = 0;
      setPointSize(0); setDecaySeconds(0);
      setBaseCloud(next); setEdits([]); setSelected(new Set());
      setProject((current) => ({ ...current, sourceFiles: [...current.sourceFiles, file.name] }));
      if (lower.endsWith(".pcd")) {
        const requestId = ++qualityRequestRef.current;
        setQualityEvidence(undefined); setQualityError(undefined); setQualityAnalyzing(true);
        const sample = createStableQualitySample(next);
        const transfers: Transferable[] = [sample.positions.buffer, sample.colors.buffer, sample.visible.buffer];
        if (sample.intensities) transfers.push(sample.intensities.buffer);
        qualityWorkerRef.current?.postMessage({ requestId, fileName: file.name, cloud: sample }, transfers);
        setNotice({ kind: "info", message: `已导入 ${file.name}${sampled}，正在检查质量` });
      } else {
        qualityRequestRef.current++;
        setQualityEvidence(undefined); setQualityAnalyzing(false);
        setQualityError("首版静态质量分析仅支持 .pcd；当前文件仍可正常查看和编辑");
        setNotice({ kind: "success", message: `已导入 ${file.name}` });
      }
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const exportCloud = async (format: "ply" | "pcd" | "las" | "mcap") => {
    setBusyAction("export");
    try {
      const safe = project.name.replace(/[\\/:*?"<>|]/g, "_");
      let saved = false;
      if (format === "ply") saved = await saveBinaryFile(`${safe}.ply`, exportPly(cloud));
      if (format === "pcd") saved = await saveBinaryFile(`${safe}.pcd`, exportPcd(cloud));
      if (format === "las") saved = await saveBinaryFile(`${safe}.las`, exportLas(cloud));
      if (format === "mcap") saved = await saveBinaryFile(`${safe}.mcap`, await exportPointCloudMcap(cloud));
      setNotice(saved
        ? { kind: "success", message: `已导出 ${format.toUpperCase()} 点云` }
        : { kind: "info", message: `已取消导出 ${format.toUpperCase()}` });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const export3dgs = async () => {
    setBusyAction("export");
    try {
      const files = await openColmapDirectory();
      if (!files) return;
      const safe = project.name.replace(/[\\/:*?"<>|]/g, "_");
      const saved = await saveBinaryFile(`${safe}-3dgs.zip`, exportThreeDgsDataset(cloud, project, files), "application/zip");
      setNotice(saved
        ? { kind: "success", message: "已导出 3DGS 数据包" }
        : { kind: "info", message: "已取消导出 3DGS" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const toggleRecording = async () => {
    try {
      if (!recording) {
        if (sourceState !== "connected" || knownChannelsRef.current.length === 0) {
          setNotice({ kind: "info", message: "设备数据尚未就绪，请稍后重试" });
          return;
        }
        const recorder = new LiveMcapRecorder();
        knownChannelsRef.current.forEach((channel) => recorder.addChannel(channel));
        recorderRef.current = recorder; setRecording(true); setRecordStartedAt(Date.now());
        setNotice({ kind: "success", message: "已开始录制原始 MCAP 数据" });
        return;
      }
      setRecording(false); setRecordStartedAt(undefined);
      const recorder = recorderRef.current; recorderRef.current = undefined;
      if (!recorder) return;
      const saved = await saveBinaryFile(`point-view-${new Date().toISOString().replace(/[:.]/g, "-")}.mcap`, await recorder.finish());
      setNotice(saved
        ? { kind: "success", message: "录制已停止，MCAP 文件已保存" }
        : { kind: "info", message: "录制已停止，文件保存已取消" });
    } catch (error) {
      setRecording(false); setRecordStartedAt(undefined); recorderRef.current = undefined;
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const saveCurrentProject = async () => {
    setBusyAction("save");
    try {
      const updated = { ...project, deviceProfile: profile, edits, updatedAt: new Date().toISOString() };
      await Promise.all([saveProject(updated), saveProjectCloud(updated.id, baseCloud)]);
      setProject(updated); setNotice({ kind: "success", message: "当前工程和点云快照已保存" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const exportQualityReport = async () => {
    if (!qualityReport) return;
    try {
      const safe = qualityReport.source.fileName.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_");
      const saved = await saveTextFile(`${safe}-quality-report.json`, JSON.stringify(qualityReport, null, 2));
      setNotice(saved
        ? { kind: "success", message: "质量报告 JSON 已导出" }
        : { kind: "info", message: "已取消导出质量报告" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const invalidateCadPreview = () => {
    setCadWorkflow((current) => {
      if (current.status === "preview-ready") return { ...current, stale: true };
      if (current.status === "completed") return { status: "preview-ready", model: current.model, stale: true };
      if (current.status === "error" && current.model) return { status: "preview-ready", model: current.model, stale: true };
      return current;
    });
  };

  const updateCadProjection = (projection: CadProjection) => {
    setCadProjection(projection);
    setCadSource(undefined);
    invalidateCadPreview();
  };

  const updateCadSettings = (settings: CadDrawingSettings) => {
    setCadSettings(settings);
    setCadSource(undefined);
    invalidateCadPreview();
  };

  const updateCadAnnotations = (annotations: CadAnnotation[]) => {
    setCadAnnotations(annotations);
    setCadWorkflow((current) => {
      if (!current.model) return current;
      const model = applyCadAnnotations(current.model, annotations);
      if (current.status === "completed" || current.status === "cancelled") {
        return { status: "preview-ready", model, stale: false };
      }
      return { ...current, model };
    });
  };

  const prepareCadPreview = () => {
    if (!cadSummary) return;
    setNotice(undefined);
    const taskId = ++cadTaskRef.current;
    const previousModel = cadWorkflow.model;
    setCadWorkflow({ status: "preparing", progress: 0.15, stage: "正在整理点云证据", model: previousModel });
    window.setTimeout(() => {
      if (taskId !== cadTaskRef.current) return;
      try {
        setCadWorkflow({ status: "preparing", progress: 0.55, stage: "正在生成空间图纸", model: previousModel });
        const generatedAt = new Date().toISOString();
        const model = buildDrawingModel({
          cloud,
          projection: cadProjection,
          indices: cadIndices,
          annotations: cadAnnotations,
          settings: cadSettings,
          topPlaneToleranceM: cadTopTolerance,
          sourceProjectId: project.id,
          sourceName: project.sourceFiles.at(-1) ?? project.name,
          sourceCoordinateSystem: project.crs,
          drawingId: `PV-${generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`,
          generatedAt,
          softwareVersion: "Point View 0.1.6",
          onPreviewSource: (source) => { cadSourceSelectionRef.current = selected; setCadSource(source); },
        });
        if (taskId !== cadTaskRef.current) return;
        setCadWorkflow({ status: "preview-ready", model, stale: false });
      } catch (error) {
        if (taskId !== cadTaskRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setCadWorkflow({ status: "error", error: message, model: previousModel });
        setNotice({ kind: "error", message });
      }
    }, 0);
  };

  const cancelCadTask = () => {
    cadTaskRef.current += 1;
    setCadWorkflow((current) => ({ status: "cancelled", model: current.model }));
    setNotice({ kind: "info", message: "已取消当前 CAD 任务" });
  };

  const exportStandardCad = async () => {
    const sourceModel = cadWorkflow.model;
    if (!sourceModel || cadStale) return;
    const model = applyCadAnnotations(sourceModel, cadAnnotations);
    const taskId = ++cadTaskRef.current;
    try {
      setCadWorkflow({ status: "exporting", progress: 0.25, stage: "正在校验并打包标准成果", model });
      const safe = project.name.replace(/[\\/:*?"<>|]/g, "_");
      const delivery = await createCadDelivery(model, `${safe}-cad-${cadProjection}`);
      if (taskId !== cadTaskRef.current) return;
      const saved = await saveBinaryFile(delivery.archiveName, delivery.archive, "application/zip");
      if (taskId !== cadTaskRef.current) return;
      if (!saved) {
        setCadWorkflow({ status: "preview-ready", model, stale: false });
        setNotice({ kind: "info", message: "已取消保存标准 CAD 成果包" });
        return;
      }
      setCadWorkflow({ status: "completed", model, files: delivery.files });
      setNotice({ kind: "success", message: "标准 CAD 成果包已导出（DXF + annotations + manifest）" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCadWorkflow({ status: "error", error: message, model });
      setNotice({ kind: "error", message });
    }
  };

  const removeCeiling = (tolerance: number) => {
    const result = findTopPlaneIndices(cloud, tolerance);
    if (!result || result.indices.length === 0) {
      setNotice({ kind: "info", message: "未找到可剔除的顶部平面" });
      return;
    }
    appendEdit(operation("hide", result.indices));
    invalidateCadPreview();
    setNotice({ kind: "success", message: `已隐藏顶部候选 ${result.indices.length.toLocaleString()} 点，可用撤销恢复` });
  };

  const openProjects = async () => {
    try {
      setSavedProjects(await listProjects()); setProjectsOpen(true); setSettingsOpen(false); setQualityOpen(false); setCadOpen(false);
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const restoreProject = async (manifest: ProjectManifest) => {
    const storedCloud = await loadProjectCloud(manifest.id);
    if (!storedCloud) { setSourceState("error"); setNotice({ kind: "error", message: "工程数据不完整，请重新导入点云" }); return; }
    setProject(manifest); setProfile(manifest.deviceProfile); setBaseCloud(storedCloud);
    setEdits(manifest.edits); setSelected(new Set()); setProjectsOpen(false);
    setNotice({ kind: "success", message: `已打开 ${manifest.name}` });
  };

  const hideSelected = () => selected.size && appendEdit(operation("hide", [...selected]));
  const cropSelected = () => selected.size && appendEdit(operation("hide", visibleIndices(cloud).filter((index) => !selected.has(index))));
  const toggleMoveMode = () => {
    if (!selected.size) return;
    setMoveEnabled((current) => {
      const next = !current;
      if (next) setSelectionEnabled(false);
      return next;
    });
  };
  const moveSelected = (delta: [number, number, number]) => {
    if (!selected.size) return;
    appendEdit(operation("transform", [...selected], { matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, delta[0],delta[1],delta[2],1] }));
    setMoveEnabled(false);
  };
  const boostSelected = () => selected.size && appendEdit(operation("color-gain", [...selected], { gain: [1.08, 1.08, 1.08] }));

  const showCameraPanel = () => {
    const next = !cameraPanelVisible;
    setCameraPanelVisible(next);
    if (next && window.matchMedia("(max-width: 760px)").matches) setMapPanelVisible(false);
  };
  const showMapPanel = () => {
    const next = !mapPanelVisible;
    setMapPanelVisible(next);
    if (next && window.matchMedia("(max-width: 760px)").matches) setCameraPanelVisible(false);
  };
  const openWorkbench = async () => {
    if (creationContext && creationExit.current && !(await creationExit.current())) return;
    setWorkspaceEntered(true);
    setCreationContext(undefined);
    setSettingsOpen(false); setProjectsOpen(false); setQualityOpen(false); setCadOpen(false);
  };

  const openCreation = () => {
    if (creationContext) return;
    setPointSize(0); setDecaySeconds(0);
    decaySecondsRef.current = 0;
    // 实时创作取当前帧，不把显示用的历史拖影写入作品；已有编辑保留其快照。
    const live = displayedLiveFrameRef.current;
    const creationCloud = live?.display === baseCloud && edits.length === 0 ? live.frame : cloud;
    const source = originalSourceRef.current?.id === creationCloud.id ? originalSourceRef.current : undefined;
    setCreationContext({ cloud: creationCloud, sourceName: source?.name ?? project.sourceFiles.at(-1) ?? project.name, sourceBlob: source?.blob, edits });
    setWorkspaceEntered(true); setCadOpen(false); setQualityOpen(false); setProjectsOpen(false); setSettingsOpen(false);
  };
  useEffect(() => { if (creationContext && (cadOpen || qualityOpen || projectsOpen || settingsOpen || !workspaceEntered)) {
    void (creationExit.current?.() ?? Promise.resolve(true)).then(ready => { if (ready) setCreationContext(undefined); });
  } }, [cadOpen, qualityOpen, projectsOpen, settingsOpen, workspaceEntered]);

  const connectionCopy = sourceState === "connected"
    ? { state: "设备在线", detail: "实时数据" }
    : sourceState === "connecting"
      ? { state: "正在连接", detail: "请稍候" }
      : sourceState === "error"
        ? { state: "连接异常", detail: "检查设备或网络" }
        : pointCount(baseCloud)
          ? { state: "本地模式", detail: "点云已载入" }
          : { state: "离线模式", detail: "可连接或导入" };
  const pointSizeCopy = pointSize === 0 ? "0" : pointSize < 0.03 ? "细" : pointSize < 0.06 ? "标准" : "粗";
  const trailCopy = decaySeconds === 0 ? "0" : decaySeconds <= 5 ? "短" : decaySeconds <= 20 ? "中" : "长";

  return <main className={`app-shell ${workspaceEntered ? "is-workbench" : "is-overview"} ${creationContext ? "creation-open" : ""} ${cadOpen ? `cad-open cad-mobile-${cadMobileView}` : ""}`}>
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
        <div><strong>POINT VIEW</strong><small>观曜 · 空间数据工作室</small></div>
      </div>
      <div className="project-context" title={project.name}><small>当前工程</small><strong>{project.name}</strong></div>
      <nav className="mode-tabs" aria-label="工作区导航">
        <button className={!workspaceEntered && !creationContext && !settingsOpen && !projectsOpen && !qualityOpen && !cadOpen ? "active" : ""} onClick={() => { setWorkspaceEntered(false); setSettingsOpen(false); setProjectsOpen(false); setQualityOpen(false); setCadOpen(false); }}>概览</button>
        <button className={workspaceEntered && !creationContext && !settingsOpen && !projectsOpen && !qualityOpen && !cadOpen ? "active" : ""} onClick={openWorkbench}>工作台</button>
        <button className={projectsOpen ? "active" : ""} onClick={openProjects}>工程</button>
        <button className={qualityOpen ? "active" : ""} onClick={() => { setQualityOpen(true); setSettingsOpen(false); setProjectsOpen(false); setCadOpen(false); }}>检查</button>
        <button className={cadOpen ? "active" : ""} onClick={() => { setWorkspaceEntered(true); setCadOpen(true); setCadMobileView("cad"); setSettingsOpen(false); setProjectsOpen(false); setQualityOpen(false); }}>图纸</button>
        <button className={creationContext ? "active" : ""} onClick={openCreation}>创作</button>
      </nav>
      <div className="connection">
        <span className={`connection-dot ${sourceState}`} />
        <div><small>{connectionCopy.state}</small><strong>{connectionCopy.detail}</strong></div>
        <button className="icon-button theme-toggle" aria-label={lightMode ? "切换深色模式" : "切换浅色模式"} title={lightMode ? "切换深色模式" : "切换浅色模式（纯白背景）"} onClick={() => setLightMode(current => !current)}>{lightMode ? <Moon size={19} /> : <Sun size={19} />}</button>
        {sourceState === "connected" ? <button className="connection-button" onClick={disconnect}><PlugZap size={16} />断开</button> : <button className="connection-button primary" onClick={connect}><PlugZap size={16} />连接</button>}
        <button className="icon-button" aria-label={settingsOpen ? "关闭采集配置" : "打开采集配置"} title={settingsOpen ? "关闭采集配置" : "打开采集配置"} onClick={() => { setSettingsOpen(!settingsOpen); setProjectsOpen(false); setQualityOpen(false); setCadOpen(false); }}><Settings size={19} /></button>
      </div>
    </header>

    {notice && <div className={`action-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-live="polite">
      <span>{notice.message}</span>
      <button aria-label="关闭提示" title="关闭提示" onClick={() => setNotice(undefined)}><X /></button>
    </div>}

    {settingsOpen && <section className="settings-drawer panel-glass">
      <header className="drawer-header"><div><strong>采集偏好</strong><small>选择工作区中显示的内容</small></div><button className="icon-button" aria-label="关闭采集偏好" title="关闭" onClick={() => setSettingsOpen(false)}><X /></button></header>
      <section className="settings-primary">
        <div className="settings-device-summary"><PlugZap /><span><strong>观曜 Omni</strong><small>连接后自动识别</small></span></div>
        <div className="cloud-stream-options">
          <span>显示点云</span>
          <fieldset aria-label="显示点云">
            {POINT_CLOUD_STREAMS.map((stream) => <label key={stream}>
              <input type="checkbox" checked={(profile.pointCloudSelection ?? ["merged"]).includes(stream)} onChange={(event) => togglePointCloudStream(stream, event.target.checked)} />
              {stream === "merged" ? "融合" : stream === "front" ? "前视" : stream === "left" ? "左视" : "右视"}
            </label>)}
          </fieldset>
        </div>
      </section>
      <footer className="drawer-footer"><span>设备参数由系统自动管理</span></footer>
    </section>}
    {projectsOpen && <section className="settings-drawer project-drawer panel-glass">
      <header className="drawer-header"><div><strong>本地工程</strong><small>继续最近的空间任务</small></div><button className="icon-button" aria-label="关闭工程" title="关闭工程" onClick={() => setProjectsOpen(false)}><X /></button></header>
      {savedProjects.length === 0 ? <div className="drawer-empty"><FolderOpen /><strong>还没有保存的工程</strong><span>可以先导入点云，完成检查后再保存工程快照。</span><button className="primary-button" onClick={() => { setProjectsOpen(false); void importCloud(); }}>导入</button></div> : savedProjects.map((item) => <button className="project-row" key={item.id} onClick={() => restoreProject(item)}><strong>{item.name}</strong><small>{new Date(item.updatedAt).toLocaleString("zh-CN")} · {item.sourceFiles.join(", ") || "实时采集点云"}</small></button>)}
    </section>}
    {creationContext && <Suspense fallback={<div className="action-notice" role="status">正在打开物体创作台…</div>}><ObjectStudio lightMode={lightMode} context={creationContext} registerExit={handler => { creationExit.current = handler; }} onClose={() => setCreationContext(undefined)} onImport={() => { setCreationContext(undefined); void importCloud(); }} /></Suspense>}
    {cadOpen && <div className="cad-mobile-switch" aria-label="空间与图纸切换"><button aria-pressed={cadMobileView === "cloud"} onClick={() => setCadMobileView("cloud")}>三维空间</button><button aria-pressed={cadMobileView === "cad"} onClick={() => setCadMobileView("cad")}>关联图纸</button></div>}
    {cadOpen && <CadPanel
      lightMode={lightMode}
      cloud={cloud}
      summary={cadSummary}
      projection={cadProjection}
      selectedCount={selected.size}
      topTolerance={cadTopTolerance}
      settings={cadSettings}
      annotations={cadAnnotations}
      workflow={cadWorkflow}
      sourceStale={cadStale}
      link={cadLink}
      onProjectionChange={updateCadProjection}
      onSettingsChange={updateCadSettings}
      onAnnotationsChange={updateCadAnnotations}
      onRemoveCeiling={removeCeiling}
      onPreparePreview={prepareCadPreview}
      onCancel={cancelCadTask}
      onExportStandardDrawing={exportStandardCad}
      onClose={() => setCadOpen(false)}
    />}
    {qualityOpen && <QualityPanel
      report={qualityReport}
      analyzing={qualityAnalyzing}
      error={qualityError}
      profileId={qualityProfileId}
      onProfileChange={setQualityProfileId}
      onExport={exportQualityReport}
      onReview={openWorkbench}
      onClose={() => setQualityOpen(false)}
    />}

    {!workspaceEntered && <SpatialWelcome importing={busyAction === "import"} busy={Boolean(busyAction)} onImport={importCloud} onConnect={connect} onEnter={openWorkbench} onProjects={openProjects} />}

    {workspaceEntered && <><aside className="tool-rail panel-glass" aria-label="点云编辑工具">
      <Tool icon={<RotateCcw />} label="刷新" disabled={!pointCount(cloud)} onClick={refreshPointCloud} />
      <Tool icon={<BoxSelect />} label="框选" active={selectionEnabled} disabled={!pointCount(cloud)} onClick={() => { setMoveEnabled(false); setSelectionEnabled(!selectionEnabled); }} />
      <Tool icon={<Crop />} label="裁剪" disabled={!selected.size} onClick={cropSelected} />
      <Tool icon={<Trash2 />} label="隐藏" disabled={!selected.size} onClick={hideSelected} />
      <Tool icon={<Move />} label="移动" active={moveEnabled} disabled={!selected.size} onClick={toggleMoveMode} />
      <Tool icon={<Palette />} label="提亮" disabled={!selected.size} onClick={boostSelected} />
      <Tool icon={<Undo2 />} label="撤销" disabled={!edits.length} onClick={() => setEdits((value) => value.slice(0, -1))} />
      <Tool icon={<CircleX />} label="清除" disabled={!selected.size} onClick={() => setSelected(new Set())} />
    </aside>

    <section className="workspace">
      <PointCloudCanvas lightMode={lightMode} active={!creationContext} cloud={cloud} colorMode={colorMode} pointSize={pointSize} selected={selected} selectionEnabled={!cadOpen && selectionEnabled} moveEnabled={!cadOpen && moveEnabled} inspection={cadOpen ? cadLink.cloud : undefined} focusRequest={cadLink.cloudFocus} showReferenceGuides={showReferenceGuides} resetToken={resetToken} onTogglePoint={togglePoint} onSelectPoints={(indices) => setSelected((current) => new Set([...current, ...indices]))} onMoveSelected={moveSelected} onStats={(fps, visible) => setStats({ fps, visible })} />
      {cadOpen && <div className="cad-cloud-toolbar"><span>三维空间</span><button onClick={() => setResetToken(value => value + 1)}><RotateCcw size={15} />查看全貌</button></div>}
      <div className="workspace-caption"><span>{sourceState === "connected" ? "LIVE / 实时空间" : "PROJECT / 当前工程"}</span><strong title={project.name}>{project.name}</strong></div>
      {!pointCount(cloud) && <div className="workspace-empty">
        <span className="workspace-eyebrow">POINT VIEW / WORKSPACE</span>
        <strong>你的下一处空间，从这里开始。</strong>
        <p>连接 omni 实时查看彩色点云，或导入 PCD、PLY、LAS、LAZ、MCAP 文件。</p>
        <div><button className="primary-button" onClick={connect}><PlugZap />连接</button><button className="secondary-button" aria-busy={busyAction === "import"} disabled={Boolean(busyAction)} onClick={importCloud}>{busyAction === "import" ? <LoaderCircle className="button-spinner" /> : <FolderOpen />}{busyAction === "import" ? "导入中" : "导入"}</button></div>
      </div>}
      <div className="cloud-hud panel-glass"><span><Gauge />{stats.fps} FPS</span><span><Layers3 />{stats.visible.toLocaleString()}{stats.visible !== pointCount(cloud) ? ` / ${pointCount(cloud).toLocaleString()}` : ""} 点</span><span><BoxSelect />已选 {selected.size}</span></div>
      <div className="view-controls panel-glass">
        <label className="view-select"><Palette /><span>颜色</span><select aria-label="点云颜色模式" value={colorMode} onChange={(e) => setColorMode(e.target.value as ColorMode)}><option value="rgb">真彩 RGB</option><option value="height">高度伪彩</option><option value="intensity">强度</option><option value="distance">距离</option><option value="solid">单色</option></select><ChevronDown /></label>
        <label className="range-control" title="调整点云显示大小，0 为最细可见点"><Ruler /><span>大小</span><input aria-label="点云显示大小" type="range" min="0" max="0.12" step="0.005" value={pointSize} onChange={(e) => setPointSize(Number(e.target.value))} /><output>{pointSizeCopy}</output></label>
        <label className="range-control" title="调整点云轨迹保留秒数，0 为仅显示当前帧"><TimerReset /><span>轨迹</span><input aria-label="点云轨迹长度" type="range" min="0" max="100" step="1" value={decaySeconds} onChange={(e) => setDecaySeconds(Number(e.target.value))} /><output>{trailCopy}</output></label>
        <button className={`view-reference-toggle ${showReferenceGuides ? "" : "active"}`} aria-pressed={!showReferenceGuides} aria-label={showReferenceGuides ? "隐藏参考系" : "显示参考系"} title={showReferenceGuides ? "隐藏空间参考线" : "显示空间参考线"} onClick={() => setShowReferenceGuides((visible) => !visible)}>
          {showReferenceGuides ? <EyeOff size={15} /> : <Eye size={15} />}<span>参考系</span>
        </button>
      </div>
      <StatusCards
        position={position}
        cameraOnline={imageUrls[activeCamera] ? 1 : 0}
        cameraTotal={1}
        syncStatus={syncStatus}
        elapsed={elapsed}
      />
    </section>

    <section className={`bottom-dock ${cameraFull ? "camera-full" : ""}`}>
      <div className="panel-switcher" aria-label="辅助视图">
        <button className={cameraPanelVisible ? "active" : ""} aria-label="相机" aria-pressed={cameraPanelVisible} onClick={showCameraPanel}><Camera /><span>相机</span></button>
        <button className={mapPanelVisible ? "active" : ""} aria-label="地图" aria-pressed={mapPanelVisible} onClick={showMapPanel}><MapPinned /><span>地图</span></button>
      </div>
      {cameraPanelVisible ? <div className="camera-panel">
        <button className="panel-visibility-button" aria-label="隐藏相机" title="隐藏相机" onClick={showCameraPanel}><EyeOff /></button>
        <div className="camera-stage">
          <CameraView
            direction={activeCamera}
            imageUrl={imageUrls[activeCamera]}
            maximized={cameraFull === activeCamera}
            recording={recording}
            elapsed={elapsed}
            onCycle={selectNextCamera}
            onMaximize={() => setCameraFull((current) => current === activeCamera ? undefined : activeCamera)}
          />
        </div>
      </div> : <button className="panel-reveal-button reveal-camera" aria-label="显示相机" title="显示相机" onClick={showCameraPanel}><Eye /><span>相机</span></button>}
      <div className="action-dock-shell">
        {exportMenuOpen && <div className="export-popover panel-glass" role="menu" aria-label="导出成果">
          <header><div><strong>导出</strong></div><button className="icon-button" aria-label="关闭导出菜单" onClick={() => setExportMenuOpen(false)}><X /></button></header>
          <button role="menuitem" disabled={!pointCount(cloud) || Boolean(busyAction)} onClick={() => { setExportMenuOpen(false); void exportCloud("pcd"); }}><CloudDownload /><span><strong>PCD 点云</strong></span></button>
          <button role="menuitem" disabled={!pointCount(cloud) || Boolean(busyAction)} onClick={() => { setExportMenuOpen(false); void exportCloud("ply"); }}><FileDown /><span><strong>PLY 点云</strong></span></button>
          <button role="menuitem" disabled={!pointCount(cloud) || Boolean(busyAction)} onClick={() => { setExportMenuOpen(false); void exportCloud("las"); }}><FileOutput /><span><strong>LAS 点云</strong></span></button>
          <button role="menuitem" disabled={!pointCount(cloud) || Boolean(busyAction)} onClick={() => { setExportMenuOpen(false); void exportCloud("mcap"); }}><Database /><span><strong>MCAP</strong></span></button>
          <button role="menuitem" disabled={!pointCount(cloud) || Boolean(busyAction)} onClick={() => { setExportMenuOpen(false); void export3dgs(); }}><PackageCheck /><span><strong>3DGS</strong></span></button>
        </div>}
        <div className="action-dock panel-glass">
          <Action icon={busyAction === "import" ? <LoaderCircle className="button-spinner" /> : <FolderOpen />} label={busyAction === "import" ? "导入中" : "导入"} title="导入 PCD、PLY、LAS、LAZ 或 MCAP 点云" busy={busyAction === "import"} primary disabled={Boolean(busyAction && busyAction !== "import")} onClick={importCloud} />
          <Action icon={busyAction === "save" ? <LoaderCircle className="button-spinner" /> : <Save />} label={busyAction === "save" ? "保存中" : "保存"} title="保存当前配置、编辑记录和点云快照" busy={busyAction === "save"} disabled={Boolean(busyAction && busyAction !== "save")} onClick={saveCurrentProject} />
          <Action icon={recording ? <Square /> : <Circle />} label={recording ? "停止" : "录制"} title={recording ? "停止录制并保存原始 MCAP" : "连接设备后录制原始 MCAP 数据"} active={recording} recording={recording} disabled={Boolean(busyAction) || (!recording && (sourceState !== "connected" || channels.length === 0))} onClick={toggleRecording} />
          <Action icon={busyAction === "export" ? <LoaderCircle className="button-spinner" /> : <FileOutput />} label={busyAction === "export" ? "导出中" : "导出"} title="导出 PCD、PLY、LAS、MCAP 或 3DGS" active={exportMenuOpen} busy={busyAction === "export"} disabled={!pointCount(cloud) || Boolean(busyAction && busyAction !== "export")} onClick={() => setExportMenuOpen((open) => !open)} />
        </div>
      </div>
      {mapPanelVisible ? <div className="map-panel">
        <button className="panel-visibility-button" aria-label="隐藏地图" title="隐藏地图" onClick={showMapPanel}><EyeOff /></button>
        {mapReady ? <Suspense fallback={<div className="map-shell map-placeholder">地图加载中</div>}><RtkMap position={position} /></Suspense> : <div className="map-shell map-placeholder">准备 RTK 地图</div>}
      </div> : <button className="panel-reveal-button reveal-map" aria-label="显示地图" title="显示地图" onClick={showMapPanel}><Eye /><span>地图</span></button>}
    </section></>}
  </main>;
}

function Tool({ icon, label, active, disabled, onClick }: { icon: React.ReactNode; label: string; active?: boolean; disabled?: boolean; onClick(): void }) {
  return <button className={active ? "active" : ""} aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function Action({ icon, label, title, active, busy, recording, primary, disabled, onClick }: { icon: React.ReactNode; label: string; title: string; active?: boolean; busy?: boolean; recording?: boolean; primary?: boolean; disabled?: boolean; onClick(): void }) {
  const className = [active ? "active" : "", recording ? "recording" : "", primary ? "primary" : ""].filter(Boolean).join(" ");
  return <button className={className} title={title} aria-pressed={active} aria-busy={busy} disabled={disabled || busy} onClick={onClick}>{icon}<span>{label}</span></button>;
}
