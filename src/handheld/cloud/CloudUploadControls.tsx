import { useState } from "react";
import { CloudUpload, Check, Pause } from "lucide-react";
import type { DeviceProject } from "../projects/ProjectFiles";
import { saveCloudEndpoint, validateCloudEndpoint, type CloudConfig } from "./CloudUploadClient";
import { hasCloudReceipt, type CloudTask } from "./useCloudUpload";

export interface CloudUploadControlsProps {
  project: DeviceProject; endpoint: string; task?: CloudTask; busy: boolean; onUpload(): void; onPause(): void;
}
export function CloudUploadControls({ project, endpoint, task, busy, onUpload, onPause }: CloudUploadControlsProps) {
  const current = task?.projectId === project.id ? task : undefined;
  const active = current && !["paused", "failed", "succeeded"].includes(current.phase);
  const complete = hasCloudReceipt(project, endpoint);
  return <div className="cloud-upload-control">
    {active ? <button className="secondary" onClick={onPause}><Pause size={17} />暂停上云</button>
      : <button className={complete ? "secondary" : "primary"} disabled={busy || complete} onClick={onUpload}>
        {complete ? <Check size={17} /> : <CloudUpload size={17} />}{complete ? "已上云" : project.cloudPending === endpoint || current?.phase === "failed" || current?.phase === "paused" ? "继续上云" : "一键上云"}
      </button>}
    {current && <span role="status">{current.message}</span>}
    {active && (current.phase === "uploading" || current.phase === "downloading") && <progress aria-label="上云任务进度" max={100} value={current.percent} />}
  </div>;
}
export function CloudConfigForm({ config, busy, onSave }: { config: CloudConfig; busy: boolean; onSave(value: CloudConfig): void }) {
  const [endpoint, setEndpoint] = useState(config.endpoint);
  const [token, setToken] = useState(config.token);
  const [error, setError] = useState("");
  return <form onSubmit={event => {
    event.preventDefault();
    try { const next = validateCloudEndpoint(endpoint); saveCloudEndpoint(next); onSave({ endpoint: next, token: token.trim() }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "云服务设置未保存"); }
  }}>
    <p className="dialog-description">上传完整 PCD，不改变设备文件。请使用你管理或信任的云服务地址。</p>
    <label className="field-label" htmlFor="cloud-endpoint">云服务地址</label>
    <input id="cloud-endpoint" className="text-input" placeholder="HTTPS 云服务地址" value={endpoint} onChange={event => setEndpoint(event.target.value)} autoCapitalize="none" spellCheck={false} required disabled={busy} />
    <label className="field-label" htmlFor="cloud-token">访问凭证（Bearer Token）</label>
    <input id="cloud-token" className="text-input" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} disabled={busy} />
    <p className="dialog-description">凭证仅本次打开有效，重开 App 后需重新填写。未配置云服务时不会发送文件。</p>
    {error && <p role="alert">{error}</p>}
    <button className="primary full" type="submit" disabled={busy}>保存云服务设置</button>
  </form>;
}
