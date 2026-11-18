export type DeviceAction = "start" | "pcd" | "stop";
export type ScanProfile = "small" | "small-2k" | "large";
export type DeviceState = "idle" | "starting" | "running" | "saving" | "stopping" | "degraded" | "unknown";

export interface ControlJob {
  id: string;
  action: DeviceAction;
  expected_session: string | null;
  state: "running" | "succeeded" | "warning" | "failed";
  started_at_ms: number;
  finished_at_ms: number | null;
  exit_code: number | null;
  message: string;
  result?: { session: string; path: string; bytes: number; points: number; sha256: string; backupVerified: boolean } | null;
}

export interface DeviceStatus {
  reachable: boolean;
  state: DeviceState;
  session: string | null;
  profile: string | null;
  components: Record<string, boolean>;
  accumulatedPoints?: number | null;
  storageFreeBytes?: number | null;
  previewReady: boolean;
  exportReady: boolean;
  actionsAllowed: boolean;
  job: ControlJob | null;
}

export const UNKNOWN_DEVICE_STATUS: DeviceStatus = {
  reachable: false, state: "unknown", session: null, profile: null,
  components: {}, previewReady: false, exportReady: false, actionsAllowed: false, job: null,
};

export interface ScanPointTotal { session: string | null; points: number | null }

/** 统计绑定主机会话；断线/缺报保留上次值，新会话不能继承旧扫描数量。 */
export function updateScanPointTotal(previous: ScanPointTotal, status: DeviceStatus): ScanPointTotal {
  if (!status.reachable || !status.session) return previous;
  // 启动预检期间可能仍存在上一轮状态目录，mapping 就绪前不能带回旧数量。
  if (status.job?.action === "start" && status.job.state === "running" && status.components.mapping !== true) return previous;
  const count = status.accumulatedPoints;
  return { session: status.session, points: typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count : previous.session === status.session ? previous.points : null };
}

export function controlUrlFromPreview(wsUrl: string): string {
  const url = new URL(wsUrl);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error("预览地址无效");
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  if (url.pathname === "/omni-preview" || url.pathname === "/omni-preview/") {
    url.pathname = "/omni-control";
    url.search = ""; url.hash = "";
    return url.href.replace(/\/$/, "");
  }
  url.port = "8766";
  url.pathname = ""; url.search = ""; url.hash = "";
  return url.href.replace(/\/$/, "");
}

async function requestJson<T>(url: string, init?: RequestInit, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
    const body = await response.json() as T & { message?: string };
    if (!response.ok) throw new Error(body.message || "设备请求未完成");
    return body;
  } finally { clearTimeout(timeout); }
}

export class OmniControlClient {
  async status(endpoint: string): Promise<DeviceStatus> {
    // 快速状态子进程上限 5 秒，离线连接不再占用旧的 20 秒请求窗口。
    const status = await requestJson<{ ok: boolean } & DeviceStatus>(`${endpoint}/api/v1/status`, undefined, 6500);
    // Waydroid 连接验收仅查看主机状态与预览，禁止页面自动启动真实采集。
    return new URLSearchParams(location.search).get("readonly") === "1"
      ? { ...status, actionsAllowed: false } : status;
  }

  action(endpoint: string, action: DeviceAction, expectedSession?: string | null, profile: ScanProfile = "small-2k"): Promise<{ job: ControlJob }> {
    if (new URLSearchParams(location.search).get("readonly") === "1") {
      return Promise.reject(new Error("当前为只读连接测试"));
    }
    return requestJson(`${endpoint}/api/v1/actions/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OMNI-App": "OMNI-Scan" },
      body: JSON.stringify({ expectedSession: expectedSession ?? null, profile }),
    });
  }
}
