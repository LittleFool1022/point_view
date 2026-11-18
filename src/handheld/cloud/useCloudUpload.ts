import { useEffect, useRef, useState } from "react";
import { cacheProject, cachedProject, decodeProject, fetchProject, type DeviceProject } from "../projects/ProjectFiles";
import { readCloudEndpoint, uploadPointCloud, type CloudConfig, type CloudReceipt } from "./CloudUploadClient";

export type UploadPhase = "downloading" | "checking" | "uploading" | "verifying" | "paused" | "failed" | "succeeded";
export interface CloudTask { projectId: string; phase: UploadPhase; percent: number; message: string }
export function hasCloudReceipt(project: DeviceProject, endpoint: string): boolean {
  const receipt = project.cloudReceipt;
  return !!receipt && receipt.endpoint === endpoint && receipt.sha256 === project.sha256 && receipt.bytes === project.bytes;
}
export function useCloudUpload(onPatch: (id: string, patch: Partial<DeviceProject>) => void) {
  const [config, setConfig] = useState<CloudConfig>(() => ({ endpoint: readCloudEndpoint(), token: "" }));
  const [task, setTask] = useState<CloudTask>();
  const request = useRef<AbortController | null>(null);
  const patchRef = useRef(onPatch); patchRef.current = onPatch;
  useEffect(() => () => request.current?.abort(), []);
  const busy = !!task && !["paused", "failed", "succeeded"].includes(task.phase);
  const start = async (project: DeviceProject, deviceEndpoint: string, deviceOnline: boolean) => {
    if (request.current || !config.endpoint) return;
    const abort = new AbortController(); request.current = abort;
    const active = { ...config };
    const update = (phase: UploadPhase, percent: number, message: string) => setTask({ projectId: project.id, phase, percent, message });
    patchRef.current(project.id, { cloudPending: active.endpoint });
    try {
      update("checking", 0, "正在准备完整点云…");
      let blob = await cachedProject(project.id);
      if (!blob) {
        if (!deviceOnline) throw new Error("请先连接设备下载完整点云；已有离线文件可直接上云");
        update("downloading", 0, "正在从设备取得完整点云…");
        blob = await fetchProject(deviceEndpoint, project.id, false, abort.signal,
          percent => update("downloading", percent, `准备完整文件 ${percent}%`));
      }
      if (abort.signal.aborted) throw new DOMException("已暂停", "AbortError");
      update("checking", 0, "正在校验完整文件…");
      // 只取一个点用于解析校验；上传仍使用完整 Blob，不复制预览显示预算。
      const verified = await decodeProject(blob, project.id, project.sha256, abort.signal, 1);
      try { await cacheProject(project.id, blob); patchRef.current(project.id, { local: true, previewCached: true }); } catch { /* 本次仍可上传；不声称离线缓存成功。 */ }
      const file = { projectId: project.id, name: project.name, fileName: project.fileName || `${project.id}.pcd`, bytes: blob.size,
        sha256: verified.sha256, points: verified.cloud.sourcePointCount || 0 };
      patchRef.current(project.id, { sha256: file.sha256, bytes: file.bytes });
      const receipt: CloudReceipt = await uploadPointCloud(active, file, blob, abort.signal,
        (phase, percent) => update(phase, percent, phase === "verifying" ? "云端正在校验完整文件…" : `正在上云 ${percent}%`));
      patchRef.current(project.id, { cloudReceipt: receipt, uploaded: true, cloudPending: undefined });
      update("succeeded", 100, "上云完成，完整点云已通过云端校验");
    } catch (error) {
      update(abort.signal.aborted ? "paused" : "failed", 0, abort.signal.aborted ? "上云已暂停，可稍后继续"
        : error instanceof Error ? error.message : "上云未完成，请稍后继续");
    } finally { request.current = null; }
  };
  return { config, setConfig, task, busy, start, pause: () => request.current?.abort() };
}
