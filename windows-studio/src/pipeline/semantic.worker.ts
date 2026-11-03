/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import {sha256,type PairedFrame} from '../domain/pairedReview';
import {resizeRgb,normalizedPixels,semanticCandidates} from './semanticCore';
let session:ort.InferenceSession|undefined,metadata:any;
self.onmessage=async({data})=>{
 try{
  if(data.action==='init'){
   metadata=data.metadata;
   if(await sha256(data.model)!==metadata.sha256)throw Error('本地识别模型校验失败。');
   ort.env.wasm.numThreads=1;ort.env.wasm.wasmBinary=data.wasm;ort.env.logLevel='error';
   session=await ort.InferenceSession.create(new Uint8Array(data.model),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
   self.postMessage({id:data.id,result:true});return;
  }
  if(!session)throw Error('本地识别模型尚未载入。');
  const frame=data.frame as PairedFrame,raw=Uint8Array.from(atob(frame.image.split(',')[1]!),c=>c.charCodeAt(0));
  if(await sha256(raw.buffer)!==frame.sha256)throw Error('当前原图哈希校验失败。');
  const bitmap=await createImageBitmap(new Blob([raw],{type:'image/jpeg'}),{colorSpaceConversion:'none'}),width=bitmap.width,height=bitmap.height;
  if(width!==data.camera.width||height!==data.camera.height){bitmap.close();throw Error('当前原图与镜头标定尺寸不一致。');}
  const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(bitmap,0,0);bitmap.close();
  const pixels=normalizedPixels(resizeRgb(ctx.getImageData(0,0,width,height).data,width,height));
  const result=await session.run({pixel_values:new ort.Tensor('float32',pixels,[1,3,512,512])}),logits=result.logits!;
  const output=semanticCandidates(logits.data as Float32Array,logits.dims,metadata.labels,width,height,frame.id);
  logits.dispose();self.postMessage({id:data.id,result:{...output,modelSha256:metadata.sha256,modelId:metadata.id,modelRevision:metadata.revision}},[output.instances.buffer]);
 }catch(error){self.postMessage({id:data.id,error:error instanceof Error?error.message:String(error)});}
};
