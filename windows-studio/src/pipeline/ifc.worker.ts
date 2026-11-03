/// <reference lib="webworker" />
import { IfcAPI } from "web-ifc";
import wasmUrl from "web-ifc/web-ifc.wasm?url&inline";
import { exportIfc } from "../domain/ifc";
import { checkIfc } from "../domain/ifcCheck";
self.onmessage=async({data})=>{try{const bytes=exportIfc(data.model,data.purpose),api=new IfcAPI();await api.Init(()=>wasmUrl,true);const check=checkIfc(api,bytes);api.Dispose();self.postMessage({bytes,check},[bytes.buffer]);}catch(e){self.postMessage({error:e instanceof Error?e.message:String(e)});}};
