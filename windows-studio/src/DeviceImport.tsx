import { useState } from "react";
import type { DeviceProject } from "./domain/device";
import type { OpenedInput } from "./domain/source";

export function DeviceImport({ busy, onClose, onReceive, onNotice }: {
  busy: boolean; onClose(): void; onReceive(file: OpenedInput): Promise<void>; onNotice(message: string): void;
}) {
  const [origin, setOrigin] = useState("http://10.42.0.1:8766");
  const [projects, setProjects] = useState<DeviceProject[]>([]);
  const [listedOrigin, setListedOrigin] = useState("");
  const [working, setWorking] = useState(false), [message, setMessage] = useState("");
  async function refresh() {
    if (!window.surveyDesktop) return;
    setWorking(true); setMessage("正在读取已保存的扫描");
    try {
      const next = await window.surveyDesktop.deviceProjects(origin);
      setProjects(next); setListedOrigin(origin); setMessage(next.length ? "选择扫描，接收完整点云后可离线处理。" : "设备暂无已保存的扫描。");
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  }
  async function receive(project: DeviceProject) {
    if (!window.surveyDesktop) return;
    setWorking(true); setMessage("正在接收完整点云并校验");
    const unsubscribe = window.surveyDesktop.onProgress(setMessage);
    try {
      const file = await window.surveyDesktop.deviceReceive(listedOrigin, project.id);
      await onReceive(file); onNotice(file.native?.keyframePages?.length ? `完整点云及 ${file.native.keyframePages.length} 卷原图已接收并校验，可离线处理。` : project.keyframesState==="invalid" ? "完整点云已接收；设备原图附件缺失或损坏，需检查附件。" : "设备完整点云已接收并校验，可断开设备继续处理。"); onClose();
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { unsubscribe(); setWorking(false); }
  }
  return <div className="device-import-backdrop"><section className="device-import" role="dialog" aria-modal="true" aria-label="从设备接收">
    <h2>从 OMNI 接收</h2>
    <label>设备地址<input aria-label="设备地址" value={origin} disabled={working || busy} onChange={e => { setOrigin(e.target.value); setProjects([]); setListedOrigin(""); }}/></label>
    <div className="device-import-actions"><button disabled={working || busy} onClick={() => void refresh()}>读取扫描列表</button>
      <button disabled={working || busy} onClick={onClose}>关闭</button>
      {working && <button onClick={() => void window.surveyDesktop?.cancel()}>取消接收</button>}</div>
    {message&&<p role="status">{message}</p>}
    <div className="device-projects">{projects.map(p => <article key={p.id}><strong>{p.fileName}</strong>
      <span>{p.points.toLocaleString()} 点 · {(p.bytes / 1024 ** 2).toFixed(1)} MiB · {p.keyframeSets?.length??0} 卷原图 · {p.captureIntegrity === "passed" ? "采集完整性检查通过" : p.captureIntegrity === "warning" ? "采集完整性有告警" : "采集完整性待核实"}</span>
      <button disabled={working || busy || listedOrigin !== origin} onClick={() => void receive(p)}>接收并导入</button></article>)}</div>
  </section></div>;
}
