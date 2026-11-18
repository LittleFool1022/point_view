import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Battery, BookOpen, Box, Camera, Check, ChevronRight, CircleHelp, Crosshair, Expand, FolderOpen, Gauge,
  HardDrive, LoaderCircle, Pause, Play, Plus, Radio, Save, Scan, Settings2, SlidersHorizontal, Search, Smartphone, Square, Timer,
  Trash2, Wifi, WifiOff, X,
} from "lucide-react";
import { PointCloudCanvas, type CloudFocusRequest } from "../components/PointCloudCanvas";
import { CAMERA_DIRECTIONS, CAMERA_DIRECTION_LABELS, DEFAULT_DEVICE_PROFILE, type CameraDirection, type ColorMode } from "../domain/types";
import { isLabMessage, postLabMessage } from "./preview/protocol";
import { controlUrlFromPreview, OmniControlClient, UNKNOWN_DEVICE_STATUS, updateScanPointTotal, type ScanPointTotal, type DeviceAction, type ScanProfile } from "./scanner/OmniControlClient";
import { OmniPreviewSession, persistPreviewConfig, previewFreshness, readPreviewConfig, validatePreviewConfig } from "./scanner/OmniPreviewSession";
import { PreviewDiscoveryBudget, previewDiscoveryKey, type IdentityConnectionResult } from "./scanner/PreviewDiscoveryBudget";
import { formatDate, formatDuration, type DemoProject } from "./demoData";
import { CloudConfigForm } from "./cloud/CloudUploadControls";
import { hasCloudReceipt, useCloudUpload } from "./cloud/useCloudUpload";
import { ProjectViewer } from "./projects/ProjectViewer";
import { listProjects, decodeProject, cacheProject, type DeviceProject } from "./projects/ProjectFiles";

const EMPTY_SELECTION = new Set<number>();
const noop = () => {};
const freshnessText = { waiting: "等待画面", live: "实时画面", stale: "画面未更新" };
const connectionHint = {
  offline: "连接 OMNI 网络后，即可查看设备画面与传感器数据",
  connecting: "正在连接设备，请稍候",
  connected: "已连接设备，可随时开始扫描",
  error: "请确认已连接 OMNI 网络，且设备预览已开启",
};

const PROFILE_KEY = "omni-scan-profile-v1";
const readScanProfile = (): ScanProfile => {
  try {
    const stored = localStorage.getItem(PROFILE_KEY);
    return stored === "small" || stored === "large" ? stored : "small-2k";
  } catch { return "small-2k"; }
};

const LIVE_RECORDS_KEY = "point-view-live-records-v1";
function readLiveRecords(): DeviceProject[] {
  try {
    const raw = localStorage.getItem(LIVE_RECORDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((p: DemoProject) => !p.id.startsWith("live-sample-"));
    }
  } catch {}
  return [];
}

type ModalName = "cloud" | "connect" | "finish" | "discard" | "settings" | "display" | "help" | null;

function Modal({ title, children, onClose, locked = false }: { title: string; children: ReactNode; onClose(): void; locked?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="demo-dialog"
      aria-labelledby="demo-dialog-title"
      onCancel={e => { e.preventDefault(); if (!locked) onClose(); }}
      onClick={e => { if (!locked && e.target === e.currentTarget) onClose(); }}
    >
      <div className="dialog-body">
        <header>
          <div><h2 id="demo-dialog-title">{title}</h2></div>
          <button className="icon-button" aria-label="关闭弹窗" disabled={locked} onClick={onClose}><X size={20} /></button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function LiveOmniApp() {
  const [session] = useState(() => new OmniPreviewSession());
  const [control] = useState(() => new OmniControlClient());
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [config, setConfig] = useState(readPreviewConfig);
  const [draft, setDraft] = useState(config);
  const [route, setRoute] = useState(() => {
    const r = location.hash.slice(2);
    return ["capture", "library", "records"].includes(r) ? r : "scan";
  });
  const [modal, setModal] = useState<ModalName>(null);
  const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState("");
  const [operationError, setOperationError] = useState("");
  const [cameraMain, setCameraMain] = useState(false);
  const [cameraFullscreen, setCameraFullscreen] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>("rgb");
  const [pointSize, setPointSize] = useState(0.025);
  const [focus, setFocus] = useState<CloudFocusRequest>();
  const [resetToken, setResetToken] = useState(0);
  const [device, setDevice] = useState(UNKNOWN_DEVICE_STATUS);
  const [pointTotal, setPointTotal] = useState<ScanPointTotal>({ session: null, points: null });
  const [scanProfile, setScanProfile] = useState<ScanProfile>(readScanProfile);
  const [scanSeconds, setScanSeconds] = useState(0);
  const [scanTimeKnown, setScanTimeKnown] = useState(false);
  const scanClock = useRef<{ key: string; at: number; known: boolean } | null>(null);
  const locallyStartedJob = useRef<string | null>(null);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [scanName, setScanName] = useState("");
  const [records, setRecords] = useState<DeviceProject[]>(readLiveRecords);
  const [projectListError, setProjectListError] = useState(false);
  const [projectListRetry, setProjectListRetry] = useState(0);
  const [openProject, setOpenProject] = useState<DeviceProject | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const openProjectRef = useRef(openProject);
  openProjectRef.current = openProject;
  const updateProject = (project: DeviceProject) => {
    setRecords(previous => previous.map(item => item.id === project.id ? { ...item, ...project, cloudReceipt: item.cloudReceipt, cloudPending: item.cloudPending, uploaded: !!item.cloudReceipt && item.cloudReceipt.sha256 === project.sha256 } : item));
  };
  const cloudUpload = useCloudUpload((id, patch) => {
    setRecords(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item));
    setOpenProject(previous => previous?.id === id ? { ...previous, ...patch } : previous);
  });
  const uploadProject = (project: DeviceProject) => {
    if (!cloudUpload.config.endpoint) { setModal("cloud"); return; }
    void cloudUpload.start(project, controlUrlFromPreview(config.wsUrl), device.reachable);
  };
  const importPcd = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pcd")) { setNotice("请选择 PCD 点云文件"); return; }
    setImportBusy(true);
    try {
      const id = `import-${crypto.randomUUID()}`;
      const { cloud, sha256 } = await decodeProject(file, id, undefined, new AbortController().signal);
      await cacheProject(id, file);
      const project: DeviceProject = {
        id, name: file.name.replace(/\.pcd$/i, ""), fileName: file.name, sha256,
        sourcePoints: cloud.sourcePointCount, location: "本地导入", date: new Date().toISOString(), seconds: 0,
        size: Math.round(file.size / 1048576), bytes: file.size, points: `${((cloud.sourcePointCount || 0) / 10000).toFixed(1)} 万`,
        local: true, previewCached: true, uploaded: false, kind: "studio",
      };
      setRecords(previous => [project, ...previous]); setRecordTab("local"); setOpenProject(project);
    } catch { setNotice("导入失败，请检查文件格式及本机存储空间"); }
    finally { setImportBusy(false); }
  };
  const [recordTab, setRecordTab] = useState<"local" | "device">("device");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [tutorial, setTutorial] = useState<number | null>(null);

  const modalRef = useRef(modal);
  modalRef.current = modal;
  const wantConnection = useRef(false);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reportedJob = useRef("");
  const actionInFlight = useRef(false);
  const statusInFlight = useRef(false);
  const controlEpoch = useRef(0);
  const fittedScan = useRef<string | undefined>(undefined);
  const discoveryBudget = useRef(new PreviewDiscoveryBudget());
  const discoverySeed = useRef<{ key: string; result: IdentityConnectionResult } | undefined>(undefined);
  const pendingSave = useRef<{ jobId: string; name: string; seconds: number } | null>(null);
  const activeConfig = useRef(config);
  const activeCamera = useRef<CameraDirection>("front");
  const statusFailures = useRef(0);

  const connected = state.connection === "connected";
  const cloudStatus = previewFreshness(state.cloudAt, connected, now);
  const speedFresh = device.reachable && device.components.mapping === true && previewFreshness(state.speedAt, connected, now) === "live";
  const storageFree = device.reachable && typeof device.storageFreeBytes === "number" && Number.isSafeInteger(device.storageFreeBytes) && device.storageFreeBytes >= 0
    ? `${(device.storageFreeBytes / 1e9).toFixed(1)} GB` : "—";
  const imageStatus = previewFreshness(state.imageAt, connected, now);
  const syncStatus = previewFreshness(state.syncAt, connected, now);
  const availableCameras = CAMERA_DIRECTIONS.filter(camera => state.channels.some(channel =>
    channel.topic === DEFAULT_DEVICE_PROFILE.topics.images?.[camera]));
  const cameraAvailable = availableCameras.includes(state.camera);
  const cameraUnavailable = connected && state.channels.length > 0 && !cameraAvailable;
  const imageStatusText = cameraUnavailable ? "相机暂不可用" : freshnessText[imageStatus];
  const fallbackCamera = connected && !cameraAvailable ? availableCameras[0] : undefined;
  const capture = route === "capture";
  const [submitting, setSubmitting] = useState(false);
  const controlBusy = submitting || device.job?.state === "running";
  const controlBusyRef = useRef(controlBusy);
  controlBusyRef.current = controlBusy;
  const deviceActive = !!device.session && (device.components.mapping === true || device.state === "degraded");
  // 设备采集状态与预览新鲜度独立；卡帧不能把正在扫描显示成待机。
  const deviceRunning = device.state === "running" && !!device.session;
  const canOperate = device.reachable && device.actionsAllowed && !controlBusy;
  const canStart = canOperate && (deviceActive || device.state === "idle");
  const actionText = device.job?.action === "pcd" ? "正在结束并保存"
    : device.job?.action === "stop" ? "正在停止扫描" : "正在准备扫描";
  const deviceStateText = !device.reachable ? "设备未连接" : controlBusy ? actionText
    : device.state === "degraded" ? "设备异常，请检查" : deviceActive ? "设备正在扫描"
    : device.state === "idle" ? "已连接 · 待机" : "设备状态待确认";
  const previewWanted = capture && !openProject && previewEnabled;
  wantConnection.current = previewWanted;
  const deviceActiveRef = useRef(deviceActive);
  deviceActiveRef.current = deviceActive;

  const navigate = (destination: string) => { location.hash = `/${destination}`; };

  // 保持持久化记录
  useEffect(() => {
    try {
      localStorage.setItem(LIVE_RECORDS_KEY, JSON.stringify(records));
    } catch {}
  }, [records]);

  // 按本机时间锚点计算，避免卡帧、后台计时器节流造成漏计；不使用可能偏移的设备时钟。
  useEffect(() => {
    if (!deviceActive || !device.session) return;
    const key = `omni-scan-clock:${controlUrlFromPreview(config.wsUrl)}:${device.session}`;
    if (scanClock.current?.key !== key) {
      if (scanClock.current) setFocus(undefined);
      let restored: { at: number; known: boolean } | null = null;
      try { restored = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
      const valid = restored && Number.isFinite(restored.at) && restored.at > 0 && restored.at <= Date.now();
      const clock = valid ? restored! : { at: Date.now(), known: !!locallyStartedJob.current && locallyStartedJob.current === device.job?.id };
      scanClock.current = { key, ...clock };
      setScanTimeKnown(clock.known);
      try { localStorage.setItem(key, JSON.stringify(clock)); } catch {}
    }
    if (!controlBusy || device.job?.action === "start") {
      setScanSeconds(Math.max(0, Math.floor((now - scanClock.current.at) / 1000)));
    }
  }, [now, deviceActive, device.session, config.wsUrl, controlBusy, device.job?.id, device.job?.action]);

  const refreshDevice = async () => {
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    const origin = controlEpoch.current;
    try {
      const endpoint = controlUrlFromPreview(activeConfig.current.wsUrl);
      const next = await control.status(endpoint);
      if (origin !== controlEpoch.current || endpoint !== controlUrlFromPreview(activeConfig.current.wsUrl)) return;
      statusFailures.current = 0;
      if (next.job?.action === "start" && next.job.state === "failed" && next.job.id === locallyStartedJob.current) session.rejectScanStart();
      const identityResult = session.setScanIdentity(activeConfig.current.wsUrl, next.session,
        next.reachable && next.state !== "unknown" && next.components.mapping === true
          && !(next.job?.action === "start" && (next.job.state === "running" || next.job.state === "failed")));
      if (next.session && next.job?.action === "start" && next.job.state === "succeeded" && next.job.id === locallyStartedJob.current) {
        const key = previewDiscoveryKey(origin, activeConfig.current.wsUrl, next.session, next.job.id);
        if (discoverySeed.current?.key !== key) discoverySeed.current = { key, result: identityResult };
      }
      setDevice(next);
      setPointTotal(previous => updateScanPointTotal(previous, next));
    } catch {
      if (origin !== controlEpoch.current) return;
      statusFailures.current += 1;
      if (statusFailures.current >= 2) {
        session.setScanIdentity(activeConfig.current.wsUrl, null, false);
        setDevice(previous => ({ ...previous, reachable: false }));
      }
    } finally { statusInFlight.current = false; }
  };

  const connect = () => {
    try {
      const next = validatePreviewConfig(draft);
      if (new URL(next.wsUrl).href !== new URL(activeConfig.current.wsUrl).href) {
        if (deviceActive || controlBusy) { setNotice("请先结束当前扫描，再更换设备地址"); return; }
        controlEpoch.current++;
        session.setScanIdentity(next.wsUrl, null, false);
        setPointTotal({ session: null, points: null }); setDevice(UNKNOWN_DEVICE_STATUS);
        session.clearCloud(); scanClock.current = null; setScanSeconds(0); setScanTimeKnown(false);
        reportedJob.current = "";
      }
      setConfig(next); setDraft(next); activeConfig.current = next;
      setNotice(persistPreviewConfig(next) ? "" : "连接设置仅在本次打开期间保留");
      setPreviewEnabled(true);
      setFocus(undefined);
      void refreshDevice();
    } catch {
      setNotice("设备地址格式不正确，请检查后重试");
    }
  };

  const disconnect = () => {
    setPreviewEnabled(false);
    session.disconnect();
    setNotice("已暂停预览；不会停止设备扫描");
  };

  const switchCamera = (camera: CameraDirection) => {
    activeCamera.current = camera;
    if (wantConnection.current) session.connect(activeConfig.current, camera);
  };

  useEffect(() => {
    if (fallbackCamera) switchCamera(fallbackCamera);
  }, [fallbackCamera]);

  const fitCloud = () => {
    const cloud = state.cloud;
    if (!cloud || !cloud.positions.length) return;
    if (cloud.scanPreview) {
      setFocus({ token: performance.now(), center: cloud.scanPreview.center, radius: cloud.scanPreview.radius, fit: true });
      setResetToken(n => n + 1);
      return;
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < cloud.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], cloud.positions[i + axis]);
        max[axis] = Math.max(max[axis], cloud.positions[i + axis]);
      }
    }
    setFocus({
      token: performance.now(),
      center: min.map((value, axis) => (value + max[axis]) / 2) as [number, number, number],
      radius: Math.max(0.5, Math.hypot(...min.map((value, axis) => max[axis] - value)) / 2),
      fit: true,
    });
    setResetToken(n => n + 1);
  };

  const runDeviceAction = async (action: DeviceAction) => {
    if (actionInFlight.current || !canOperate || (action === "start" && !canStart)) return null;
    actionInFlight.current = true;
    setSubmitting(true); setOperationError("");
    if (action === "start") {
      controlEpoch.current++;
      session.beginScan(activeConfig.current.wsUrl, device.session);
      setScanSeconds(0); scanClock.current = null; setScanTimeKnown(false);
      setPointTotal({ session: null, points: 0 }); setFocus(undefined);
    }
    const origin = controlEpoch.current;
    const endpoint = controlUrlFromPreview(activeConfig.current.wsUrl);
    try {
      const { job } = await control.action(endpoint, action,
        action === "start" ? null : device.session, scanProfile);
      if (origin !== controlEpoch.current || endpoint !== controlUrlFromPreview(activeConfig.current.wsUrl)) return null;
      if (action === "start") locallyStartedJob.current = job.id;
      setDevice(previous => ({ ...previous, job }));
      setNotice(action === "start" ? "正在准备设备" : action === "pcd" ? "正在结束扫描并保存到手持设备…" : "正在停止扫描");
      return job;
    } catch {
      if (origin !== controlEpoch.current || endpoint !== controlUrlFromPreview(activeConfig.current.wsUrl)) return null;
      if (action === "start") session.rejectScanStart();
      setOperationError("未收到设备操作确认，请等待状态更新后再决定是否重试。");
      setNotice("设备操作尚未确认");
      await refreshDevice();
      return null;
    } finally { actionInFlight.current = false; setSubmitting(false); }
  };

  const start = () => {
    if (!canStart) return;
    setPreviewEnabled(true);
    if (!deviceActive) {
      void runDeviceAction("start");
      setScanName("");
    } else if (device.reachable && deviceRunning) { session.resumeConfirmedScan(); void refreshDevice(); }
    navigate("capture");
  };

  const connectAndStart = () => start();

  const handleRebindAndConnect = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const next = validatePreviewConfig(draft);
      if (new URL(next.wsUrl).href !== new URL(activeConfig.current.wsUrl).href) {
        if (deviceActive || controlBusy) { setNotice("请先结束当前扫描，再更换设备地址"); return; }
        controlEpoch.current++;
        session.setScanIdentity(next.wsUrl, null, false);
        setPointTotal({ session: null, points: null }); setDevice(UNKNOWN_DEVICE_STATUS);
        session.clearCloud(); scanClock.current = null; setScanSeconds(0); setScanTimeKnown(false);
        reportedJob.current = "";
      }
      setConfig(next); setDraft(next); activeConfig.current = next;
      persistPreviewConfig(next);
      setPreviewEnabled(true);
      setFocus(undefined); setModal(null);
      void refreshDevice();
      setNotice("已保存设备绑定");
    } catch { setNotice("设备连接地址格式不正确，请检查后重试"); }
  };

  const handleSaveScan = async () => {
    setModal(null);
    const name = scanName.trim() || `OMNI 扫描 ${new Date().toLocaleDateString("zh-CN")}`;
    const job = await runDeviceAction("pcd");
    if (job) pendingSave.current = { jobId: job.id, name, seconds: scanTimeKnown ? scanSeconds : 0 };
  };

  const handleDiscardScan = async () => {
    setModal(null);
    await runDeviceAction("stop");
  };

  // 全局路由与原生返回键监听
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onRoute = () => {
      const hash = location.hash.slice(2);
      if (["capture", "library", "records"].includes(hash)) setRoute(hash);
      else if (hash === "settings") { setModal("settings"); setRoute("scan"); }
      else setRoute("scan");
    };
    const back = () => {
      if (openProjectRef.current) { setOpenProject(null); return; }
      if (modalRef.current) { setModal(null); return; }
      if (controlBusyRef.current) { setNotice("正在执行设备操作，请稍候"); return; }
      if (location.hash.slice(2) === "capture") {
        if (deviceActiveRef.current) { setModal("finish"); return; }
        navigate("scan");
        return;
      }
      navigate("scan");
    };
    const receive = (event: MessageEvent) => {
      if (!isLabMessage(event)) return;
      if (event.data.type === "omni-lab:back") back();
      if (event.data.type === "omni-lab:connect") {
        try {
          const next = validatePreviewConfig(event.data.config);
          controlEpoch.current++;
          session.setScanIdentity(next.wsUrl, null, false);
          setConfig(next); setDraft(next); activeConfig.current = next;
          setPreviewEnabled(true); setFocus(undefined);
        } catch (error) {
          postLabMessage({ type: "omni-app:state", source: "omni", connection: "error", phase: "unknown", detail: String(error) });
        }
      }
    };
    const visibility = () => {
      if (document.hidden) session.disconnect();
      else if (wantConnection.current) session.connect(activeConfig.current, activeCamera.current);
    };

    onRoute();
    window.addEventListener("hashchange", onRoute);
    window.addEventListener("message", receive);
    window.addEventListener("omni:native-back", back);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(tick); clearTimeout(reconnectTimer.current); session.dispose();
      window.removeEventListener("hashchange", onRoute);
      window.removeEventListener("message", receive);
      window.removeEventListener("omni:native-back", back);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [session]);

  // 自动断线重连
  useEffect(() => {
    if (!previewWanted || !device.previewReady || document.hidden) {
      clearTimeout(reconnectTimer.current);
      if (state.connection !== "offline") session.disconnect();
      return;
    }
    if (state.connection === "connected") { reconnectAttempt.current = 0; clearTimeout(reconnectTimer.current); return; }
    if (state.connection === "connecting") return;
    clearTimeout(reconnectTimer.current);
    const delay = Math.min(8000, 1000 * 2 ** Math.min(reconnectAttempt.current++, 3));
    reconnectTimer.current = window.setTimeout(() => session.connect(activeConfig.current, activeCamera.current), delay);
    return () => clearTimeout(reconnectTimer.current);
  }, [session, state.connection, device.previewReady, previewWanted, config.wsUrl]);

  // bridge 就绪前的空公告可能保留在已连接 socket 中；按本地启动分配有界发现预算。
  useEffect(() => {
    const job = device.job;
    if (!previewWanted || document.hidden || !device.reachable || device.components.mapping !== true || !device.session
      || controlBusy || job?.action !== "start" || job.state !== "succeeded" || locallyStartedJob.current !== job.id) {
      discoveryBudget.current.cancel();
      return;
    }
    const origin = controlEpoch.current;
    const key = previewDiscoveryKey(origin, config.wsUrl, device.session, job.id);
    const seed = discoverySeed.current;
    if (seed?.key !== key) return;
    const generation = session.getConnectionGeneration();
    const action = discoveryBudget.current.observe(key, seed.result, generation, state.connection);
    if (action === "discover") {
      if (session.rediscoverPreview()) discoveryBudget.current.created();
      return;
    }
    if (action !== "check") return;
    const timer = window.setTimeout(() => {
      if (controlEpoch.current !== origin || !discoveryBudget.current.matches(key) || document.hidden || !wantConnection.current
        || session.getConnectionGeneration() !== generation) return;
      const current = session.getSnapshot();
      if (current.connection === "connected" && !current.channels.some(channel => channel.topic === config.pointCloudTopic)) session.rediscoverPreview();
    }, 2000);
    return () => { clearTimeout(timer); discoveryBudget.current.cancel(); };
  }, [session, previewWanted, controlBusy, device.reachable, device.components.mapping, device.session,
    device.job?.id, device.job?.action, device.job?.state, config.wsUrl, config.pointCloudTopic, state.connection]);

  // 轮询控制状态
  useEffect(() => {
    void refreshDevice();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshDevice(); }, controlBusy || !device.reachable ? 1000 : 3000);
    return () => clearInterval(timer);
  }, [controlBusy, device.reachable]);

  useEffect(() => {
    const job = device.job;
    if (!job || job.state === "running" || reportedJob.current === `${job.id}:${job.state}`) return;
    reportedJob.current = `${job.id}:${job.state}`;
    setNotice(job.message);
    if (job.state === "failed") setOperationError(job.action === "pcd"
      ? "保存未完成。请保持设备供电，检查连接后再次点击结束并保存。"
      : job.action === "start" ? "扫描启动未完成，请检查设备状态后重试。" : "停止操作未完成，请检查设备状态。");
    if (job.action === "pcd" && (job.state === "succeeded" || job.state === "warning") && job.result) {
      const savedTo = job.result.backupVerified ? "已保存到设备并备份" : "已保存到手持设备";
      setNotice(job.state === "warning" ? `${savedTo}；采集质量存在告警，请检查成果` : `${savedTo}；可在记录中下载完整文件到手机`);
      const saved = pendingSave.current;
      const result = job.result;
      setPointTotal({ session: result.session, points: result.points });
      const project: DeviceProject = {
        id: result.session, fileName: result.path.split("/").at(-1), sha256: result.sha256, sourcePoints: result.points,
        name: saved?.jobId === job.id ? saved.name : `OMNI 扫描 ${new Date(job.finished_at_ms || Date.now()).toLocaleDateString("zh-CN")}`,
        location: "OMNI 主机", date: new Date(job.finished_at_ms || Date.now()).toISOString(),
        seconds: saved?.jobId === job.id ? saved.seconds : 0,
        size: Math.round(result.bytes / (1024 * 1024)), bytes: result.bytes,
        points: `${(result.points / 10000).toFixed(1)} 万`,
        local: false, uploaded: false, kind: "studio",
      };
      setRecords(previous => previous.some(p => p.id === project.id) ? previous : [project, ...previous]);
      pendingSave.current = null;
      if (saved?.jobId === job.id) { setRecordTab("device"); navigate("records"); }
    } else if (job.action === "stop" && job.state === "succeeded") {
      setPointTotal({ session: null, points: null });
      setScanSeconds(0); scanClock.current = null; setScanTimeKnown(false); setScanName(""); navigate("scan");
    }
  }, [device.job]);

  // 设备项目元数据同步；离线时保留已有记录，不将网络失败显示为文件丢失。
  useEffect(() => {
    if (route !== "records" || !device.reachable) return;
    const abort = new AbortController();
    setProjectListError(false);
    const timer = setTimeout(() => { setProjectListError(true); abort.abort(); }, 6000);
    void listProjects(controlUrlFromPreview(config.wsUrl), abort.signal).then(items => {
      setRecords(previous => {
        const merged = new Map(previous.map(project => [project.id, project]));
        for (const item of items) {
          const old = merged.get(item.id);
          merged.set(item.id, { ...old, id: item.id, name: old?.name || `OMNI 扫描 ${new Date(item.createdAtMs).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
            fileName: item.fileName, sha256: item.sha256, sourcePoints: item.points,
            date: old?.date || new Date(item.createdAtMs).toISOString(), seconds: old?.seconds || 0,
            size: Math.round(item.bytes / 1048576), bytes: item.bytes, points: `${(item.points / 10000).toFixed(1)} 万`,
            location: "OMNI 主机", local: old?.local || false, uploaded: old?.uploaded || false, kind: "studio" });
        }
        return [...merged.values()];
      });
    }).catch(() => { if (!abort.signal.aborted) setProjectListError(true); }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); abort.abort(); };
  }, [route, device.reachable, config.wsUrl, projectListRetry]);

  // 发送给 Lab 调试台的状态报告
  useEffect(() => {
    postLabMessage({
      type: "omni-app:state", source: "omni", connection: state.connection,
      phase: deviceRunning ? "scanning" : "idle", pointCount: state.sourcePointCount,
      seconds: scanSeconds, previewSeconds: scanSeconds,
      cloudStatus, imageStatus, detail: state.detail,
      endpoint: config.wsUrl, pointCloudTopic: config.pointCloudTopic,
      channels: state.channels.map(({ topic, schemaName }) => ({ topic, schemaName })),
      camera: state.camera, availableCameras,
      receivedAt: { cloud: state.cloudAt, image: state.imageAt, sync: state.syncAt }, sync: state.sync,
    });
  }, [state, config, cloudStatus, imageStatus, deviceRunning, scanSeconds, availableCameras]);

  useEffect(() => {
    const token = state.cloud?.scanPreview?.token;
    if (token && token !== fittedScan.current) { fittedScan.current = token; fitCloud(); }
    else if (state.cloud && !token && !focus) fitCloud();
  }, [state.cloud, focus]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(""), 4200); return () => clearTimeout(t); }, [notice]);

  const visibleRecords = records.filter(p => (recordTab === "device" ? !p.id.startsWith("import-") : p.local)
    && p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : sort === "size" ? b.size - a.size : b.date.localeCompare(a.date));

  const displaySettings = (
    <>
      <label className="field-label">点云着色</label>
      <div className="segmented">
        <button className={colorMode === "rgb" ? "active" : ""} onClick={() => setColorMode("rgb")}>原始颜色</button>
        <button className={colorMode === "height" ? "active" : ""} onClick={() => setColorMode("height")}>高度着色</button>
        <button className={colorMode === "solid" ? "active" : ""} onClick={() => setColorMode("solid")}>单色预览</button>
      </div>
      <label className="range-label">点大小 <b>{Math.round(pointSize * 1000)}</b>
        <input aria-label="点大小" type="range" min="10" max="60" step="5" value={pointSize * 1000} onChange={e => setPointSize(Number(e.target.value) / 1000)} />
      </label>
      <button className="primary full" onClick={() => setModal(null)}>完成<Check size={17} /></button>
    </>
  );

  return (
    <div className={`handheld-app live-omni ${capture ? "immersive" : ""}`}>
      {/* 底部导航栏：与模拟数据 HandheldDemo 严格对齐 */}
      {!capture && (
        <aside className="side-nav">
          <button className="brand-symbol" aria-label="返回扫描工作台" onClick={() => navigate("scan")}>
            <Scan size={30} strokeWidth={1.7} /><span />
          </button>
          <div className="nav-items">
            {[
              { id: "library", icon: BookOpen, title: "指南" },
              { id: "scan", icon: Scan, title: "扫描" },
              { id: "records", icon: FolderOpen, title: "记录" },
            ].map(({ id, icon: Icon, title }) => (
              <button
                key={id}
                className={`${id === "scan" ? "nav-scan-add" : ""} ${route === id ? "active" : ""}`}
                aria-label={title}
                aria-current={route === id ? "page" : undefined}
                onClick={() => navigate(id)}
              >
                {id === "scan" ? <Plus size={32} strokeWidth={1.5} /> : <><Icon size={22} /><span>{title}</span></>}
              </button>
            ))}
          </div>
          <button className="nav-help" aria-label="使用帮助" onClick={() => setModal("help")}><CircleHelp size={21} /></button>
        </aside>
      )}

      <div className="app-body">
        {/* 顶部 Header：对齐 HandheldDemo 布局 */}
        {!capture && (
          <header className="app-header">
            <button className="brand-name" aria-label="返回扫描工作台" onClick={() => navigate("scan")}>
              观曜<span className="brand-divider" /><b>OMNI SCAN</b>
            </button>
            <div className="header-actions">
              <button className="icon-button" aria-label="设置" onClick={() => { setDraft(config); setModal("settings"); }}><Settings2 size={21} /></button>
            </div>
          </header>
        )}

        {/* 扫描进行中的恢复 Banner */}
        {!capture && deviceActive && (
          <button className="resume-banner" onClick={() => navigate("capture")}>
            <Radio size={16} />
            {!device.reachable ? "扫描状态待确认" : controlBusy ? actionText : "设备正在扫描"}
            <span>{scanTimeKnown ? `${formatDuration(scanSeconds)} · ` : ""}返回扫描 <ArrowRight size={14} /></span>
          </button>
        )}

        {/* 1. 扫描工作台首页：结构严格对齐 HandheldDemo 的 scan-launch-layout */}
        {route === "scan" && (
          <main className="home-page page-content">
            <div className="page-heading">
              <div><h1>扫描工作台</h1></div>
            </div>
            {operationError && <p className="operation-error" role="alert">{operationError}</p>}
            <div className="scan-launch-layout">
              {/* 设备卡片：一机一设备绑定，简洁利落 */}
              <section className="device-card">
                <div className="section-mini-title">
                  <span>我的设备</span>
                  <button
                    type="button"
                    className="rebind-action-btn"
                    onClick={() => { setDraft(config); setModal("connect"); }}
                    aria-label="换绑设备"
                    title="更换绑定的手持设备或修改网络连接地址"
                  >
                    <ArrowLeftRight size={15} aria-hidden="true" />
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
                <div className={`connection-state ${device.reachable ? "online" : ""}`} role="status">
                  <span className="small-dot" />{deviceStateText}
                </div>
                <p className="device-connect-hint">{!device.reachable
                  ? "请连接 OMNI Wi-Fi 并保持设备开机，可在连接设置中重试。"
                  : deviceActive ? "返回扫描查看实时画面；离开预览不会停止采集。"
                  : "点击开始扫描，等待设备准备完成后再平稳移动。"}</p>
              </section>

              {/* 设备进程状态；不把预览或时间同步冒充传感器定位状态 */}
              <div className="sensor-status" aria-label="设备进程状态">
                {[{ key: "livox", label: "雷达", icon: Radio }, { key: "camera", label: "相机", icon: Camera },
                  { key: "mapping", label: "建图", icon: Box }].map(({ key, label, icon: Icon }) => (
                  <div key={key} className={device.reachable && device.components[key] ? "ready" : ""}>
                    <Icon size={23} /><span>{label}</span>
                    <small>{!device.reachable ? "待连接" : device.components[key] ? "已启动" : device.state === "idle" ? "待扫描" : "未启动"}</small>
                  </div>
                ))}
              </div>

              {/* 黄金路径主按钮 */}
              <button
                className="primary full scan-start-button"
                disabled={!canStart}
                onClick={connectAndStart}
              >
                {controlBusy ? <><LoaderCircle className="spin" size={18} />{actionText}</>
                  : deviceActive ? <>返回扫描<ArrowRight size={18} /></>
                  : device.reachable ? <>开始扫描<ArrowRight size={18} /></>
                  : <>请先连接设备<WifiOff size={18} /></>}

              </button>
            </div>
          </main>
        )}

        {/* 2. 空间记录页：对齐 HandheldDemo */}
        {route === "records" && (
          <main className="page-content records-page">
            <div className="page-heading">
              <div><h1>空间记录</h1></div>
              <div className="record-heading-actions">
                <button className="secondary record-import" aria-label={importBusy ? "正在导入 PCD" : "导入 PCD"} title="导入 PCD" disabled={importBusy} onClick={() => importInput.current?.click()}>{importBusy ? <LoaderCircle size={18} className="spin" /> : <FolderOpen size={18} />}</button>
                <button className="primary" disabled={!canStart} onClick={start}><Plus size={18} />{deviceActive ? "返回扫描" : "新建扫描"}</button>
              </div>
              <input ref={importInput} type="file" accept=".pcd" hidden aria-label="导入本地点云文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importPcd(file); }} />
            </div>
            <div className="record-toolbar">
              <div className="segmented record-tabs">
                <button className={recordTab === "local" ? "active" : ""} onClick={() => setRecordTab("local")}>
                  <Smartphone size={16} />手机本地 <span>{records.filter(p => p.local).length}</span>
                </button>
                <button className={recordTab === "device" ? "active" : ""} onClick={() => setRecordTab("device")}>
                  <HardDrive size={16} />设备项目 <span>{records.filter(p => !p.id.startsWith("import-")).length}</span>
                </button>
              </div>
              <div className="search-sort">
                <label className="search-field">
                  <Search size={17} />
                  <input placeholder="搜索记录" aria-label="搜索项目名称" value={query} onChange={e => setQuery(e.target.value)} />
                </label>
                <select aria-label="项目排序" value={sort} onChange={e => setSort(e.target.value)}>
                  <option value="newest">最近创建</option>
                  <option value="name">名称排序</option>
                  <option value="size">文件大小</option>
                </select>
              </div>
            </div>
            {recordTab === "device" && projectListError && <div className="records-empty" role="status">设备项目列表暂不可用，已有记录仍可打开。<button className="secondary" onClick={() => setProjectListRetry(n => n + 1)}>刷新项目</button></div>}
            {visibleRecords.length === 0 && <p className="records-empty" role="status">{query.trim() ? "没有匹配的项目，请换个关键词。"
              : recordTab === "local" ? "还没有离线点云。可导入 PCD，或下载设备项目。"
              : !device.reachable ? "设备未连接。连接 OMNI Wi-Fi 后可读取已保存项目。" : "暂无设备项目，完成扫描并保存后会显示在这里。"}</p>}
            <div className="records-grid">
              {visibleRecords.map(project => (
                  <button key={project.id} className="project-card" aria-label={`打开项目 ${project.name}`} onClick={() => setOpenProject(project)}>
                    <div className="project-card-info">
                      <div>
                        <h3>{project.name}</h3>
                        <span>{formatDate(project.date)} <i /> {project.location}</span>
                      </div>
                      <ArrowRight size={18} />
                    </div>
                    <div className="project-card-bottom">
                      <span><Box size={13} />{project.points}点</span>
                      <span>{project.local ? "可离线查看" : project.previewCached ? "仅有预览" : "尚未下载"}{hasCloudReceipt(project, cloudUpload.config.endpoint) ? " · 已上云" : project.cloudPending ? " · 上云待继续" : ""}</span>
                    </div>
                  </button>
                ))}
            </div>
          </main>
        )}

        {/* 3. 空间素材页：对齐 HandheldDemo */}
        {route === "library" && (
          <main className="page-content library-page">
            <div className="page-heading">
              <div><h1>采集指南</h1></div>
              <BookOpen className="heading-icon" size={36} strokeWidth={1.3} />
            </div>
            <p className="dialog-description">连接设备、平稳采集、保存并查看完整成果。</p>
            <div className="guide-list">
              {["第一次扫描，从这里开始", "怎样获得更完整的点云", "保存、下载与离线查看"].map((title, i) => (
                <button className="guide-card" key={title} onClick={() => setTutorial(i)}>
                  <span className="guide-symbol"><BookOpen size={27} /></span>
                  <div><h2>{title}</h2><p>{["连接 OMNI Wi-Fi，等待扫描准备完成", "平稳移动，补充遮挡区域与稀疏位置", "区分设备保存和下载到此 App"][i]}</p></div>
                  <ChevronRight size={20} />
                </button>
              ))}
            </div>
          </main>
        )}

        {/* 4. 全屏采集预览页：对齐 HandheldDemo 画中画与全屏操作流 */}
        {capture && (
          <main className={`capture-page pip-view compact-pip live-capture ${cameraMain ? "camera-main" : "cloud-main"} ${cameraFullscreen ? "camera-fullscreen" : ""}`}>
            <div className="capture-panes">
              <section className="capture-cloud-pane" aria-label="累计扫描预览">
                {cameraMain && (
                  <button className="pip-expand" aria-label="全屏查看点云" onClick={() => { setCameraMain(v => !v); setCameraFullscreen(true); }}>
                    <Expand size={17} />
                  </button>
                )}
                <PointCloudCanvas
                  cloud={state.cloud}
                  colorMode={colorMode}
                  pointSize={pointSize}
                  selected={EMPTY_SELECTION}
                  selectionEnabled={false}
                  moveEnabled={false}
                  showReferenceGuides={false}
                  resetToken={resetToken}
                  focusRequest={focus}
                  onTogglePoint={noop}
                  onSelectPoints={noop}
                  onMoveSelected={noop}
                  onStats={noop}
                />
                {!state.cloud && (
                  <div className="live-preview-empty">
                    <Box size={30} />
                    <strong>等待点云</strong>
                    <span>{connected ? "等待设备传来实时帧" : "请先连接设备"}</span>
                  </div>
                )}
              </section>
              <section className="capture-camera-pane" aria-label="真实相机预览">
                {!cameraMain && (
                  <button className="pip-expand" aria-label="全屏查看相机" onClick={() => { setCameraMain(v => !v); setCameraFullscreen(true); }}>
                    <Expand size={17} />
                  </button>
                )}
                {state.imageUrl ? (
                  <img src={state.imageUrl} alt={`${CAMERA_DIRECTION_LABELS[state.camera]}相机最近接收画面`} />
                ) : (
                  <div className="live-preview-empty">
                    <Camera size={26} />
                    <span>{cameraUnavailable ? "相机画面未开放" : `${CAMERA_DIRECTION_LABELS[state.camera]}相机 · 等待图像`}</span>
                  </div>
                )}
                <span className="live-image-status">{imageStatusText}</span>
              </section>
            </div>

            {cameraFullscreen && (
              <button className="exit-camera-fullscreen" onClick={() => setCameraFullscreen(false)}>
                <Expand size={17} />退出全屏
              </button>
            )}

            <header className="capture-header">
              <button
                className="icon-button"
                aria-label="返回扫描工作台"
                title="返回设备"
                onClick={() => {
                  navigate("scan");
                }}
              >
                <ArrowLeft size={21} />
              </button>
              <div className="capture-title">
                <h1>{!device.reachable && deviceActive ? "扫描状态待确认" : controlBusy ? actionText : deviceRunning ? "正在扫描" : deviceActive ? "设备异常" : "扫描预览"}</h1>
              </div>
              <button className="icon-button" aria-label="连接管理" onClick={() => { setDraft(config); setModal("connect"); }}>
                {connected ? <Wifi size={20} /> : <WifiOff size={20} />}
              </button>
              <button className="icon-button" aria-label="扫描显示设置" onClick={() => setModal("display")}>
                <SlidersHorizontal size={20} />
              </button>
            </header>

            <div className="capture-telemetry">
              <span aria-label="模拟设备电量 86%" title="模拟电量，非设备实测"><Battery size={15} />86% <small>模拟</small></span>
              <span aria-label={`OMNI 可用存储 ${storageFree}`}><HardDrive size={15} />{storageFree}</span>
              <span aria-label="累计真彩点数"><Box size={15} />{pointTotal.points === null ? "累计点数待同步" : `累计 ${(pointTotal.points / 10000).toFixed(1)} 万点`}</span>
              <span aria-label="OMNI 移动速度" title="由 OMNI 定位位移与 ROS 时间计算"><Gauge size={15} />{speedFresh && state.speed !== null ? state.speed.toFixed(2) : "—"} m/s</span>
            </div>

            {!connected && deviceActive && (
              <div className="connection-warning">
                <WifiOff size={18} />
                <div>
                  <b>{!device.reachable ? "设备连接已中断" : !previewEnabled ? "预览已暂停" : state.connection === "error" ? "预览连接失败" : "预览正在连接"}</b>
                  <span>{!device.reachable ? "扫描状态待确认，请勿直接关闭设备。" : "设备扫描不受影响；结束与保存仍可操作。"}</span>
                </div>
                <button onClick={connect}>{state.connection === "connecting" ? "重连中…" : "恢复预览"}</button>
              </div>
            )}

            {!connected && !deviceActive && (
              <div className="live-reconnect">
                <span>{!previewEnabled ? "预览已暂停，设备控制保持连接" : state.connection === "error" ? connectionHint.error : !device.reachable ? "正在连接 OMNI 设备" : controlBusy && device.job?.action === "pcd" ? "正在保存点云并导出 PCD，请稍候" : controlBusy && device.job?.action === "start" ? `正在启动扫描` : "设备待机，点击开始扫描"}</span>
                {state.connection === "error" && <button className="secondary" onClick={connect}>连接预览</button>}
              </div>
            )}

            <div className="capture-guide" role="status" aria-live="polite">
              <span className={`status-orb ${deviceRunning ? "recording" : ""}`} />
              <span>
                {controlBusy && device.job?.action === "pcd"
                  ? "正在导出点云，请稍候…"
                  : controlBusy && device.job?.action === "start"
                  ? "正在启动扫描…"
                  : deviceRunning
                  ? (cloudStatus === "live" ? "采集中 · 平稳移动" : "设备正在扫描 · 点云预览待更新")
                  : deviceActive
                  ? "设备状态异常，请检查后再移动"
                  : connected
                  ? "累计预览已连接"
                  : "等待连接设备"}
              </span>
            </div>

            {operationError && <p className="operation-error" role="alert">{operationError}</p>}
            <div className="capture-controls">
              <span className="capture-time">{formatDuration(scanSeconds)}</span>
              <span className="capture-time-label">{deviceActive ? (scanTimeKnown ? "扫描时长（约）" : "接入时长") : controlBusy ? actionText : "待扫描"}</span>
              <button
                className={`shutter ${deviceActive ? "is-recording" : ""}`}
                aria-label={deviceActive ? "结束并保存" : "开始扫描"}
                disabled={!canOperate || (!deviceActive && !canStart)}
                onClick={() => {
                  if (deviceActive) setModal("finish");
                  else start();
                }}
              >
                {controlBusy ? <LoaderCircle className="spin" size={30} /> : deviceActive ? <Square size={27} fill="currentColor" /> : <span />}
              </button>
              <span className="shutter-label">{controlBusy ? actionText : deviceActive ? "结束并保存" : "开始扫描"}</span>
              <button
                className="preview-pause-button"
                disabled={controlBusy || (previewEnabled ? !connected : !device.reachable || !device.previewReady)}
                title="只暂停画面接收，设备继续采集"
                onClick={() => {
                  if (previewEnabled) disconnect();
                  else { setPreviewEnabled(true); setNotice("正在恢复预览"); }
                }}
              >
                {previewEnabled ? <Pause size={16} /> : <Play size={16} />}
                {previewEnabled ? "暂停预览" : "恢复预览"}
              </button>
            </div>

            <div className="capture-bottom">
              <div className="capture-switch-tools">
                <button className="icon-button" aria-label="切换主画面" onClick={() => { setCameraFullscreen(false); setCameraMain(v => !v); }}>
                  {cameraMain ? <Camera size={19} /> : <Box size={19} />}
                  <span>{cameraMain ? "可见光" : "点云"}</span>
                </button>
                {availableCameras.length > 1 && (
                  <button
                    className="icon-button"
                    aria-label="切换相机"
                    disabled={!connected}
                    onClick={() => switchCamera(availableCameras[(availableCameras.indexOf(state.camera) + 1) % availableCameras.length])}
                  >
                    <Camera size={19} />
                    <span>{CAMERA_DIRECTION_LABELS[state.camera]}相机</span>
                  </button>
                )}
              </div>
              <div className="capture-bottom-tools">
                <button className="icon-button" aria-label="扫描视角复位" disabled={!state.cloud} onClick={fitCloud}>
                  <Crosshair size={20} />
                </button>
              </div>
            </div>

            {controlBusy && device.job?.action === "pcd" && (
              <div className="phase-overlay">
                <div>
                  <LoaderCircle className="spin" size={34} />
                  <h2>正在结束并保存</h2>
                  <p>结束采集 → 保存到手持设备 → 校验与电脑备份</p>
                  <p>完成后生成记录；下载到手机可稍后操作。</p>
                </div>
              </div>
            )}
          </main>
        )}
      </div>

      {openProject && <ProjectViewer key={openProject.id} project={openProject} endpoint={controlUrlFromPreview(config.wsUrl)} online={device.reachable}
        onClose={() => setOpenProject(null)} onUpdate={updateProject}
        cloudControls={{ endpoint: cloudUpload.config.endpoint, task: cloudUpload.task, busy: cloudUpload.busy,
          onUpload: () => uploadProject(openProject), onPause: cloudUpload.pause }} />}

      {cloudUpload.busy && !openProject && <div className="cloud-task-banner" role="status">
        <span>{cloudUpload.task?.message}</span><button className="secondary" onClick={cloudUpload.pause}>暂停上云</button>
      </div>}
      {/* Toast 提示 */}
      {notice && (
        <div className="toast" role="status">
          <span className="notice-dot" aria-hidden="true" />
          <span>{notice}</span>
          <button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button>
        </div>
      )}

      {/* 弹窗集合：与 HandheldDemo 布局统一 */}
      {modal && (
        <Modal
          title={{
            cloud: "云服务设置",
            connect: "设备连接设置",
            finish: "结束扫描并保存",
            discard: "放弃本次扫描？",
            settings: "设置与偏好",
            display: "显示设置",
            help: "快速入门",
          }[modal]}
          onClose={() => setModal(null)}
        >
          {modal === "cloud" && <CloudConfigForm config={cloudUpload.config} busy={cloudUpload.busy} onSave={value => {
            cloudUpload.setConfig(value); setModal(null); setNotice("云服务设置已保存，可在项目中点击一键上云");
          }} />}
          {/* 1. 换绑设备弹窗 */}
          {modal === "connect" && (
            <>
              <div className="modal-device-card">
                <div className="device-avatar">
                  <Radio size={22} />
                </div>
                <div className="device-info">
                  <h3>OMNI Handheld</h3>
                  <p>手持激光扫描仪</p>
                </div>
                <div className={`status-pill ${device.reachable ? "online" : ""}`}>
                  <span className="dot" />
                  <span>{device.reachable ? "设备在线" : "设备未连接"}</span>
                </div>
              </div>

              <div className="rebind-hint-box">
                先连接设备 Wi-Fi，再填写连接地址。扫描期间可暂停预览；更换地址需先结束扫描。
              </div>

              <form onSubmit={handleRebindAndConnect}>
                <label className="field-label" htmlFor="omni-ws-url">设备连接地址</label>
                <input
                  id="omni-ws-url"
                  className="text-input"
                  value={draft.wsUrl}
                  onChange={e => setDraft({ ...draft, wsUrl: e.target.value })}
                  placeholder="ws://10.42.0.1:8765"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={deviceActive || controlBusy}
                  required
                />

                <div className="preset-chips">
                  <span className="chips-label">快捷选择：</span>
                  <button
                    type="button"
                    disabled={deviceActive || controlBusy}
                    className="chip-btn"
                    onClick={() => setDraft({ ...draft, wsUrl: "ws://10.42.0.1:8765" })}
                  >
                    出厂默认
                  </button>

                </div>

                <button type="submit" className="primary full" style={{ marginTop: 18 }} disabled={state.connection === "connecting"}>
                  {state.connection === "connecting" ? <><LoaderCircle className="spin" size={17} />正在连接…</> : "保存并连接"}
                </button>
              </form>
              {previewEnabled && connected && (
                <button className="secondary full" style={{ marginTop: 10 }} onClick={disconnect}>
                  暂停预览
                </button>
              )}
            </>
          )}

          {/* 2. 保存扫描弹窗 */}
          {modal === "finish" && (
            <>
              <p className="dialog-description">确认后结束本次扫描，将完整点云保存到手持设备，并备份到电脑。可在记录中将完整点云下载到此 App，离线查看。</p>
              <div className="finish-summary">
                <div>
                  <Timer size={21} />
                  <strong>{formatDuration(scanSeconds)}</strong>
                  <span>{scanTimeKnown ? "扫描时长（约）" : "接入时长"}</span>
                </div>
                <div>
                  <Box size={21} />
                  <strong>{pointTotal.points === null ? "待同步" : `${(pointTotal.points / 10000).toFixed(1)} 万`}</strong>
                  <span>累计真彩点数</span>
                </div>
              </div>
              <form onSubmit={e => { e.preventDefault(); void handleSaveScan(); }}>
                <label className="field-label" htmlFor="scan-name">项目名称（选填）</label>
                <input
                  id="scan-name"
                  className="text-input"
                  maxLength={40}
                  placeholder="留空自动命名，例如：二楼会议室"
                  value={scanName}
                  onChange={e => setScanName(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="primary full" disabled={!canOperate || !deviceActive}>
                  {controlBusy && device.job?.action === "pcd" ? <><Save size={17} className="icon-pulse" />正在保存点云…</> : <><Save size={17} />确认结束并保存</>}
                </button>
              </form>
              <button className="secondary full" style={{ marginTop: 10 }} onClick={() => setModal(null)}>继续扫描</button>
              <button className="danger-text full" onClick={() => setModal("discard")}><Trash2 size={16} />放弃本次扫描</button>
            </>
          )}

          {/* 3. 放弃本次扫描确认弹窗 */}
          {modal === "discard" && (
            <>
              <p className="dialog-description">确定放弃本次扫描吗？放弃后数据将不会保存。已有记录不受影响。</p>
              <button className="danger-button full" disabled={!canOperate || !deviceActive} onClick={() => void handleDiscardScan()}>放弃扫描</button>
              <button className="secondary full" style={{ marginTop: 10 }} onClick={() => setModal("finish")}>返回保存选项</button>
            </>
          )}

          {/* 4. 显示设置弹窗 */}
          {modal === "display" && displaySettings}

          {/* 5. 设置与偏好弹窗 */}
          {modal === "settings" && (
            <>
              {/* 顶部作业员名片 */}
              <div className="settings-profile-card">
                <div className="avatar-badge"><Settings2 size={22} /></div>
                <div className="profile-info">
                  <h3>OMNI 手持设备</h3>
                  <p>{deviceStateText}</p>
                </div>
                <span className={`profile-status-badge ${device.reachable ? "online" : ""}`}>
                  {device.reachable ? "设备在线" : "设备未连接"}
                </span>
              </div>

              {/* 设备通信参数 */}
              <form onSubmit={e => { e.preventDefault(); connect(); }}>
                <label className="field-label" htmlFor="settings-ws-url">设备连接地址</label>
                <input
                  id="settings-ws-url"
                  className="text-input"
                  value={draft.wsUrl}
                  onChange={e => setDraft({ ...draft, wsUrl: e.target.value })}
                  placeholder="ws://10.42.0.1:8765"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={deviceActive || controlBusy}
                  required
                />
                <div className="settings-actions-group">
                  <button type="submit" className="primary" disabled={state.connection === "connecting"}>
                    {state.connection === "connecting" ? <><LoaderCircle className="spin" size={16} /> 连接中…</> : "保存并连接"}
                  </button>
                  <button type="button" className="secondary" disabled={!connected || !previewEnabled} onClick={disconnect}>
                    暂停预览
                  </button>
                </div>
              </form>

              <div className="settings-profile-section">
                <label className="field-label">云服务</label>
                <p className="dialog-description">{cloudUpload.config.endpoint ? "已设置上传服务；项目上云后保留本地文件。" : "尚未配置。设置云服务后可上传完整点云。"}</p>
                <button className="secondary full" disabled={cloudUpload.busy} onClick={() => setModal("cloud")}>云服务设置</button>
              </div>
              {/* 扫描画质 */}
              <div className="settings-profile-section">
                <label className="field-label" htmlFor="omni-profile-select">下次扫描画质</label>
                <div className="segmented">
                  {(["small-2k", "small", "large"] as const).map(p => (
                    <button
                      key={p}
                      disabled={deviceActive || controlBusy}
                      className={scanProfile === p ? "active" : ""}
                      onClick={() => { setScanProfile(p); try { localStorage.setItem(PROFILE_KEY, p); } catch { setNotice("画质设置仅在本次打开期间保留"); } }}
                    >
                      {p === "small-2k" ? "标准 (平衡)" : p === "small" ? "流畅 (快速)" : "高清 (精细)"}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* 6. 快速入门帮助弹窗 */}
          {modal === "help" && (
            <>
              <p className="dialog-description">简单三步，完成空间扫描：</p>
              <p className="dialog-description">点云保留本次打开 App 后已接收的扫描区域，较亮部分为最近观测。断连、后台或中途接入前的区域不会自动补齐；完整成果请结束扫描后保存查看。</p>
              <ol className="help-steps">
                <li><b>连接设备</b><span>手机连接手持设备 Wi-Fi 热点。</span></li>
                <li><b>匀速行走</b><span>点击“开始扫描”，等待准备完成后平稳移动。</span></li>
                <li><b>保存成果</b><span>点击“结束并保存”并确认，设备保存成功后生成记录；可再下载到此 App。</span></li>
              </ol>
              <button className="primary full" onClick={() => setModal(null)}>我知道了<ArrowRight size={17} /></button>
            </>
          )}

        </Modal>
      )}

      {/* 教程弹窗 */}
      {tutorial !== null && (
        <Modal
          title={["第一次扫描，从这里开始", "怎样获得更完整的点云", "保存、下载与离线查看"][tutorial]}
          onClose={() => setTutorial(null)}
        >
          <div className="tutorial-guide">
          <p className="tutorial-intro">{[
            "连接 → 扫描 → 保存，跟着做就好。",
            "走得稳、补得全，点云更完整。",
            "保存在设备，下载后才能在手机离线看。",
          ][tutorial]}</p>
          <ol className="tutorial-steps">
            {(tutorial === 0 ? [
              ["连上 OMNI Wi-Fi", "在手机 Wi-Fi 设置中连接 OMNI，再回到工作台。"],
              ["点开始，先站稳", "点击“开始扫描”，保持稳定；显示“正在扫描”后再移动。"],
              ["扫完，确认保存", "点击“结束并保存”并确认，保存成功后再关闭设备。"],
            ] : tutorial === 1 ? [
              ["慢走，慢转弯", "稳稳拿住设备，避免突然转向或上下晃动。"],
              ["哪里有空缺，就补哪里", "观察点云，从不同角度补扫稀疏、空洞的位置。"],
              ["相机也要看得清", "切换相机画面，检查目标是否清楚。"],
            ] : [
              ["先存到设备", "结束扫描时确认保存，等待成功提示。"],
              ["想离线看？再下载", "连接设备，在“记录 → 设备项目”打开成果，点击“下载完整点云”。"],
              ["已有 PCD？直接导入", "点击记录页右上角的文件夹图标，选择 PCD 文件。"],
            ]).map(([title, text], i) => {
              const StepIcon = (tutorial === 0 ? [Wifi, Scan, Save] : tutorial === 1 ? [Timer, Box, Camera] : [HardDrive, Smartphone, FolderOpen])[i];
              return <li key={title}>
                <div className="tutorial-step-heading"><span className="tutorial-step-icon"><StepIcon size={22} aria-hidden="true" /></span><h3>{title}</h3><span className="tutorial-step-number" aria-label={`第 ${i + 1} 步`}>0{i + 1}</span></div>
                <p>{text}</p>
              </li>;
            })}
          </ol>
          </div>
        </Modal>
      )}
    </div>
  );
}
