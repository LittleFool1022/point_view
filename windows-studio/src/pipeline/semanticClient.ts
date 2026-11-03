import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type {PairedCandidate,PairedFrame,PairedCamera} from '../domain/pairedReview';
export interface SemanticResult { candidates:PairedCandidate[];instances:Uint16Array;modelSha256:string;modelId:string;modelRevision:string }
export class SemanticClient {
 private worker=new Worker(new URL('./semantic.worker.ts',import.meta.url),{type:'module'});
 private sequence=0;
 private closed=false;
 private ready?:Promise<void>;
 private pending?:{resolve:(value:any)=>void;reject:(error:Error)=>void};
 constructor(){
  this.worker.onmessage=({data})=>{const p=this.pending;if(!p)return;this.pending=undefined;data.error?p.reject(Error(data.error)):p.resolve(data.result);};
  this.worker.onerror=()=>{this.pending?.reject(Error('本地识别进程异常。'));this.pending=undefined;};
 }
 private call(data:object,transfer:Transferable[]=[]):Promise<any>{
  if(this.closed)return Promise.reject(Error('已取消本地识别。'));
  return new Promise((resolve,reject)=>{this.pending={resolve,reject};this.worker.postMessage({...data,id:++this.sequence},transfer);});
 }
 async run(frame:PairedFrame,camera:PairedCamera):Promise<SemanticResult>{
  if(!this.ready)this.ready=(async()=>{
   const assets=window.surveyDesktop?.semanticAssets?await window.surveyDesktop.semanticAssets():await(async()=>{
    const base=new URL('ai-evaluation/',document.baseURI);
    const load=async(name:string)=>{const r=await fetch(new URL(name,base));if(!r.ok)throw Error('本地识别资源缺失。');return r;};
    const [model,wasm,metadata]=await Promise.all([(await load('segformer-b0-ade.onnx')).arrayBuffer(),fetch(wasmUrl).then(r=>{if(!r.ok)throw Error('本地识别运行库缺失。');return r.arrayBuffer();}),(await load('engine.json')).json()]);return {model,wasm,metadata};
   })();
   await this.call({action:'init',...assets},[assets.model,assets.wasm]);
  })();
  await this.ready;return this.call({action:'infer',frame,camera});
 }
 dispose(){this.closed=true;this.pending?.reject(Error('已取消本地识别。'));this.pending=undefined;this.worker.terminate();}
}
