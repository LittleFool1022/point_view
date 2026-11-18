import {useRef} from 'react';
import {accuracyReferenceTemplate,createAccuracyRecord,reportForAccuracyRecord,type AccuracyRecord,type AccuracyReference} from './domain/accuracy';
import type {BuildingModel} from './domain/building';
import {saveFile} from './platform';
export function AccuracyPanel({model,record,disabled,onChange,onNotice}:{model:BuildingModel;record?:AccuracyRecord;disabled:boolean;onChange:(r:AccuracyRecord)=>void;onNotice:(s:string)=>void}){
 const input=useRef<HTMLInputElement>(null),report=record?reportForAccuracyRecord(model,record):undefined;
 async function load(file?:File){if(!file)return;try{if(file.size>8*1024*1024)throw Error('精度基准超过8MiB。');const reference=JSON.parse(await file.text()) as AccuracyReference,next=createAccuracyRecord(model,reference),report=reportForAccuracyRecord(model,next)!;onChange(next);onNotice(`已核验 ${report.counts.checked} 项尺寸，${report.counts.failed} 项超差；仅代表本次样本核验。`);}catch(e){onNotice(e instanceof Error?e.message:'精度基准读取失败。');}}
 async function exportFile(name:string,data:unknown){try{onNotice(await saveFile(name,new TextEncoder().encode(JSON.stringify(data,null,2)))?'精度文件已保存。':'已取消保存。');}catch(e){onNotice(e instanceof Error?e.message:'精度文件保存失败。');}}
 return <fieldset disabled={disabled}><legend>独立尺寸核验</legend><button onClick={()=>void exportFile('独立尺寸基准-待填写.json',accuracyReferenceTemplate(model))}>导出精度基准模板</button><button onClick={()=>input.current?.click()}>导入实测精度基准</button><input hidden ref={input} type="file" accept=".json" aria-label="精度基准文件" onChange={e=>{void load(e.target.files?.[0]);e.target.value='';}}/>{report&&<><p role="status">{report.independentReference?'独立实测基准':'合成基准'} · {report.counts.checked} 项 · {report.counts.failed} 项超差</p><button onClick={()=>void exportFile('尺寸精度核验报告.json',{...report,reference:record!.reference})}>导出尺寸核验报告</button></>}{record&&!report&&<p className="help">模型已修改，原核验报告失效，请重新导入基准。</p>}</fieldset>;
}
