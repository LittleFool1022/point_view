import {open,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {readCloud} from '../src/pipeline/binaryPcd';
import {applyClips} from '../src/domain/cleaning';
import {buildWallElevation} from '../src/pipeline/wallElevation';
import type {BuildingModel} from '../src/domain/building';
const sourceFile=process.env.SURVEY_REAL_FIXTURE;
if(!sourceFile)throw Error('请通过 SURVEY_REAL_FIXTURE 指定真实点云 PCD 原件。');
const archiveFile=process.env.OPENING_REVIEW_ARCHIVE??'artifacts/windows-templates-20261022/真实点云-建筑效果图与约束.zip';
const out=process.env.OPENING_VALIDATION_OUTPUT??'artifacts/openings-20261023';await mkdir(out,{recursive:true});
const archiveBytes=await readFile(archiveFile).catch(()=>{throw Error(`门窗复核 ZIP 不存在或无法读取：${archiveFile}`);});
const archive=unzipSync(archiveBytes);if(!archive['building.json'])throw Error(`门窗复核 ZIP 缺少 building.json：${archiveFile}`);
const model=JSON.parse(strFromU8(archive['building.json'])) as BuildingModel;
if(!model.sourceSha256)throw Error('门窗复核模型缺少 sourceSha256，无法校验真实点云原件。');
const h=await open(sourceFile,'r').catch(()=>{throw Error(`真实点云原件不存在或无法打开：${sourceFile}`);}),started=performance.now();
const decoded=await (async()=>{try{
 const stat=await h.stat(),hasher=createHash('sha256');for await(const chunk of createReadStream(sourceFile))hasher.update(chunk);
 const actualSha256=hasher.digest('hex');if(actualSha256!==model.sourceSha256)throw Error(`真实点云原件 SHA256 与模型记录不符：期望 ${model.sourceSha256}，实际 ${actualSha256}。`);
 return await readCloud({name:model.sourceName!,native:{token:'local-read-only',name:model.sourceName!,size:stat.size,sha256:actualSha256}},'m',async(offset,size)=>{const b=Buffer.alloc(size);await h.read(b,0,size,offset);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;},()=>{});
}finally{await h.close();}})();const retained=applyClips(decoded.cloud,JSON.parse(model.sourceStamp!).clips);
const results=[];
for(const [i,w]of model.walls.entries()){
 const level=model.levels.find(l=>l.id===w.levelId)!,e=await buildWallElevation(decoded.cloud,w,level.elevationM,{bottomM:level.elevationM-1.5,topM:level.elevationM+w.heightM,slabM:.25,cellM:.03});
 const rgb=new Uint8Array(e.columns*e.rows*3);
 for(let z=0;z<e.rows;z++)for(let x=0;x<e.columns;x++){const k=z*e.columns+x,j=((e.rows-1-z)*e.columns+x)*3;rgb.set(e.counts[k]?e.rgb.subarray(k*3,k*3+3):[35,44,48],j);}
 await writeFile(`${out}/wall-${i+1}.rgb`,rgb);
 const info={wall:i+1,wallId:w.id,axisM:w.axisM,options:e.options,columns:e.columns,rows:e.rows,points:e.pointCount,candidates:e.candidates};await writeFile(`${out}/wall-${i+1}.json`,JSON.stringify(info,null,2));results.push(info);console.log(`wall ${i+1}: ${e.pointCount} points, ${e.candidates.length} candidates`);
}
await writeFile(`${out}/real-result.json`,JSON.stringify({sourceFile,sourceSha256:model.sourceSha256,sourcePoints:decoded.cloud.visible.length,retained,seconds:(performance.now()-started)/1000,modelId:model.id,modelRevision:model.revision,results,limitations:['几何/颜色启发式候选，非门窗识别准确率验收。','尚未将用户截图与三维位置一一对应，未确认某个候选就是截图中的门窗。','底标高来自旧楼层假设，类别未知或不可靠时需人工复核。']},null,2));
