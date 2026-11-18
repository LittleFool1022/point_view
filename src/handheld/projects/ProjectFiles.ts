import { createStore, get, set } from "idb-keyval";
import type { CloudReceipt } from "../cloud/CloudUploadClient";
import type { DemoProject } from "../demoData";
import type { PointCloudData } from "../../domain/types";

export type ProjectVideoState = "complete" | "partial" | "invalid" | "unavailable";

export interface ProjectVideo {
  fileName: string;
  bytes: number;
  sha256: string;
  frames: number;
  durationSourceS: number;
  codec: Record<string, unknown>;
  sourceGaps?: unknown[];
  qualityVerified: false;
}

export interface DeviceProject extends DemoProject {
  fileName?: string;
  bytes?: number;
  sha256?: string;
  sourcePoints?: number;
  previewCached?: boolean;
  cloudReceipt?: CloudReceipt;
  cloudPending?: string;
  videoState?: ProjectVideoState;
  video?: ProjectVideo | null;
}
export interface ProjectDescriptor {
  id: string;
  fileName: string;
  bytes: number;
  points: number;
  sha256: string;
  createdAtMs: number;
  videoState?: ProjectVideoState;
  video?: ProjectVideo | null;
}
const files = createStore("omni-scan-project-files-v1", "files");
const key = (id: string, preview: boolean) => `${preview ? "preview" : "full"}:${id}`;
export const cachedProject = (id: string, preview = false) => get<Blob>(key(id, preview), files);
export const cacheProject = (id: string, blob: Blob, preview = false) => set(key(id, preview), blob, files);

const descriptorCache = new Map<string, ProjectDescriptor>();
const descriptorListeners = new Set<() => void>();

export function subscribeProjectDescriptors(listener: () => void): () => void {
  descriptorListeners.add(listener);
  return () => {
    descriptorListeners.delete(listener);
  };
}

export function isCompleteProjectVideo(video: unknown): video is ProjectVideo {
  if (!video || typeof video !== "object") return false;
  const candidate = video as Record<string, unknown>;
  if (candidate.sourceGaps !== undefined && !Array.isArray(candidate.sourceGaps)) {
    return false;
  }
  return (
    candidate.fileName === "walkthrough.mp4" &&
    typeof candidate.bytes === "number" &&
    Number.isFinite(candidate.bytes) &&
    candidate.bytes > 0 &&
    typeof candidate.sha256 === "string" &&
    candidate.sha256.length > 0 &&
    typeof candidate.frames === "number" &&
    Number.isFinite(candidate.frames) &&
    candidate.frames > 0 &&
    typeof candidate.durationSourceS === "number" &&
    Number.isFinite(candidate.durationSourceS) &&
    candidate.durationSourceS >= 0 &&
    Boolean(candidate.codec) &&
    typeof candidate.codec === "object" &&
    candidate.qualityVerified === false
  );
}

export function resolveProjectVideo(
  project: Pick<DeviceProject, "id" | "location" | "videoState" | "video">,
): { videoState: ProjectVideoState; video: ProjectVideo | null } {
  if (!project.id || project.id.startsWith("import-") || project.location === "本地导入") {
    return { videoState: "unavailable", video: null };
  }
  const cached = descriptorCache.get(project.id);
  const rawState = project.videoState ?? cached?.videoState;
  const rawVideo = project.video !== undefined ? project.video : (cached?.video ?? null);

  if (rawState === "complete" || rawState === "partial") {
    if (isCompleteProjectVideo(rawVideo)) {
      const hasGaps = Array.isArray(rawVideo.sourceGaps) && rawVideo.sourceGaps.length > 0;
      const effectiveState: ProjectVideoState =
        rawState === "partial" || hasGaps ? "partial" : "complete";
      return {
        videoState: effectiveState,
        video: {
          ...rawVideo,
          qualityVerified: false,
        },
      };
    }
    return { videoState: "invalid", video: null };
  }
  if (rawState === "invalid") {
    return { videoState: "invalid", video: null };
  }
  return { videoState: "unavailable", video: null };
}

export function projectVideoUrl(endpoint: string, id: string): string {
  return `${endpoint.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(id)}/video`;
}

export async function listProjects(endpoint: string, signal: AbortSignal): Promise<ProjectDescriptor[]> {
  const response = await fetch(`${endpoint}/api/v1/projects`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("设备项目列表暂不可用");
  const projects = (await response.json() as { projects: ProjectDescriptor[] }).projects;
  if (Array.isArray(projects)) {
    descriptorCache.clear();
    for (const item of projects) {
      if (item && typeof item.id === "string") {
        descriptorCache.set(item.id, item);
      }
    }
    for (const listener of descriptorListeners) {
      listener();
    }
  }
  return projects;
}

export async function fetchProject(endpoint: string, id: string, preview: boolean, signal: AbortSignal,
  progress: (percent: number, received?: number, total?: number) => void): Promise<Blob> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  const armTimeout = (milliseconds: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  // 等待响应和流停滞有上限；有数据持续到达时允许大文件继续传输。
  armTimeout(10000);
  try {
    let response: Response;
    try {
      response = await fetch(`${endpoint}/api/v1/projects/${encodeURIComponent(id)}/${preview ? "preview" : "file"}`, { signal: controller.signal, cache: "no-store" });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(timedOut ? "设备响应超时，请重试" : "无法连接设备，请确认已连接 OMNI 网络");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string } | null;
      throw new Error(response.status === 404 && body?.message === "接口不存在"
        ? "设备下载服务尚未就绪" : response.status === 404 ? "设备上未找到该项目文件，请检查保存结果" : "设备暂时无法提供文件，请重试");
    }
    const length = Number(response.headers.get("Content-Length"));
    if (length > 512 * 1024 * 1024) throw new Error("文件过大，请在电脑中打开");
    if (!response.body) throw new Error("项目文件未返回");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    try {
      while (true) {
        armTimeout(20000);
        const { done, value } = await reader.read().catch(error => {
          if (signal.aborted) throw error;
          throw new Error(timedOut ? "下载长时间无进展，请重试" : "下载连接中断，请重试");
        });
        if (done) break;
        received += value.byteLength;
        if (received > 512 * 1024 * 1024) throw new Error("文件过大，请在电脑中打开");
        chunks.push(value as Uint8Array<ArrayBuffer>);
        progress(length ? Math.min(100, Math.floor(received * 100 / length)) : 0, received, length);
      }
      if (length && received !== length) throw new Error("下载未完成，请重试");
    } finally { reader.releaseLock(); }
    return new Blob(chunks, { type: "application/octet-stream" });
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal.removeEventListener("abort", abort);
  }
}

export function decodeProject(blob: Blob, id: string, expectedSha: string | undefined, signal: AbortSignal, maxPoints: number | null = 1_000_000): Promise<{ cloud: PointCloudData; sha256: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./project.worker.ts", import.meta.url), { type: "module" });
    const finish = () => { signal.removeEventListener("abort", abort); worker.terminate(); };
    const abort = () => { finish(); reject(new DOMException("已取消", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
    worker.onerror = () => { finish(); reject(new Error("点云读取失败")); };
    if (signal.aborted) { abort(); return; }
    worker.postMessage({ blob, id, expectedSha, maxPoints });
  });
}
