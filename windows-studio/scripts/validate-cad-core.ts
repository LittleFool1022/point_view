import {STUDIO_VERSION} from "../src/version";
import {open,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {readCloud} from '../src/pipeline/binaryPcd';
import {generateWallDrawing} from '../src/pipeline/wallLines';
import {createSurveyDelivery} from '../src/domain/delivery';
import {validateDrawingModel} from '../../src/cad/model';
import {exportCadDxf} from '../../src/cad/dxf';
const fixture=JSON.parse(await readFile('test-data/real-capture/manifest.json','utf8'));
const output=process.env.CAD_VALIDATION_OUTPUT??'artifacts/cad-core-20261029/real-20m';await mkdir(output,{recursive:true});
const file=await open(fixture.source,'r');const stat=await file.stat();
if(stat.size!==fixture.bytes)throw Error('基准容量不符');
const hasher=createHash('sha256');for await(const chunk of createReadStream(fixture.source))hasher.update(chunk);
const sha256=hasher.digest('hex');if(sha256!==fixture.sha256)throw Error('基准哈希不符');
const source={name:fixture.filename,native:{name:fixture.filename,token:'local-verification',size:stat.size,sha256},units:'m' as const,synthetic:false};
let last='';const progress=(s:string)=>{const key=s.replace(/\d+.*/,'');if(key!==last){last=key;console.log(s);}};
const started=performance.now();
try{
 const decoded=await readCloud(source,'m',async(offset,size)=>{const b=Buffer.alloc(size);const {bytesRead}=await file.read(b,0,size,offset);if(bytesRead!==size)throw Error('原件读取不完整');return b.buffer as ArrayBuffer;},progress);
 if(decoded.cloud.visible.length!==fixture.points)throw Error('源点数量不符');
 const model=await generateWallDrawing(decoded.cloud,source.name,{roundingMm:1,scale:'1:100'},progress);
 const report=validateDrawingModel(model);if(!report.valid)throw Error(report.errors.map(e=>e.message).join(';'));
 const bundle=await createSurveyDelivery(model,source);
 await writeFile(output+'/model.json',JSON.stringify(model));await writeFile(output+'/drawing.dxf',exportCadDxf(model));await writeFile(output+'/CAD-review.zip',bundle.archive);
 const result={version:STUDIO_VERSION,fullSourcePoints:decoded.cloud.visible.length,sourceSha256:sha256,sourceBytes:stat.size,walls:model.statistics.observedWallEntities,nativeDimensions:model.dimensions?.length,geometryValidation:report.valid,parameters:model.parameters,seconds:(performance.now()-started)/1000,constructionAccepted:false,independentDimensions:'not-provided',windowsValidated:false};
 await writeFile(output+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await file.close();}
