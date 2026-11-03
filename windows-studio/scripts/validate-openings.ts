import {open,readFile,writeFile,mkdir} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';
import {readCloud} from '../src/pipeline/binaryPcd';
import {applyClips} from '../src/domain/cleaning';
import {buildWallElevation} from '../src/pipeline/wallElevation';
import type {BuildingModel} from '../src/domain/building';
const sourceFile='/home/jn/fast_livo_runtime/static_pcd_backup/production_small_20260911_194639/tri_true_color_20260911_200108_286.pcd',out='artifacts/openings-20261023';await mkdir(out,{recursive:true});
const archive=unzipSync(await readFile('artifacts/windows-templates-20261022/真实点云-建筑效果图与约束.zip')),model=JSON.parse(strFromU8(archive['building.json']!)) as BuildingModel;
const stamp=JSON.parse(model.sourceStamp!),h=await open(sourceFile,'r'),stat=await h.stat(),started=performance.now();
const decoded=await readCloud({name:model.sourceName!,native:{token:'local-read-only',name:model.sourceName!,size:stat.size,sha256:model.sourceSha256!}},'m',async(offset,size)=>{const b=Buffer.alloc(size);await h.read(b,0,size,offset);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;},()=>{});await h.close();const retained=applyClips(decoded.cloud,stamp.clips);
const results=[];
for(const [i,w]of model.walls.entries()){
 const level=model.levels.find(l=>l.id===w.levelId)!,e=await buildWallElevation(decoded.cloud,w,level.elevationM,{bottomM:level.elevationM-1.5,topM:level.elevationM+w.heightM,slabM:.25,cellM:.03});
 const rgb=new Uint8Array(e.columns*e.rows*3);
 for(let z=0;z<e.rows;z++)for(let x=0;x<e.columns;x++){const k=z*e.columns+x,j=((e.rows-1-z)*e.columns+x)*3;rgb.set(e.counts[k]?e.rgb.subarray(k*3,k*3+3):[35,44,48],j);}
 await writeFile(`${out}/wall-${i+1}.rgb`,rgb);
 const info={wall:i+1,wallId:w.id,axisM:w.axisM,options:e.options,columns:e.columns,rows:e.rows,points:e.pointCount,candidates:e.candidates};await writeFile(`${out}/wall-${i+1}.json`,JSON.stringify(info,null,2));results.push(info);console.log(`wall ${i+1}: ${e.pointCount} points, ${e.candidates.length} candidates`);
}
await writeFile(`${out}/real-result.json`,JSON.stringify({sourceFile,sourceSha256:model.sourceSha256,sourcePoints:decoded.cloud.visible.length,retained,seconds:(performance.now()-started)/1000,modelId:model.id,modelRevision:model.revision,results,limitations:['几何/颜色启发式候选，非门窗识别准确率验收。','尚未将用户截图与三维位置一一对应，未确认某个候选就是截图中的门窗。','底标高来自旧楼层假设，类别未知或不可靠时需人工复核。']},null,2));
