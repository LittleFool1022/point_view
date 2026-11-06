import { useEffect, useState } from "react";
import { activeWalls, wallLength, type BuildingModel, type ReviewAction, type Vec2 } from "./domain/building";
import { openUnclosedIssues, reviewSummary } from "./domain/buildingReview";

export type ReviewActionId = "connect" | "patch" | "remove" | "opening";
/** 删伪影对墙段生效，不要求该墙段已挂在某条未闭合项上。 */
export interface ReviewTarget { id: ReviewActionId; issue?: UnclosedIssueView; wallId?: string }

/**
 * 未闭合清单按原因分组：分组键取自每项的结构化原因码与缺口大小，换工程、换样本都按同一规则归类；
 * 没有原因码的旧工程退回按问题类型归类，不使用样本里的墙段编号或计数。
 */
export function issueGroup(id: UnclosedIssueView): string {
  if (id.resolution === "resolved-opening") return "已确认洞口";
  if (id.closedBy) return "已人工闭合";
  if (id.kind === "wall-gap") return (id.gapM ?? 0) <= .3 ? "小缺口 ≤0.3 m（疑似贴合/洞口）" : "大缺口 >0.3 m";
  return "悬空端 · 未对齐";
}
export type UnclosedIssueView = ReturnType<typeof openUnclosedIssues>[number];

/** 处置记录里的动作名（面板与记录共用一套文字）。 */
export const ACTION_LABELS: Record<ReviewAction["action"], string> = { connect: "连接两端", "add-wall": "补墙", "remove-wall": "删伪影", "resolved-opening": "确认洞口" };
/** 未闭合项已处置结果的来源：由处置记录读出，记录原件在模型层 `reviewActions`。 */
export function disposalOf(model: BuildingModel, issueId: string): ReviewAction | undefined {
  return [...(model.reviewActions ?? [])].reverse().find(a => a.issueId === issueId);
}

/** 处置入口：只列出模型层支持的四种处置，选中缺口后按未闭合项给出可用项。 */
export function reviewActions(id: UnclosedIssueView): Array<{ id: ReviewActionId; label: string; hint: string }> {
  const all = [
    { id: "connect" as const, label: "连接两端", hint: id.toM ? "两端落到墙网交点/吸附点，缺口沿墙轴补足" : "该缺口没有目标落点，改用补墙" },
    { id: "patch" as const, label: "补墙", hint: "画布两点连线，近墙自动吸附" },
    { id: "remove" as const, label: "删伪影", hint: "软删除墙段并留痕，可撤销" },
    { id: "opening" as const, label: "确认洞口", hint: "不计入未闭合，记录保留，不据此成房" },
  ];
  return all.filter(a => id.kind === "wall-gap" || a.id !== "connect");
}

/**
 * 未闭合清单驱动的复核面板：清单定位、四种处置入口、进度、处置记录与处置来源墙段。
 * 状态都由模型本身推导（未闭合项、处置记录），所以保存重开后面板与处置前一致。
 */
export function WallReviewPanel({model,levelId,issueId,selectedWallId,disabled,picking,patchLength,onFocus,onWall,onAction,onCancel}:{
  model:BuildingModel;levelId:string;issueId?:string;selectedWallId?:string;disabled:boolean;picking:boolean;patchLength?:number;
  onFocus:(id?:string)=>void;onWall:(id:string)=>void;onAction:(target:ReviewTarget,reason:string)=>void;onCancel:()=>void;
}) {
  const open = openUnclosedIssues(model, levelId), resolved = (model.unclosedIssues ?? []).filter(i => i.levelId === levelId && (i.resolution || i.closedBy));
  const summary = reviewSummary(model, levelId), issue = open.find(i => i.id === issueId);
  const [group, setGroup] = useState<string>(""), [reason, setReason] = useState("");
  const grouping = [...new Map([...open, ...resolved].map(i => [issueGroup(i), 0])).keys()];
  const shown = (group ? (open.filter(i => issueGroup(i) === group).concat(resolved.filter(i => issueGroup(i) === group))) : [...open, ...resolved])
    .sort((a, b) => Number(!!a.resolution || !!a.closedBy) - Number(!!b.resolution || !!b.closedBy) || (a.gapM ?? 0) - (b.gapM ?? 0));
  const wallName = (id: string) => model.walls.find(w => w.id === id)?.name ?? "已删除墙段";
  useEffect(() => setReason(""), [issueId]);
  // 除补墙外均为确认式：选中缺口即给出，不需要额外步骤。
  return <section className="wall-review" aria-label="墙体与房间复核">
    <header className="wall-review-head">
      <h2>墙体与房间复核</h2>
      <p className="wall-review-progress" data-progress><span>未闭合 {open.length + resolved.length}</span><span>已处置 {resolved.length}</span><span>剩余 {open.length}</span><span>房间 {summary.closure.rooms}</span></p>
    </header>
    <div className="review-groups" role="group" aria-label="未闭合清单分组">
      <button aria-pressed={!group} onClick={() => setGroup("")}>全部 {open.length + resolved.length}</button>
      {grouping.map(g => { const n = open.filter(i => issueGroup(i) === g).length + resolved.filter(i => issueGroup(i) === g).length; return <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>{g} {n}</button>; })}
    </div>
    {shown.length === 0 && <p className="help">当前楼层没有未闭合项；房间由墙网几何得出。</p>}
    <ol className="review-issues" aria-label="未闭合清单">
      {shown.map(i => { const done = disposalOf(model, i.id); const state = i.resolution === "resolved-opening" ? "已确认洞口" : i.closedBy ? "已人工闭合" : done ? `已处置 · ${ACTION_LABELS[done.action]}` : "未处置";
        return <li key={i.id} data-issue={i.id} data-kind={i.kind} data-state={i.resolution ? "resolved-opening" : i.closedBy || done ? "disposed" : "open"} aria-current={issueId === i.id ? "true" : undefined}>
          <button className="review-issue" aria-pressed={issueId === i.id} onClick={() => onFocus(i.id === issueId ? undefined : i.id)}>
            <span>{i.reason}</span>
            <small>{issueGroup(i)} · 位置 {fmtPoint(i.pointM)}{i.gapM !== undefined ? ` · 缺口 ${i.gapM.toFixed(3)} m` : ""} · 墙段 {i.wallIds.map(wallName).join("、")} · {state}{done ? ` · ${done.at.slice(11, 16)} 人工` : ""}</small>
          </button>
          {issueId === i.id && !i.resolution && !i.closedBy && <div className="review-actions" role="group" aria-label="处置入口">
            {reviewActions(i).filter(a => a.id !== "remove").map(a => <button key={a.id} disabled={disabled || (a.id === "connect" && !i.toM)} aria-pressed={a.id === "patch" ? picking : undefined} title={a.hint} onClick={() => onAction({ id: a.id, issue: i }, reason.trim())}>{a.label}</button>)}
          </div>}
        </li>; })}
    </ol>
    {issue && picking && <p className="review-pick" role="status">补墙：在画布上点两点{patchLength !== undefined ? `，当前长度 ${patchLength.toFixed(3)} m` : ""}；<button onClick={onCancel}>取消补墙</button></p>}
    {selectedWallId && !picking && <div className="review-wall" role="group" aria-label="选中墙段处置">
      <p>选中墙段：{wallName(selectedWallId)}{lengthOf(model, selectedWallId)}{wallOf(model, selectedWallId)?.source?.kind === "manual" ? " · 人工来源" : ""}</p>
      <label>删除原因<input aria-label="删除原因" value={reason} disabled={disabled} onChange={e => setReason(e.target.value)} placeholder="如：孤立墙面证据，判为伪影"/></label>
      <button disabled={disabled || !reason.trim()} onClick={() => onAction({ id: "remove", wallId: selectedWallId }, reason.trim())}>删除所选墙段（留痕）</button>
    </div>}
    <h3>处置记录 {summary.actions.length}</h3>
    {summary.actions.length === 0 ? <p className="help">尚无人工处置；正常自动流程不需要处置。</p> : <ol className="review-log" aria-label="处置记录">{[...summary.actions].reverse().map(a => <li key={a.id} data-action={a.action}><span>{a.at.slice(0, 16).replace("T", " ")} · {ACTION_LABELS[a.action]} · 人工</span><small>{a.note} 房间 {a.roomsBefore} → {a.roomsAfter}</small></li>)}</ol>}
    <p className="help">房间 {summary.closure.rooms} 个{summary.rooms.length ? `：${summary.rooms.map(r => `${r.name} ${r.areaM2.toFixed(2)} m²`).join("、")}` : "；未闭合项未处置前不生成房间。"}</p>
  </section>;
}
const wallOf = (m: BuildingModel, id: string) => activeWalls(m).find(w => w.id === id);
const lengthOf = (m: BuildingModel, id: string) => { const w = wallOf(m, id); return w ? ` · ${wallLength(w).toFixed(3)} m` : ""; };
const fmtPoint = (p: Vec2) => `${p[0].toFixed(2)}, ${p[1].toFixed(2)} m`;
