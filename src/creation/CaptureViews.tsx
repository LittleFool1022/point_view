import { useEffect, useRef, useState } from "react";
import type { CaptureAttachment } from "./types";
import { parseCapture, sha256 } from "./capture";
export { parseCapture } from "./capture";

/** 原图与标定归属于作品，预览 URL 只在组件生命周期内存在。 */
export function CaptureViews({ sourceName, sourceBlob, value, onChange, onBusyChange }: {
  sourceName: string; sourceBlob?: Blob; value?: CaptureAttachment;
  onChange(value: CaptureAttachment): void; onBusyChange?(busy: boolean): void;
}) {
  const [items, setItems] = useState<{ url: string; name: string }[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    const next = value?.manifest.views.map(view => ({ name: view.image, url: URL.createObjectURL(value.images[view.image]!) })) ?? [];
    setItems(next);
    return () => next.forEach(item => URL.revokeObjectURL(item.url));
  }, [value]);
  async function load(files: File[]) {
    const version = ++generation.current;
    setBusy(true); onBusyChange?.(true); setMessage("正在核对原始点云与附件…");
    try {
      const manifests = files.filter(f => f.name === "capture.views.json");
      if (manifests.length !== 1 || manifests[0]!.size > 4 * 1024 * 1024) throw new Error("请选择包含 capture.views.json 和 images 的采集附件目录。");
      const manifestFile = manifests[0]!;
      const capture = parseCapture(JSON.parse(await manifestFile.text()));
      if (capture.pcd.name !== sourceName.split(/[\\/]/).at(-1)) throw new Error("附件对应另一份 PCD。");
      if (!sourceBlob || sourceBlob.size > 1024 ** 3) throw new Error("请先导入不超过 1 GiB 的原始 PCD，再关联新附件。已保存的图片仍然保留。");
      if (await sha256(sourceBlob) !== capture.pcd.sha256) throw new Error("PCD 校验不符，不能关联这些图片。");
      const root = manifestFile.webkitRelativePath.slice(0, -manifestFile.name.length);
      const selected = new Map(files.map(file => [file.webkitRelativePath, file]));
      let bytes = 0;
      const images: Record<string, Blob> = {};
      for (let i = 0; i < capture.views.length; i++) {
        const view = capture.views[i]!;
        if (generation.current !== version) return;
        setMessage(`正在检查图片 ${i + 1} / ${capture.views.length}`);
        const file = selected.get(root + view.image);
        if (!file || file.size > 16 * 1024 * 1024 || (bytes += file.size) > 256 * 1024 * 1024) throw new Error("图片缺失或超过预算（单图 16 MiB、合计 256 MiB）。");
        if (await sha256(file) !== view.sha256) throw new Error(`图片校验失败：${view.image}`);
        const bitmap = await createImageBitmap(file);
        const matches = bitmap.width === capture.calibration.width && bitmap.height === capture.calibration.height;
        bitmap.close();
        if (!matches) throw new Error(`图片尺寸与标定不符：${view.image}`);
        images[view.image] = file;
      }
      if (generation.current !== version) return;
      onChange({ manifest: capture, images, alignment: "unverified", association: "pcd_verified" });
      setMessage("原图与完整拍摄资料已加入作品，将随草稿和工程保存。");
    } catch (error) { if (generation.current === version) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (generation.current === version) { setBusy(false); onBusyChange?.(false); } }
  }
  return <details className="object-details"><summary>原图素材{value ? ` · ${value.manifest.views.length} 张` : ""}</summary>
    <p>导入采集附件目录。替换失败时保留已有素材。</p>
    <input aria-label="导入采集视角附件" type="file" ref={element => { element?.setAttribute("webkitdirectory", ""); }} multiple disabled={busy} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void load(files); }} />
    <p role="status">{message}</p>
    {value && <p>{value.association === "pcd_verified" ? "原图与原始 PCD 文件关联已校验；" : "原图已校验，PCD 关联沿用工程记录；"}{value.manifest.pose_space === "raw" ? "拍摄位姿尚未转换到导出点云坐标。" : "图片与物体的空间对齐尚未核验。"}当前 GLB 使用扫描颜色，尚未使用原图贴图。</p>}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>{items.map(item => <a key={item.name} href={item.url} target="_blank" rel="noreferrer" title="查看原图"><img src={item.url} alt={item.name} loading="lazy" style={{ width: "100%", borderRadius: 6 }} /></a>)}</div>
  </details>;
}
