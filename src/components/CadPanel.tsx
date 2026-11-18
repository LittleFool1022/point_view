import {
  AlertTriangle, Box, CheckCircle2, Crosshair, Download, FileArchive, Info, Layers3, LoaderCircle,
  Ruler, ScanLine, ShieldCheck, SlidersHorizontal, Trash2, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { PointCloudData } from "../domain/types";
import {
  type CadAnnotation,
  type CadDrawingSettings,
  type CadPaperSize,
  type DrawingModel,
} from "../cad/model";
import type { CadProjection, CadSummary } from "../cad/geometry";
import type { CadExportedFile } from "../cad/package";
import { CadPreview } from "./CadPreview";
import type { CadLinkController } from "./useCadLinking";

export type CadWorkflowView =
  | { status: "idle"; model?: DrawingModel; stale?: boolean }
  | { status: "preparing"; progress: number; stage: string; model?: DrawingModel }
  | { status: "preview-ready"; model: DrawingModel; stale: boolean }
  | { status: "exporting"; progress: number; stage: string; model: DrawingModel }
  | { status: "completed"; model: DrawingModel; files: CadExportedFile[] }
  | { status: "cancelled"; model?: DrawingModel }
  | { status: "error"; error: string; model?: DrawingModel };

interface CadPanelProps {
  lightMode?: boolean;
  cloud: PointCloudData;
  summary?: CadSummary;
  projection: CadProjection;
  selectedCount: number;
  topTolerance: number;
  settings: CadDrawingSettings;
  annotations: CadAnnotation[];
  workflow: CadWorkflowView;
  sourceStale: boolean;
  link: CadLinkController;
  onProjectionChange(projection: CadProjection): void;
  onSettingsChange(settings: CadDrawingSettings): void;
  onAnnotationsChange(annotations: CadAnnotation[]): void;
  onRemoveCeiling(tolerance: number): void;
  onPreparePreview(): void;
  onCancel(): void;
  onExportStandardDrawing(): void;
  onClose(): void;
}

const format = (value: number | undefined, digits = 2) => value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ANNOTATION_CATEGORY_LABELS: Record<NonNullable<CadAnnotation["category"]>, string> = {
  text: "文字",
  room: "房间",
  door: "门",
  window: "窗",
};

export function CadPanel({
  cloud, summary, projection, selectedCount, topTolerance, settings, annotations, workflow, sourceStale, link, lightMode = false,
  onProjectionChange, onSettingsChange, onAnnotationsChange,
  onRemoveCeiling, onPreparePreview, onCancel, onExportStandardDrawing, onClose,
}: CadPanelProps) {
  const [annotationText, setAnnotationText] = useState("");
  const [annotationCategory, setAnnotationCategory] = useState<NonNullable<CadAnnotation["category"]>>("text");
  const [placingAnnotation, setPlacingAnnotation] = useState<Pick<CadAnnotation, "text" | "category">>();
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const [inspectorTab, setInspectorTab] = useState<"drawing" | "evidence" | "review">("drawing");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const model = workflow.model;
  const stale = sourceStale || (workflow.status === "preview-ready" && workflow.stale);
  const busy = workflow.status === "preparing" || workflow.status === "exporting";
  const canExport = Boolean(model) && !stale && !busy && workflow.status !== "error";
  const visibleCount = selectedCount || cloud.visible.reduce((count, value) => count + (value ? 1 : 0), 0);
  const reviewWarnings = model?.warnings.filter((item) => item.severity === "warning") ?? [];
  const processNotes = model?.warnings.filter((item) => item.severity !== "warning") ?? [];
  const projectionAnnotations = annotations.filter((annotation) => !annotation.projection || annotation.projection === projection);
  const updateSettings = (patch: Partial<CadDrawingSettings>) => onSettingsChange({ ...settings, ...patch });

  useEffect(() => {
    setPlacingAnnotation(undefined);
    setSelectedAnnotationId(undefined);
  }, [model?.drawingId, projection]);

  const startAnnotationPlacement = () => {
    const text = annotationText.trim();
    if (!text || !model || stale || busy) return;
    setPlacingAnnotation({ text, category: annotationCategory });
    link.clear();
    setSettingsOpen(false);
  };

  const placeAnnotation = ([x, y]: [number, number]) => {
    if (!placingAnnotation) return;
    const id = crypto.randomUUID();
    onAnnotationsChange([...annotations, {
      id,
      text: placingAnnotation.text,
      category: placingAnnotation.category,
      x,
      y,
      coordinateSpace: "drawing-mm",
      projection,
    }]);
    setSelectedAnnotationId(id);
    setPlacingAnnotation(undefined);
    setAnnotationText("");
  };

  const updateAnnotation = (target: CadAnnotation, patch: Partial<CadAnnotation>) => {
    onAnnotationsChange(annotations.map((annotation) => annotation === target ? { ...annotation, ...patch } : annotation));
  };

  const moveAnnotation = (id: string, [x, y]: [number, number]) => {
    onAnnotationsChange(annotations.map((annotation) => annotation.id === id
      ? { ...annotation, x, y, coordinateSpace: "drawing-mm", projection }
      : annotation));
  };

  const deleteAnnotation = (id: string) => {
    onAnnotationsChange(annotations.filter((annotation) => annotation.id !== id));
    if (selectedAnnotationId === id) setSelectedAnnotationId(undefined);
  };

  return <section
    className="cad-drawer cad-workspace panel-glass"
    aria-label="CAD 与测量"
    onKeyDownCapture={(event) => {
      if (event.key !== "Escape" || !placingAnnotation) return;
      event.stopPropagation();
      setPlacingAnnotation(undefined);
    }}
  >
    <header className="cad-workspace-header">
      <div><ScanLine /><span><strong>空间图纸</strong><small>让空间成为你的作品</small></span></div>
      <div className="cad-workflow-badge" data-status={workflow.status}>
        {busy ? <LoaderCircle className="cad-spin" /> : model && !stale ? <CheckCircle2 /> : <Info />}
        {workflow.status === "preparing" ? workflow.stage : workflow.status === "exporting" ? workflow.stage : stale ? "预览已过期" : model ? "预览可导出" : "等待预览"}
      </div>
      <div className="cad-header-actions"><button className="cad-settings-toggle" aria-expanded={settingsOpen} aria-controls="cad-parameters" onClick={() => setSettingsOpen(value => !value)}><SlidersHorizontal size={15} />设置</button><button className="icon-button" aria-label="关闭 CAD 测量" title="关闭图纸，回到空间" onClick={onClose}><X size={17} /></button></div>
    </header>

    <div className="cad-link-toolbar" role="group" aria-label="空间图纸联动">
      <button aria-pressed={link.follow} disabled={!link.enabled} title="点击后平移另一侧视图，保留方向与缩放；悬停只高亮" onClick={() => link.setFollow(!link.follow)}>点击随动{link.follow ? " · 开" : " · 关"}</button>
      <button disabled={!link.canLocate} onClick={link.locate}><Crosshair size={14} />定位关联</button>
      <button disabled={!link.hasSelection} onClick={link.clear}>清除高亮</button>
    </div>
    <div className="cad-workspace-body">
      <section className="cad-preview-pane" aria-label="CAD 成果预览">
        <CadPreview
          lightMode={lightMode}
          model={model}
          link={{ ...link.cad, enabled: link.enabled && !placingAnnotation }}
          stale={stale}
          projection={projection}
          annotations={annotations}
          placingAnnotation={placingAnnotation}
          selectedAnnotationId={selectedAnnotationId}
          onPlaceAnnotation={placeAnnotation}
          onMoveAnnotation={moveAnnotation}
          onDeleteAnnotation={deleteAnnotation}
          onSelectedAnnotationChange={(id) => { setSelectedAnnotationId(id); if (id) link.clear(); }}
        />
      </section>

      <aside id="cad-parameters" className={`cad-parameter-panel ${settingsOpen ? "is-open" : ""}`} aria-label="CAD 出图参数" hidden={!settingsOpen}>
        <div className="cad-inspector-head">
          <div className="cad-projection-tabs" role="group" aria-label="CAD 投影视图">
            {(["xy", "xz", "yz"] as const).map((item) => <button key={item} className={projection === item ? "active" : ""} aria-pressed={projection === item} onClick={() => onProjectionChange(item)} disabled={busy}>{item === "xy" ? "俯视" : item === "xz" ? "前视" : "侧视"}</button>)}
          </div>
          <label className="cad-projection-select-sr">投影<select aria-label="CAD 投影平面" value={projection} onChange={(event) => onProjectionChange(event.target.value as CadProjection)} disabled={busy}><option value="xy">俯视 XY</option><option value="xz">前视 XZ</option><option value="yz">侧视 YZ</option></select></label>
          <span className="cad-source"><Layers3 size={14} />{selectedCount ? `已选 ${selectedCount} 点` : `${visibleCount.toLocaleString()} 点`}</span>
        </div>

        <div className="cad-metrics">
          <div><span>覆盖面积</span><strong>{format(summary?.projectedAreaM2)}<small>m²</small></strong></div>
          <div><span>实体</span><strong>{model?.entities.length.toLocaleString() ?? "—"}<small>个</small></strong></div>
          <div><span>实测 / 推断</span><strong>{model ? `${model.statistics.observedWallEntities} / ${model.statistics.inferredWallEntities}` : "—"}<small>墙线</small></strong></div>
        </div>

        <div className="cad-inspector-tabs" role="tablist" aria-label="CAD 设置分组">
          <button role="tab" aria-selected={inspectorTab === "drawing"} className={inspectorTab === "drawing" ? "active" : ""} onClick={() => setInspectorTab("drawing")}><SlidersHorizontal />图纸</button>
          <button role="tab" aria-selected={inspectorTab === "evidence"} className={inspectorTab === "evidence" ? "active" : ""} onClick={() => setInspectorTab("evidence")}><Box />证据</button>
          <button role="tab" aria-selected={inspectorTab === "review"} className={inspectorTab === "review" ? "active" : ""} onClick={() => setInspectorTab("review")}><ShieldCheck />复核{reviewWarnings.length > 0 && <small>{reviewWarnings.length}</small>}</button>
        </div>

        <div className="cad-inspector-content" role="tabpanel">
          {inspectorTab === "drawing" && <>
            <article className="cad-card cad-primary-card">
              <div className="cad-card-title"><Box size={16} /><strong>图纸设置</strong></div>
              <div className="cad-form-grid">
                <label>图幅<select aria-label="CAD 图幅" value={settings.paperSize} onChange={(event) => updateSettings({ paperSize: event.target.value as CadPaperSize })} disabled={busy}>{["A0", "A1", "A2", "A3", "A4"].map((size) => <option key={size}>{size}</option>)}</select></label>
                <label>比例<select aria-label="CAD 比例" value={settings.scale} onChange={(event) => updateSettings({ scale: event.target.value })} disabled={busy}>{["1:50", "1:100", "1:200"].map((scale) => <option key={scale}>{scale}</option>)}</select></label>
              </div>
            </article>
            <div className="cad-mode-summary"><CheckCircle2 /><span><strong>严格实测</strong><small>只依据实测数据生成图纸</small></span></div>
            {workflow.status === "completed" && <section className="cad-file-list"><header><FileArchive /><strong>成果包内容</strong></header>{workflow.files.map((file) => <div key={file.name}><span>{file.name}</span><small>{formatSize(file.size)}</small></div>)}</section>}
          </>}

          {inspectorTab === "evidence" && <article className="cad-card cad-evidence-card">
            <div className="cad-card-title"><Box size={16} /><strong>墙体提取</strong></div>
            <p>保留实测边界，辅助选项仅在明确需要时开启。</p>
            <div className="cad-check-list">
              <label className="cad-check"><input type="checkbox" checked={settings.orthogonalizeWalls} onChange={(event) => updateSettings({ orthogonalizeWalls: event.target.checked })} disabled={busy} /><span><strong>提取墙体</strong><small>减少家具干扰</small></span></label>
              {settings.orthogonalizeWalls && <label className="cad-check"><input type="checkbox" checked={settings.inferWallGaps} onChange={(event) => updateSettings({ inferWallGaps: event.target.checked })} disabled={busy} /><span><strong>补齐缺口</strong><small>导出前需复核</small></span></label>}
              <label className="cad-check"><input type="checkbox" checked={settings.includePoints} onChange={(event) => updateSettings({ includePoints: event.target.checked })} disabled={busy} /><span><strong>附带原始点</strong><small>便于追溯</small></span></label>
              <label className="cad-check"><input type="checkbox" checked={settings.detailDimensions} onChange={(event) => updateSettings({ detailDimensions: event.target.checked })} disabled={busy} /><span><strong>详细尺寸</strong><small>增加标注</small></span></label>
            </div>
            <button className="cad-action" disabled={!cloud.positions.length || busy} onClick={() => onRemoveCeiling(topTolerance)}><Trash2 size={14} />清理顶部</button>
          </article>}

          {inspectorTab === "review" && <>
            <article className="cad-card cad-review-card">
              <div className="cad-card-title"><Ruler size={16} /><strong>人工标注</strong><small>{projectionAnnotations.length} 条</small></div>
              <div className="cad-annotation-entry">
                <select aria-label="CAD 标注类别" value={annotationCategory} onChange={(event) => setAnnotationCategory(event.target.value as NonNullable<CadAnnotation["category"]>)}><option value="text">普通文字</option><option value="room">房间名</option><option value="door">门</option><option value="window">窗</option></select>
                <input aria-label="标注文字" placeholder="客厅 / M1 / C1" value={annotationText} onChange={(event) => setAnnotationText(event.target.value)} onKeyDown={(event) => event.key === "Enter" && startAnnotationPlacement()} />
                <button
                  className={placingAnnotation ? "active" : ""}
                  aria-label={placingAnnotation ? "取消放置标注" : "在图纸中放置标注"}
                  aria-pressed={Boolean(placingAnnotation)}
                  title={!model ? "请先生成预览" : stale ? "请先更新几何预览" : placingAnnotation ? "取消放置" : "放置到图纸"}
                  disabled={!placingAnnotation && (!annotationText.trim() || !model || stale || busy)}
                  onClick={() => placingAnnotation ? setPlacingAnnotation(undefined) : startAnnotationPlacement()}
                >{placingAnnotation ? <X size={15} /> : <Crosshair size={15} />}<span>{placingAnnotation ? "取消" : "放置"}</span></button>
              </div>
              {placingAnnotation && <div className="cad-annotation-placement-note"><Crosshair />点击图纸放置，Esc 取消</div>}
              {projectionAnnotations.length > 0 && <ul className="cad-annotations">{projectionAnnotations.map((annotation, index) => {
                const id = annotation.id ?? `${projection}-${index}`;
                return <li key={id} className={selectedAnnotationId === id ? "selected" : ""}>
                  <select
                    aria-label={`标注类别 ${annotation.text}`}
                    value={annotation.category ?? "text"}
                    onFocus={() => setSelectedAnnotationId(id)}
                    onChange={(event) => updateAnnotation(annotation, { category: event.target.value as NonNullable<CadAnnotation["category"]> })}
                    disabled={busy}
                  >{Object.entries(ANNOTATION_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                  <input
                    aria-label={`编辑标注 ${annotation.text}`}
                    value={annotation.text}
                    onFocus={() => setSelectedAnnotationId(id)}
                    onChange={(event) => updateAnnotation(annotation, { text: event.target.value })}
                    disabled={busy}
                  />
                  <button aria-label={`删除标注 ${annotation.text}`} onClick={() => deleteAnnotation(id)} disabled={busy}><Trash2 size={13} /></button>
                </li>;
              })}</ul>}
              {projectionAnnotations.length > 0 && <small className="cad-annotation-help">选中后可直接在图纸中拖动</small>}
            </article>
            {model && <section className="cad-warning-panel" aria-label="CAD 校验警告">
              <header><strong>导出前复核</strong><span>{reviewWarnings.length ? `${reviewWarnings.length} 项` : "无阻断项"}</span></header>
              {reviewWarnings.map((warning) => <div key={warning.code} data-severity={warning.severity}><AlertTriangle /><span><strong>{warning.message}</strong></span></div>)}
              {processNotes.length > 0 && <details className="cad-process-notes"><summary>处理记录 <small>{processNotes.length}</small></summary>{processNotes.map((warning) => <div key={warning.code}><Info /><span><strong>{warning.message}</strong></span></div>)}</details>}
            </section>}
          </>}

          {workflow.status === "error" && <div className="cad-workflow-error" role="alert"><AlertTriangle /><span>出图失败：{workflow.error}</span></div>}
        </div>

      </aside>
    </div>
    <div className="cad-link-status" data-link-kind={link.kind ?? "none"}>
      <span>{busy ? workflow.stage : workflow.status === "error" ? "出图遇到问题，请展开设置查看原因" : stale ? "空间或设置已变化，请更新图纸" : !model ? "从当前空间生成图纸，再点击查看关联" : link.status}</span>
      {link.kind === "neighborhood" && <small>同一图纸位置可能对应不同高度，仅高亮附近样本。</small>}
      {link.pinned && <small>已锁定 · Esc 清除</small>}
    </div>
    <footer className="cad-inspector-footer">
          <div className="cad-exports">
            {busy ? <button onClick={onCancel}><X size={15} />取消</button> : <button disabled={!summary} onClick={onPreparePreview}><ScanLine size={15} />{model ? "更新图纸" : "生成图纸"}</button>}
            {workflow.status === "exporting" ? <button disabled><LoaderCircle className="cad-spin" />打包中</button> : <button className="cad-export-primary" disabled={!canExport} onClick={onExportStandardDrawing}><Download size={15} />导出</button>}
          </div>
          <small className="cad-disclaimer">{stale ? "更新后可继续关联与导出" : "导出 CAD 成果包 · 重要尺寸请实测复核"}</small>
        </footer>
  </section>;
}
