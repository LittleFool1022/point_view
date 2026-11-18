/** 对生产原图附件做离线实测：不连接设备，不将几何初值作为尺寸验收。 */
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {readCloud} from '../src/pipeline/binaryPcd';
import {verifyPairedReview,type PairedReview} from '../src/domain/pairedReview';
import {pairedWallsFromCloud} from '../src/pipeline/pairedWalls';
import {buildingFromPairedReview} from '../src/domain/pairedBuilding';
const [pcd,page,output]=process.argv.slice(2);if(!pcd||!page||!output)throw Error('参数：PCD 原图卷 输出JSON');
const input=await readFile(pcd),bytes=Uint8Array.from(input).buffer,source={name:path.basename(pcd),bytes,units:'m' as const,synthetic:false};
const review:PairedReview=JSON.parse(await readFile(page,'utf8'));await verifyPairedReview(review,source);
const started=performance.now(),decoded=await readCloud(source,'m',async(offset,size)=>bytes.slice(offset,offset+size),()=>{});
const walls=await pairedWallsFromCloud(decoded.cloud),model=await buildingFromPairedReview(source,{...review,walls});
const result={liveOMNI:false,sourceSha256:review.sourceSha256,sourcePoints:decoded.cloud.sourcePointCount,frames:review.frames.length,cameras:review.frames.map(f=>f.cameraId),walls: walls.length,wallBands:walls,buildingWalls:model.walls.length,elapsedSeconds:(performance.now()-started)/1000,qualityVerified:false,alignmentVerified:false,constructionAccepted:false};
await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,wallBands:undefined}));
