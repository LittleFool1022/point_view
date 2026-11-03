import { useState } from 'react';
import type { BuildingModel } from './domain/building';
import type { PairedCandidate, PairedFrame, PairedReview } from './domain/pairedReview';
import { placementFromCandidate, type OpeningPlacement } from './domain/pairedBuilding';
export function PairedOpeningEditor({model,review,frame,candidate,busy,onAdd,onLink}:{model:BuildingModel;review:PairedReview;frame:PairedFrame;candidate:PairedCandidate;busy:boolean;onAdd:(placement:OpeningPlacement)=>void;onLink:(id:string)=>void}) {
  const [placement,setPlacement]=useState<OpeningPlacement>(()=>placementFromCandidate(model,review,frame.id,candidate.id)??{wallId:model.walls[0]?.id??'',offsetM:.2,widthM:.9,heightM:1.2,sillM:0});
  const [openingId,setOpeningId]=useState('');
  const linked=model.openings.find(o=>o.keyframes?.some(k=>k.session===review.session&&k.frameId===frame.id&&k.candidateId===candidate.id));
  return <fieldset disabled={busy||candidate.decision!=='retain'||!!linked}><legend>连接建筑模型</legend>
    {linked?<p className="help">已关联：{linked.name??linked.id}</p>:<>
      <p className="help">请核对洞口完整边界和尺寸。</p>
      <label>宿主墙体<select aria-label="关键帧宿主墙体" value={placement.wallId} onChange={e=>setPlacement({...placement,wallId:e.target.value})}>{model.walls.map(w=><option key={w.id} value={w.id}>{w.name??w.id}</option>)}</select></label>
      {([['offsetM','沿墙偏移 m'],['widthM','洞口宽度 m'],['heightM','洞口高度 m'],['sillM','底部标高 m']] as const).map(([key,label])=><label key={key}>{label}<input aria-label={`关键帧${label}`} type="number" step=".01" value={placement[key]} onChange={e=>setPlacement({...placement,[key]:Number(e.target.value)})}/></label>)}
      <button disabled={!placement.wallId} onClick={()=>onAdd(placement)}>按当前参数加入 BIM 草案</button>
      {!!model.openings.length&&<><label>归并已有门窗<select aria-label="归并已有门窗" value={openingId} onChange={e=>setOpeningId(e.target.value)}><option value="">选择同一物理门窗</option>{model.openings.filter(o=>o.kind===(candidate.reviewedLabel??candidate.label)).map(o=><option key={o.id} value={o.id}>{o.name??o.id} · {o.keyframes?.length??0} 条观察</option>)}</select></label><button disabled={!openingId} onClick={()=>onLink(openingId)}>追加为同一门窗证据</button></>}
    </>}
  </fieldset>;
}
