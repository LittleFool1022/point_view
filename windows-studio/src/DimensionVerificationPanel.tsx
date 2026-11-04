import {useRef,useState} from 'react';
import {
  assessDimensionReferences,
  createDimensionVerificationRecord,
  measureDimension,
  dimensionReferenceEntry,
  dimensionReferenceTemplate,
  dimensionVerificationExpired,
  reportForDimensionVerification,
  validateImportedDimensionReference,
  type DimensionReference,
  type DimensionReferenceProvenance,
  type DimensionVerificationRecord,
} from './domain/dimensionVerification';
import type {DrawingModel} from '../../src/cad/model';

const emptyProvenance:DimensionReferenceProvenance={kind:'independent-survey',method:'',operator:'',measuredAt:'',documentRef:'',instrument:''};

/**
 * 关键尺寸核验：只对用户选中的图纸尺寸录入或导入独立实测值，
 * 显示偏差与容差区间；缺少独立参考时明确标为未核验，不阻止导出。
 */
export function DimensionVerificationPanel({model,record,sourceSha256,selectedDimensionId,disabled,onChange,onSelect,onNotice}:{
  model?:DrawingModel;
  record?:DimensionVerificationRecord;
  sourceSha256?:string;
  selectedDimensionId?:string;
  disabled:boolean;
  onChange(record:DimensionVerificationRecord|undefined):void;
  onSelect(id:string):void;
  onNotice(message:string):void;
}){
  const fileInput=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false);
  const [draft,setDraft]=useState({referenceMm:'',toleranceMm:'',uncertaintyMm:'0',note:''});
  const [provenance,setProvenance]=useState<DimensionReferenceProvenance>({...emptyProvenance});
  const report=model&&record&&sourceSha256?reportForDimensionVerification(model,record,sourceSha256):undefined;
  const expired=!!record&&!report&&dimensionVerificationExpired(model,record,sourceSha256);
  const dimensions=model?.dimensions??[];
  const label=(id:string)=>{const index=dimensions.findIndex(d=>d.id===id);return index>=0?`尺寸 ${index+1}`:id;};
  const selected=dimensions.find(d=>d.id===selectedDimensionId);
  const measuredRow=model&&selected?measureDimension(model,{id:'preview',dimensionId:selected.id,referenceMm:1,toleranceMm:1,uncertaintyMm:0,note:''}):undefined;

  async function download(name:string,data:unknown){
    try{
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      onNotice('文件已保存。');
    }catch(error){onNotice(error instanceof Error?error.message:'文件保存失败。');}
  }
  async function importFile(file?:File){
    if(!file||!model||!sourceSha256)return;
    try{
      if(file.size>4*1024*1024)throw Error('尺寸参考文件超过4MiB。');
      const reference=validateImportedDimensionReference(JSON.parse(await file.text()),model,sourceSha256);
      onChange(createDimensionVerificationRecord(model,reference));
      const result=assessDimensionReferences(model,reference),independent=result.filter(r=>r.independentReference);
      const synthetic=result.length-independent.length;
      onNotice(independent.length?`已核验 ${independent.length} 项独立实测关键尺寸，${independent.filter(r=>!r.withinTolerance).length} 项超差${synthetic?`；另有 ${synthetic} 项合成/推算参考，不作为独立实测精度`:''}。`:`已导入 ${result.length} 项合成/推算参考，仅保留比较结果，独立尺寸仍为未核验。`);
    }catch(error){onNotice(error instanceof Error?error.message:'尺寸参考读取失败。');}
  }
  /** 录入一条选中尺寸的参考值，逐项追加；来源记在该项上，沿用条目保持原来源。 */
  function recordSelected(){
    if(!model||!selected||!sourceSha256)return;
    try{
      const provenanceNow={...provenance};
      if(!provenanceNow.method.trim()||!provenanceNow.operator.trim()||!provenanceNow.measuredAt||!provenanceNow.documentRef.trim())throw Error('请先填写测量方法、人员、日期和依据文件。');
      const entry=dimensionReferenceEntry(selected.id,{...draft,provenance:provenanceNow});
      const entries=[...(record?.reference.entries??[]).filter(e=>e.dimensionId!==selected.id),entry];
      const reference:DimensionReference={schema:'survey-dimension-reference/1',drawingId:model.drawingId,view:model.view,sourceSha256,provenance:provenanceNow,entries};
      onChange(createDimensionVerificationRecord(model,reference));
      setDraft({referenceMm:'',toleranceMm:draft.toleranceMm,uncertaintyMm:draft.uncertaintyMm,note:''});
      onNotice(`已记录 ${label(entry.dimensionId)} 的${provenanceNow.kind==='synthetic'?'合成/推算参考':'独立实测参考值'} ${entry.referenceMm} mm（容差 ±${entry.toleranceMm} mm）${provenanceNow.kind==='synthetic'?'；合成参考不计入独立实测核验。':'。'}`);
    }catch(error){onNotice(error instanceof Error?error.message:'参考值录入失败。');}
  }
  function removeEntry(dimensionId:string){
    if(!model||!record||!sourceSha256)return;
    const entries=record.reference.entries.filter(e=>e.dimensionId!==dimensionId);
    if(!entries.length){onChange(undefined);return;}
    try{onChange(createDimensionVerificationRecord(model,{...record.reference,entries}));}catch(error){onNotice(error instanceof Error?error.message:'删除失败。');}
  }
  // 过期结论不得作为核验报告导出；只能重新核验或清除。
  const syntheticNote=report&&report.counts.synthetic?`（另有 ${report.counts.synthetic} 项合成/推算参考）`:'';
  const statusText=!dimensions.length?'尚未生成尺寸':!record?'未核验 · 缺少独立实测参考':expired?'核验已过期 · 图纸重建或源件变化后需重新核验'
    :!report!.independentReference?`独立尺寸未核验 · 仅有合成/推算参考的 ${report!.results.length} 项比较，不作为实测精度`
    :report!.status==='sample-within-tolerance'?`已核验 ${report!.counts.checked} 项独立实测 · 全部在容差内${syntheticNote}`
    :`已核验 ${report!.counts.checked} 项独立实测 · ${report!.counts.failed} 项超差${syntheticNote}`;
  return <div className="dimension-verify" data-testid="dimension-verify">
    <p className={`dimension-verify-status ${report?(report.independentReference?(report.status==='sample-within-tolerance'?'ok':'bad'):'unverified'):'unverified'}`} role="status">{statusText}</p>
    {!record&&dimensions.length>0&&<p className="help">可以照常导出；成果包会标注“独立尺寸未核验”。</p>}
    {expired&&<p className="help">图纸几何或米/毫米换算已改变，旧结论不再有效，需要重新核验。</p>}
    <div className="dimension-verify-actions">
      <button disabled={disabled||!(model&&sourceSha256)} onClick={()=>void download('关键尺寸参考-待填写.json',model&&sourceSha256?dimensionReferenceTemplate(model,sourceSha256):{})}>导出参考模板</button>
      <button disabled={disabled||!(model&&sourceSha256)} onClick={()=>fileInput.current?.click()}>导入参考</button>
      <input hidden ref={fileInput} type="file" accept=".json" aria-label="尺寸参考文件" onChange={e=>{void importFile(e.target.files?.[0]);e.target.value='';}}/>
      <button disabled={disabled||!selected} aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{open?'收起录入':selected?'录入选中尺寸':'选中尺寸后录入'}</button>
      {report&&<button disabled={disabled} onClick={()=>void download('关键尺寸核验报告.json',{...report,reference:record!.reference})}>导出核验报告</button>}
      {record&&<button disabled={disabled} onClick={()=>onChange(undefined)}>清除核验</button>}
    </div>
    {selected&&<p className="help" data-testid="selected-dimension">选中尺寸 {selected.id} · 图纸测量 {measuredRow?.measuredMm} mm（显示 {measuredRow?.displayedMm} mm）</p>}
    {open&&selected&&<div className="dimension-verify-form">
      <div className="inspector-grid-2">
        <label>独立参考值 mm<input aria-label="独立参考值 mm" inputMode="decimal" value={draft.referenceMm} onChange={e=>setDraft({...draft,referenceMm:e.target.value})}/></label>
        <label>容差 ± mm<input aria-label="容差 mm" inputMode="decimal" value={draft.toleranceMm} onChange={e=>setDraft({...draft,toleranceMm:e.target.value})}/></label>
      </div>
      <div className="inspector-grid-2">
        <label>测量不确定度 mm<input aria-label="不确定度 mm" inputMode="decimal" value={draft.uncertaintyMm} onChange={e=>setDraft({...draft,uncertaintyMm:e.target.value})}/></label>
        <label>量具<input aria-label="量具" value={provenance.instrument} onChange={e=>setProvenance({...provenance,instrument:e.target.value})}/></label>
      </div>
      <div className="inspector-grid-2">
        <label>测量方法<input aria-label="测量方法" value={provenance.method} onChange={e=>setProvenance({...provenance,method:e.target.value})}/></label>
        <label>测量人<input aria-label="测量人" value={provenance.operator} onChange={e=>setProvenance({...provenance,operator:e.target.value})}/></label>
      </div>
      <div className="inspector-grid-2">
        <label>实测日期<input aria-label="实测日期" type="date" value={provenance.measuredAt} onChange={e=>setProvenance({...provenance,measuredAt:e.target.value})}/></label>
        <label>依据文件<input aria-label="依据文件" value={provenance.documentRef} onChange={e=>setProvenance({...provenance,documentRef:e.target.value})}/></label>
      </div>
      <label className="dimension-verify-kind">参考来源<select aria-label="参考来源" value={provenance.kind} onChange={e=>setProvenance({...provenance,kind:e.target.value as DimensionReferenceProvenance['kind']})}><option value="independent-survey">独立实测</option><option value="synthetic">合成/推算（不算实测精度）</option></select></label>
      <button disabled={disabled} onClick={recordSelected}>记录该尺寸参考值</button>
    </div>}
    {report&&<div className="dimension-verify-results">
      <table aria-label="关键尺寸核验结果">
        <thead><tr><th>尺寸</th><th>图纸 mm</th><th>参考 mm</th><th>偏差 mm</th><th>容差 ±mm</th><th>结论</th><th/></tr></thead>
        <tbody>{report.results.map(row=><tr key={row.entry.dimensionId} className={row.independentReference?(row.withinTolerance?'ok':'bad'):'warn'}>
          <td><button className="link-button" onClick={()=>onSelect(row.entry.dimensionId)}>{label(row.entry.dimensionId)}</button></td>
          <td>{row.measuredMm}（显示 {row.displayedMm}）</td>
          <td>{row.entry.referenceMm}</td>
          <td>{row.deviationMm>0?'+':''}{row.deviationMm}</td>
          <td>±{row.entry.toleranceMm}{row.entry.uncertaintyMm?` +u${row.entry.uncertaintyMm}`:''}</td>
          <td>{row.independentReference?(row.withinTolerance?'在容差内':'超差'):'合成参考·不计入'}</td>
          <td><button aria-label={`删除 ${label(row.entry.dimensionId)} 核验项`} onClick={()=>removeEntry(row.entry.dimensionId)}>×</button></td>
        </tr>)}</tbody>
      </table>
      <p className="help">判定：|图纸测量−独立参考|+不确定度 ≤ 容差；偏差以参考值为零点的对称区间，不把取整显示值当成实测。合成/推算参考只列比较结果，不计入独立实测核验。</p>
    </div>}
    {record&&expired&&<div className="dimension-verify-results">
      <table aria-label="过期核验项"><thead><tr><th>尺寸</th><th>参考 mm</th><th>容差 ±mm</th><th/></tr></thead>
        <tbody>{record.reference.entries.map(e=><tr key={e.dimensionId}><td>{e.dimensionId}</td><td>{e.referenceMm}</td><td>±{e.toleranceMm}</td><td><button aria-label={`删除 ${label(e.dimensionId)} 核验项`} onClick={()=>removeEntry(e.dimensionId)}>×</button></td></tr>)}</tbody></table>
    </div>}
  </div>;
}
