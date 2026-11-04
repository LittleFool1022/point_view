import {useRef,useState} from 'react';
import type {DrawingModel} from '../../src/cad/model';
import {
  dimensionEndpointCandidates,
  dimensionHasLinkedGeometry,
  dimensionMeasurementMm,
  type DimensionRevisionState,
} from './domain/dimensionRevision';

/**
 * 尺寸几何修订面板：选中尺寸后列出关联墙线/线段的端点，可直接在图纸拖动或按数值修订；
 * 修订链可撤销/重做，修订后核验过期只在这里集中提示一次。
 */
export function DimensionRevisionPanel({model,selectedDimensionId,state,active,disabled,expiredNotice,canUndo,canRedo,onActive,onRevise,onUndo,onRedo,onLoadReadback,readbackLoaded,onNotice}:{
  model?:DrawingModel;
  selectedDimensionId?:string;
  state?:DimensionRevisionState;
  active?:{entityId:string;vertexIndex:number};
  disabled:boolean;
  expiredNotice?:string;
  canUndo:boolean;
  canRedo:boolean;
  onActive(active:{entityId:string;vertexIndex:number}|undefined):void;
  onRevise(amountMm:number):void;
  onUndo():void;
  onRedo():void;
  onLoadReadback(file?:File):void;
  readbackLoaded:boolean;
  onNotice(message:string):void;
}){
  const [amount,setAmount]=useState('');
  const fileInput=useRef<HTMLInputElement>(null);
  const dimension=model?.dimensions?.find(row=>row.id===selectedDimensionId);
  const candidates=model&&selectedDimensionId?dimensionEndpointCandidates(model,selectedDimensionId):[];
  const changes=state?.changes??[];
  const measured=dimension?dimensionMeasurementMm(dimension):undefined;
  const rounded=dimension&&measured!==undefined?Number((Math.round(measured/dimension.roundingMm)*dimension.roundingMm).toFixed(6)):undefined;
  const submit=()=>{
    const value=Number(amount.trim());
    if(amount.trim()===''||!Number.isFinite(value)){onNotice('修订量必须是有效数字（毫米，正值加长）。');return;}
    onRevise(value);
    setAmount('');
  };
  return <div className="dimension-revision" data-testid="dimension-revision">
    <div className="dimension-revision-head">
      <strong>几何修订</strong>
      <span className="dimension-revision-count">{changes.length?`${changes.length} 项修订`:'未修订'}</span>
    </div>
    {!model?<p className="help">生成工程图后可修订几何。</p>
      :!dimension?<p className="help" data-testid="revision-no-dimension">在图纸或上表选中一个尺寸后，可定位并修订其关联墙线端点。</p>
      :<>
        <p className="help" data-testid="revision-measured">尺寸 {dimension.id} · 未取整 <b>{measured!.toFixed(3)}</b> mm · 显示 <b>{rounded}</b> mm</p>
        {!dimensionHasLinkedGeometry(model,dimension.id)
          ? <p className="help dimension-revision-none" data-testid="revision-no-link">该尺寸没有关联的墙线/线段端点（定义点不在图元端点上），无法直接改几何；请在重新出图时把墙线对齐到该尺寸端点，或另建手工尺寸。</p>
          : <>
            <p className="help">关联端点 {candidates.length} 个：{[...new Set(candidates.map(row=>row.label))].join('、')}</p>
            <div className="dimension-revision-endpoints">
              {candidates.map(row=><button key={`${row.entityId}:${row.vertexIndex}`} aria-pressed={active?.entityId===row.entityId&&active?.vertexIndex===row.vertexIndex} disabled={disabled} onClick={()=>{onActive(active?.entityId===row.entityId&&active?.vertexIndex===row.vertexIndex?undefined:{entityId:row.entityId,vertexIndex:row.vertexIndex});onNotice('已进入几何修订：在图纸上拖动高亮端点，或在下方按毫米输入修订量。');}}>{row.label} · {row.side==='start'?'尺寸起点':'尺寸终点'}{active?.entityId===row.entityId&&active?.vertexIndex===row.vertexIndex?' · 拖动画布端点':''}</button>)}
            </div>
            <div className="dimension-revision-input">
              <label>修订量 mm（沿尺寸方向，正值加长）<input aria-label="修订量 mm" inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')submit();}} disabled={disabled}/></label>
              <button disabled={disabled} onClick={submit}>按数值修订</button>
            </div>
          </>}
      </>}
    {expiredNotice&&<p className="dimension-revision-expired" role="alert" data-testid="revision-expiry">{expiredNotice}</p>}
    <div className="dimension-revision-actions">
      <button disabled={disabled||!canUndo} onClick={onUndo}>撤销修订</button>
      <button disabled={disabled||!canRedo} onClick={onRedo}>重做修订</button>
    </div>
    {changes.length>0&&<table aria-label="几何修订记录">
      <thead><tr><th>尺寸</th><th>修订 mm</th><th>尺寸变化 mm</th><th>残差 mm</th></tr></thead>
      <tbody>{changes.map((change,index)=><tr key={`${change.dimensionId}-${index}`}>
        <td>{change.dimensionId}</td>
        <td>{change.revisionMm}</td>
        <td>{change.measuredChangeMm}</td>
        <td>{change.consistencyResidualMm}</td>
      </tr>)}</tbody>
    </table>}
    <p className="help">尺寸由几何定义点重算，不靠改标注文字；非正交段沿原方向修订，修订量与尺寸变化量一致（残差 0）。</p>
    <div className="dimension-revision-readback">
      <button disabled={disabled} onClick={()=>fileInput.current?.click()}>{readbackLoaded?'更换独立回读报告':'载入独立回读报告'}</button>
      <input hidden ref={fileInput} type="file" accept=".json" aria-label="独立回读报告" onChange={e=>{onLoadReadback(e.target.files?.[0]);e.target.value='';}}/>
      <small>{readbackLoaded?'下次导出会与内置回读分列记录':'可选：ezdxf 等独立读取器的回读结果'}</small>
    </div>
  </div>;
}
