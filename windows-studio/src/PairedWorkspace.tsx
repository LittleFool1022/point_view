import { PairedOpeningEditor } from "./PairedOpeningEditor";
import type { BuildingModel } from "./domain/building";
import type { OpeningPlacement } from "./domain/pairedBuilding";
import { useMemo, useState } from "react";
import type { PointCloudData } from "../../src/domain/types";
import { CloudView } from "./CloudView";
import { cameraForFrame } from "./domain/pairedReview";
import type { PairedCandidate, PairedFocus, PairedReview } from "./domain/pairedReview";
import type { KeyframePage } from "./domain/source";
const kind = (a: PairedCandidate) => (a.reviewedLabel ?? a.label) === "door" ? "门" : "窗";
const cameraName = { front: "前视", left: "左视", right: "右视" };
const status = { pending: "待复核", retain: "保留候选", reject: "已排除" };
export function PairedWorkspace({ pages, activePage, onPage, review, cloud, busy, onImport, onChange, onExport, model, onBuild, onAdd, onLink, onRecognize }: {
  pages?:KeyframePage[];activePage?:string;onPage?(id:string):void;
  review?: PairedReview; cloud?: PointCloudData; busy: boolean;
  onRecognize(frameIds:string[]):void;
  model?: BuildingModel; onBuild(): void; onAdd(frameId:string,candidateId:string,placement:OpeningPlacement):void; onLink(frameId:string,candidateId:string,openingId:string):void;
  onImport(): void; onChange(review: PairedReview): void; onExport(): void;
}) {
  const [frameId, setFrameId] = useState<string>(), [candidateId, setCandidateId] = useState<string>();
  const [cameraId, setCameraId] = useState<string>("all");
  const filterAvailable = review?.frames.some(f => (f.cameraId ?? "front") === cameraId);
  const visibleFrames = review?.frames.filter(f => cameraId === "all" || !filterAvailable || (f.cameraId ?? "front") === cameraId) ?? [];
  const frame = visibleFrames.find(f => f.id === frameId) ?? visibleFrames[0];
  const camera = review && frame ? cameraForFrame(review, frame) : undefined;
  const candidate = frame?.candidates.find(a => a.id === candidateId) ?? frame?.candidates[0];
  // 备注和复核类别不改变空间证据，编辑时保留当前三维观察角度。
  const focus = useMemo<PairedFocus | undefined>(() => review && frame ? { camera: camera!, frame, candidate, wall: review.walls.find(w => w.id === candidate?.wallId) } : undefined, [camera, review?.walls, frame?.id, frame?.TWorldCamera, candidate?.id, candidate?.box, candidate?.envelope]);
  const total = review?.frames.reduce((n, f) => n + f.candidates.length, 0) ?? 0;
  const completed = review?.frames.reduce((n, f) => n + f.candidates.filter(a => a.decision !== "pending").length, 0) ?? 0;
  function change(patch: Partial<Pick<PairedCandidate, "decision" | "reviewedLabel" | "note">>) {
    if (!review || !frame || !candidate) return;
    onChange({ ...review, frames: review.frames.map(f => f.id === frame.id ? { ...f, candidates: f.candidates.map(a => a.id === candidate.id ? { ...a, ...patch } : a) } : f) });
  }
  return <main className="paired-workspace">
    {!!pages?.length&&<div className="paired-ai-actions"><label>原图卷 <select aria-label="原图卷" disabled={busy} value={activePage??pages[0]!.id} onChange={e=>onPage?.(e.target.value)}>{pages.map((page,index)=><option key={page.id} value={page.id}>第 {index+1} 卷 / 共 {pages.length} 卷</option>)}</select></label></div>}
    <div className="work-toolbar"><div>{review&&<span>{review.frames.length} 张原图 · {total} 条候选 · 已复核 {completed}</span>}</div><button disabled={!cloud || busy} onClick={onImport}>导入关键帧附件</button><button disabled={!review || busy || !!model} onClick={onBuild}>{model ? `建筑草案 ${model.openings.length} 门窗` : "生成墙带建筑草案"}</button><button disabled={!review || busy} onClick={onExport}>导出复核记录</button></div>
    {!review || !frame ? <div className="paired-empty"><h2>暂无关键帧</h2><p>打开含原图的工程，或导入 .pvframes 附件。</p></div> : <>
      {(review.captureQuality === "partial" || !review.alignmentVerified) && <div className="paired-notice">{review.captureQuality === "partial" ? "本次采集有质量待复核项。" : ""}{!review.alignmentVerified ? "图像与点云已按采集位姿关联，尚未独立核验对齐精度。" : ""}</div>}
      <div className="paired-ai-actions"><button disabled={busy} onClick={()=>onRecognize([frame.id])}>本地 AI 识别当前帧</button><button disabled={busy||!review.frames.some(f=>!f.analyzed)} onClick={()=>onRecognize(review.frames.filter(f=>!f.analyzed).map(f=>f.id))}>识别未分析帧</button></div>
      <div className="paired-body">
        <section className="pane paired-image"><header><strong>原始关键帧</strong><label>相机<select aria-label="相机选择" value={filterAvailable ? cameraId : "all"} onChange={e => { setCameraId(e.target.value); setFrameId(undefined); setCandidateId(undefined); }}><option value="all">全部相机</option>{(["front", "left", "right"] as const).filter(id => review.frames.some(f => (f.cameraId ?? "front") === id)).map(id => <option key={id} value={id}>{cameraName[id]}</option>)}</select></label><label>帧<select aria-label="关键帧选择" value={frame.id} disabled={busy} onChange={e => { setFrameId(e.target.value); setCandidateId(undefined); }}>{visibleFrames.map((f, i) => <option key={f.id} value={f.id}>{cameraName[f.cameraId ?? "front"]} · 第 {i + 1} 帧 · {f.analyzed ? `${f.candidates.length} 条候选` : "未分析"}</option>)}</select></label></header>
          <div className="paired-image-stage"><svg viewBox={`0 0 ${camera!.width} ${camera!.height}`} aria-label="关键帧原图与门窗候选">
            <image href={frame.image} width={camera!.width} height={camera!.height}/>
            {frame.candidates.map(a => <g key={a.id} className={`paired-box ${a.id === candidate?.id ? "selected" : ""} ${a.decision}`} role="button" tabIndex={0} aria-label={`图像候选 ${a.id} ${kind(a)}`} aria-pressed={a.id === candidate?.id} onClick={() => setCandidateId(a.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCandidateId(a.id); } }}>
              <rect x={a.box[0]} y={a.box[1]} width={a.box[2]-a.box[0]} height={a.box[3]-a.box[1]}/><text x={a.box[0]+6} y={Math.max(36,a.box[1]-12)}>{kind(a)} · {Math.round(a.score*100)}%</text>
            </g>)}
          </svg></div><footer>{cameraName[frame.cameraId ?? "front"]} · {frame.name}</footer>
        </section>
        <section className="pane"><header><strong>同次采集点云</strong><span>{cloud?.sourcePointCount?.toLocaleString()} 个源点</span></header><CloudView cloud={cloud} review={focus} busy={busy} readOnly/></section>
        <aside className="paired-inspector"><h2>门窗候选</h2><div className="paired-candidates">{frame.candidates.map(a => <button key={a.id} aria-pressed={candidate?.id === a.id} onClick={() => setCandidateId(a.id)}><strong>{kind(a)} · {Math.round(a.score*100)}%</strong><small>{status[a.decision]}</small></button>)}</div>
          {!candidate ? <p className="help">{frame.analyzed ? "未发现候选" : "尚未识别"}</p> : <><h2>现场证据</h2><p>关联墙带：{candidate.wallId ?? "尚无"}</p><p>分析采样支持：{candidate.wallSupportPoints.toLocaleString()} 点</p><p>语义点墙带支持：{Math.round(candidate.wallSupportFraction*100)}%</p><p className="help">支持范围仅含可见部分。</p>
            <fieldset disabled={busy}><legend>人工复核</legend><label>复核类别<select aria-label="复核类别" value={candidate.reviewedLabel ?? candidate.label} onChange={e => change({ reviewedLabel: e.target.value as "door" | "window" })}><option value="door">门</option><option value="window">窗</option></select></label>
            <div className="paired-decisions">{(["retain","reject","pending"] as const).map(d => <button key={d} aria-pressed={candidate.decision === d} onClick={() => change({ decision: d })}>{status[d]}</button>)}</div>
            <label>复核备注<textarea aria-label="复核备注" value={candidate.note} maxLength={2000} placeholder="例如：上半部可见，底边被遮挡" onChange={e => change({ note: e.target.value })}/></label></fieldset>
            
            {model && <PairedOpeningEditor key={`${model.revision}:${candidate.id}`} model={model} review={review} frame={frame} candidate={candidate} busy={busy} onAdd={p=>onAdd(frame.id,candidate.id,p)} onLink={id=>onLink(frame.id,candidate.id,id)}/>}
          </>}
        </aside>
      </div>
    </>}
  </main>;
}
