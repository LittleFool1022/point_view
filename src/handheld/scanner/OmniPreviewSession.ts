import type { Channel } from "@foxglove/ws-protocol";
import { DEFAULT_DEVICE_PROFILE, type CameraDirection, type PointCloudData } from "../../domain/types";
import { FoxgloveSource, type FoxgloveSourceHandlers } from "../../transport/foxgloveSource";
import { OmniMotionTracker } from "./OmniMotionTracker";
import type { ScanWorkerInput, ScanWorkerOutput } from "./ScanPreviewAccumulator";
import type { IdentityConnectionResult } from "./PreviewDiscoveryBudget";

export const PREVIEW_STALE_MS = 3000;
export const PREVIEW_POINT_LIMIT = 120_000;
const CONNECT_TIMEOUT_MS = 8000;
const CONFIG_KEY = "omni-preview-connection-v1";

export interface PreviewConfig { wsUrl: string; pointCloudTopic: string }
export const DEFAULT_PREVIEW_CONFIG: PreviewConfig = {
  wsUrl: DEFAULT_DEVICE_PROFILE.wsUrl,
  pointCloudTopic: DEFAULT_DEVICE_PROFILE.topics.mergedPointCloud!,
};

export function browserPreviewConfig(config: PreviewConfig): PreviewConfig {
  const configuredUrl = config.wsUrl.replace(/\/$/, "");
  const defaultUrl = DEFAULT_PREVIEW_CONFIG.wsUrl.replace(/\/$/, "");
  if (location.port !== "5174" || configuredUrl !== defaultUrl) return config;
  const url = new URL("/omni-preview", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { ...config, wsUrl: url.href };
}

export function validatePreviewConfig(config: PreviewConfig): PreviewConfig {
  const url = new URL(config.wsUrl.trim());
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("请填写不含凭据或查询参数的 ws:// 或 wss:// 地址");
  }
  const topic = config.pointCloudTopic.trim();
  if (!/^\/[A-Za-z0-9_/]+$/.test(topic)) throw new Error("点云话题须以 / 开头，只包含英文、数字、下划线和斜杠");
  return { wsUrl: url.href, pointCloudTopic: topic };
}

export function readPreviewConfig(): PreviewConfig {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    return browserPreviewConfig(stored ? validatePreviewConfig(JSON.parse(stored)) : { ...DEFAULT_PREVIEW_CONFIG });
  } catch { return browserPreviewConfig({ ...DEFAULT_PREVIEW_CONFIG }); }
}

export function persistPreviewConfig(config: PreviewConfig): boolean {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); return true; }
  catch { return false; }
}

export interface PreviewSnapshot {
  connection: "offline" | "connecting" | "connected" | "error";
  detail: string;
  channels: Channel[];
  camera: CameraDirection;
  cloud: PointCloudData | null;
  cloudAt: number | null;
  sourcePointCount: number;
  imageUrl?: string;
  imageAt: number | null;
  sync: string | null;
  syncAt: number | null;
  speed: number | null;
  speedAt: number | null;
}

/** 只保留最近一帧的预览预算；它不是设备地图或完整录制。 */
export function limitPreviewCloud(cloud: PointCloudData): PointCloudData {
  const count = cloud.positions.length / 3;
  if (count <= PREVIEW_POINT_LIMIT) return cloud;
  const stride = Math.ceil(count / PREVIEW_POINT_LIMIT);
  const size = Math.ceil(count / stride);
  const positions = new Float32Array(size * 3);
  const colors = new Uint8Array(size * 3);
  const visible = new Uint8Array(size);
  const intensities = cloud.intensities ? new Float32Array(size) : undefined;
  for (let src = 0, dst = 0; src < count; src += stride, dst++) {
    positions.set(cloud.positions.subarray(src * 3, src * 3 + 3), dst * 3);
    colors.set(cloud.colors.subarray(src * 3, src * 3 + 3), dst * 3);
    visible[dst] = cloud.visible[src];
    if (intensities) intensities[dst] = cloud.intensities![src];
  }
  return { ...cloud, positions, colors, visible, intensities, sourcePointCount: count, sourcePointIndices: undefined };
}

export function previewFreshness(at: number | null, connected: boolean, now = Date.now()) {
  if (at === null) return "waiting";
  return connected && now - at < PREVIEW_STALE_MS ? "live" : "stale";
}

type SourceFactory = (config: PreviewConfig, handlers: FoxgloveSourceHandlers, camera: CameraDirection) => Pick<FoxgloveSource, "connect" | "disconnect">;
type AccumulatorPort = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;
type AccumulatorFactory = () => AccumulatorPort;

/** 消费主机现有数据，完全不发送 start/save/stop 或 ROS service 调用。 */
export class OmniPreviewSession {
  private snapshot: PreviewSnapshot = {
    connection: "offline", detail: "连接设备网络后，点击连接预览", channels: [], camera: "front",
    cloud: null, cloudAt: null, sourcePointCount: 0, imageAt: null, sync: null, syncAt: null, speed: null, speedAt: null,
  };
  private listeners = new Set<() => void>();
  private source?: ReturnType<SourceFactory>;
  private generation = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  private motion = new OmniMotionTracker();
  private accumulator?: AccumulatorPort;
  private scanEnabled = false;
  private scanEndpoint = "";
  private scanSession: string | null = null;
  private scanFrame = "";
  private scanWritable = false;
  private previousStartSession: string | null | undefined;
  private startFailed = false;
  private accumulationEpoch = 0;
  private token = "";
  private inputBusy = false;
  private pending?: PointCloudData;
  private connectedConfig?: PreviewConfig;

  constructor(private factory: SourceFactory = (config, handlers, camera) => new FoxgloveSource({
    ...DEFAULT_DEVICE_PROFILE, wsUrl: config.wsUrl,
    topics: { ...DEFAULT_DEVICE_PROFILE.topics, mergedPointCloud: config.pointCloudTopic, path: "" },
  }, handlers, camera, true), private accumulatorFactory: AccumulatorFactory = () =>
    new Worker(new URL("../../workers/scanPreview.worker.ts", import.meta.url), { type: "module" })) {}

  private resetAccumulation() {
    this.token = JSON.stringify([this.scanEndpoint, this.scanSession, this.scanFrame, ++this.accumulationEpoch]);
    this.inputBusy = false; this.pending = undefined;
    this.accumulator?.postMessage({ type: "reset", token: this.token } satisfies ScanWorkerInput);
    this.update({ cloud: null, cloudAt: null, sourcePointCount: 0 });
  }

  /** 必须在提交设备状态之前同步调用，未知状态仅冻结写入。 */
  setScanIdentity = (wsUrl: string, confirmedSession: string | null, writable: boolean): IdentityConnectionResult => {
    let sourceReconnected = false;
    const result = () => ({ sourceReconnected, connectionGeneration: this.generation });
    this.scanEnabled = true;
    const endpoint = new URL(wsUrl).href;
    if (endpoint !== this.scanEndpoint) {
      this.scanEndpoint = endpoint; this.scanSession = null; this.scanFrame = "";
      this.previousStartSession = undefined; this.startFailed = false; this.scanWritable = false;
      this.release(); this.resetAccumulation();
    }
    this.scanWritable = false;
    if (!writable || !confirmedSession || this.startFailed) return result();
    if (this.previousStartSession !== undefined && confirmedSession === this.previousStartSession) return result();
    this.previousStartSession = undefined;
    if (confirmedSession !== this.scanSession) {
      this.scanSession = confirmedSession; this.scanFrame = "";
      const reconnect = Boolean(this.source);
      this.release(); this.resetAccumulation();
      // 新会话重新订阅，旧连接已排队的点云不能归入新会话。
      if (reconnect && this.connectedConfig) { this.connect(this.connectedConfig); sourceReconnected = Boolean(this.source); }
    }
    this.scanWritable = true;
    return result();
  };

  getConnectionGeneration = () => this.generation;

  /** 仅重建预览发现，不重置累计地图，也不向设备发送控制动作。 */
  rediscoverPreview = () => {
    if (!this.connectedConfig) return false;
    this.connect(this.connectedConfig, this.snapshot.camera);
    return Boolean(this.source);
  };

  beginScan = (wsUrl: string, previousSession: string | null) => {
    this.setScanIdentity(wsUrl, null, false);
    this.startFailed = false;
    this.previousStartSession = previousSession;
    this.scanSession = null; this.scanFrame = "";
    this.release(); this.resetAccumulation();
  };

  rejectScanStart = () => {
    if (this.startFailed) return;
    this.startFailed = true; this.scanWritable = false;
    this.release(); this.resetAccumulation();
  };

  /** 用户主动返回已确认运行的扫描，允许从此刻重新接收，仍不回填旧数据。 */
  resumeConfirmedScan = () => { this.startFailed = false; this.previousStartSession = undefined; };

  private accumulate(cloud: PointCloudData) {
    if (!this.scanWritable || !this.scanSession || cloud.attributes?.frameIdDeclared !== true || !cloud.frameId.trim()) return;
    if (cloud.frameId !== this.scanFrame) {
      const changingFrame = Boolean(this.scanFrame);
      this.scanFrame = cloud.frameId;
      this.resetAccumulation();
      if (changingFrame && this.connectedConfig) {
        this.connect(this.connectedConfig);
        return;
      }
    }
    if (!this.accumulator) {
      this.accumulator = this.accumulatorFactory();
      this.accumulator.onmessage = ({ data }: MessageEvent<ScanWorkerOutput>) => {
        if (data.token !== this.token) return;
        if (data.type === "snapshot") {
          // 收到即 ACK；手势期间 Canvas 自己覆盖保存最新快照，不阻塞累计线程。
          this.accumulator?.postMessage({ type: "ack", token: this.token } satisfies ScanWorkerInput);
          if (this.scanWritable) this.update({ cloud: data.cloud });
        } else {
          this.inputBusy = false;
          const pending = this.pending; this.pending = undefined;
          if (pending) this.accumulate(pending);
        }
      };
      this.accumulator.onerror = () => {
        this.scanWritable = false;
        this.accumulator?.terminate(); this.accumulator = undefined;
        this.inputBusy = false; this.pending = undefined;
        this.update({ connection: "error", detail: "点云预览处理暂不可用，请重新连接" });
      };
      this.accumulator.postMessage({ type: "reset", token: this.token } satisfies ScanWorkerInput);
    }
    if (this.inputBusy) { this.pending = cloud; return; }
    this.inputBusy = true;
    this.accumulator.postMessage({ type: "frame", token: this.token, cloud } satisfies ScanWorkerInput,
      [cloud.positions.buffer, cloud.colors.buffer, cloud.visible.buffer, ...(cloud.intensities ? [cloud.intensities.buffer] : [])]);
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<PreviewSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private release() {
    this.motion.reset();
    this.generation++;
    clearTimeout(this.timeout);
    this.source?.disconnect();
    this.source = undefined;
  }
  connect = (input: PreviewConfig, camera = this.snapshot.camera) => {
    const config = validatePreviewConfig(input);
    this.connectedConfig = config;
    this.release();
    const generation = this.generation;
    const active = () => generation === this.generation;
    // 重连时保留最后一帧点云，时间戳会自然转为 stale，避免移动网络抖动时画布闪空。
    this.update({ connection: "connecting", detail: "正在连接预览服务…", channels: [], camera,
      imageUrl: undefined, imageAt: null, sync: null, syncAt: null, speed: null, speedAt: null });
    const fail = (detail: string) => {
      if (!active()) return;
      this.release();
      this.update({ connection: "error", detail, imageUrl: undefined });
    };
    const handlers: FoxgloveSourceHandlers = {
      onState: (state, detail) => {
        if (!active()) return;
        if (state === "connected") {
          clearTimeout(this.timeout);
          this.update({ connection: "connected", detail: "预览服务已连接，等待设备数据" });
        } else if (state === "error" || state === "idle") {
          fail(detail || "预览连接失败，请检查设备网络和预览服务");
        }
      },
      onPointCloud: (_stream, cloud) => {
        if (!active()) return;
        const count = cloud.positions.length / 3;
        if (this.scanEnabled) {
          if (!this.scanWritable) return;
          this.accumulate(cloud);
          if (active()) this.update({ cloudAt: Date.now(), sourcePointCount: count });
        } else this.update({ cloud: limitPreviewCloud(cloud), cloudAt: Date.now(), sourcePointCount: count });
      },
      onImageUrl: (direction, imageUrl) => {
        if (active() && direction === camera) this.update({ imageUrl, imageAt: Date.now() });
      },
      onSyncStatus: sync => { if (active()) this.update({ sync, syncAt: Date.now() }); },
      onPosition: () => {},
      onOdometry: sample => {
        if (!active()) return;
        const result = this.motion.sample(sample);
        if (result) this.update({ speed: result.speed, speedAt: result.speed === null ? null : Date.now() });
      },
      onChannels: channels => {
        if (!active()) return;
        const combined = new Map(this.snapshot.channels.map(channel => [channel.id, channel]));
        channels.forEach(channel => combined.set(channel.id, channel));
        this.update({ channels: [...combined.values()] });
      },
    };
    try {
      this.source = this.factory(config, handlers, camera);
      this.timeout = setTimeout(() => fail("连接超时，请确认已接入 OMNI 网络且预览服务已启动"), CONNECT_TIMEOUT_MS);
      this.source.connect();
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  clearCloud = () => { this.motion.reset(); this.resetAccumulation(); this.update({ speed: null, speedAt: null }); };

  dispose = () => {
    this.disconnect(); this.resetAccumulation();
    this.accumulator?.terminate(); this.accumulator = undefined;
    this.scanWritable = false;
  };

  disconnect = () => {
    this.release();
    // 历史点云可保留查看，但时间戳不刷新；断开不代表设备停止采集。
    this.update({ connection: "offline", detail: "预览已断开；设备采集状态未知", imageUrl: undefined, speed: null, speedAt: null });
  };
}
