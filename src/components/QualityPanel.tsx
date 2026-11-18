import { Download, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { QUALITY_PROFILE_IDS, QUALITY_PROFILES } from "../quality/profiles";
import type { QualityMetric, QualityProfileId, QualityReport } from "../quality/types";

interface Props {
  report?: QualityReport;
  analyzing: boolean;
  error?: string;
  profileId: QualityProfileId;
  onProfileChange(profile: QualityProfileId): void;
  onExport(): void;
  onReview(): void;
  onClose(): void;
}

function formatValue(metric: QualityMetric): string {
  if (metric.value === null) return "无法评估";
  if (metric.unit === "ratio") return `${(metric.value * 100).toFixed(metric.value >= 0.1 ? 1 : 2)}%`;
  if (metric.unit === "m") return metric.value < 1 ? `${(metric.value * 100).toFixed(2)} cm` : `${metric.value.toFixed(3)} m`;
  if (metric.unit === "bool") return metric.value ? "是" : "否";
  return Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(3);
}

const FINDING_COPY: Record<string, [string, string]> = {
  finiteRatio: ["有些点的坐标无效", "回到空间检查缺失区域，必要时重新导出源文件。"],
  outlierRatio: ["可能有散落的点", "转动空间，看看墙面或地面之外是否有零散点。"],
  densityCv: ["点的分布疏密不太均匀", "放大你关心的位置，确认轮廓是否看得清。"],
  roughnessP90M: ["局部表面起伏较大", "查看原本平整的墙面；真实曲面也会出现这个提示。"],
  rgbCoverageRatio: ["颜色信息不完整", "切换到高度着色，继续查看空间形状。"],
  darkPointRatio: ["部分区域颜色偏暗", "切换着色方式查看细节；仅凭点云不能判断拍摄曝光。"],
  brightPointRatio: ["部分区域颜色偏亮", "查看该区域的轮廓，结合原始照片判断。"],
  colorCastRatio: ["整体颜色偏向某个色调", "对照真实场景判断，也可能只是物体本来的颜色。"],
  duplicateRatio: ["存在重叠采样", "同一位置有重复点，查看时留意局部密集区域。"],
  primaryGridOccupancy: ["空间分布较集中", "确认你需要的区域是否包含在文件里；这不代表一定漏扫。"],
};

export function QualityPanel({ report, analyzing, error, profileId, onProfileChange, onExport, onReview, onClose }: Props) {
  const findings = report?.metrics.filter(metric => metric.status === "fail" || metric.status === "warn")
    .sort((a, b) => Number(b.status === "fail") - Number(a.status === "fail")) ?? [];
  return <section className="settings-drawer quality-drawer panel-glass" aria-label="点云质量评估">
    <header>
      <div><ShieldCheck /><strong>空间检查</strong></div>
      <button className="icon-button" aria-label="关闭质量检查" title="关闭" onClick={onClose}><X /></button>
    </header>

    {analyzing && <div className="quality-empty"><LoaderCircle className="quality-spinner" /><strong>正在看看这份空间数据</strong><span>检查结果会显示在这里</span></div>}
    {!analyzing && error && <div className="quality-empty error"><strong>暂时无法检查</strong><details><summary>查看原因</summary><p>{error}</p></details></div>}
    {!analyzing && !error && !report && <div className="quality-empty"><strong>先打开你的空间</strong><span>导入 PCD 文件后自动检查；其他格式可继续浏览和出图。</span></div>}

    {!analyzing && !error && report && <>
      <div className="quality-reading">
        <strong>{findings.length ? "有几处值得看看" : "已完成文件检查"}</strong>
        <p>{findings.length ? "这些提示帮助你决定下一步，点击下方按钮回到空间查看。" : "已检查的指标未触发提醒，可以回到空间继续查看轮廓与细节。"}</p>
        <small>{report.source.samplingRatio < 1 ? "抽样检查" : "检查了"} {report.source.analyzedPointCount.toLocaleString()} 个点</small>
      </div>
      <div className="quality-source"><span title={report.source.fileName}>{report.source.fileName}</span></div>
      <div className="quality-findings">
        {findings.slice(0, 3).map(metric => <article key={metric.id}>
          <strong>{FINDING_COPY[metric.id]?.[0] ?? `${metric.label}需要留意`}</strong>
          <p>{FINDING_COPY[metric.id]?.[1] ?? metric.evidence}</p>
        </article>)}
        {findings.length > 3 && <small>还有 {findings.length - 3} 项提示，可在详细指标中查看。</small>}
      </div>
      <p className="quality-limits">结果来自导入文件，不随编辑自动重算。无法确认拼接精度、采集同步和空间是否完整；重要尺寸请实测复核。</p>
      <button className="quality-review" onClick={onReview}>回到空间查看</button>
      <details className="quality-details">
        <summary>详细指标与检查标准</summary>
        <label className="quality-profile"><span>检查标准</span><select aria-label="质量检查标准" value={profileId} onChange={(event) => onProfileChange(event.target.value as QualityProfileId)}>
          {QUALITY_PROFILE_IDS.map(id => <option key={id} value={id}>{QUALITY_PROFILES[id].name}</option>)}
        </select></label>
        <p>{report.deliveryStatus.reason}</p>
        <div className="quality-metrics">
          {report.metrics.map(metric => <article key={metric.id} className={metric.status}>
            <div><strong>{metric.label}</strong><span>{formatValue(metric)}</span></div>
            <small>{metric.status === "fail" ? "需关注" : metric.status === "warn" ? "建议查看" : metric.status === "unavailable" ? "缺少依据" : "已检查"} · {metric.evidence}</small>
          </article>)}
        </div>
      </details>
      <footer>
        <button className="quality-export" onClick={onExport}><Download />导出报告</button>
      </footer>
    </>}
  </section>;
}
