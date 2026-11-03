/** 对已有真实草案重新生成当前格式的交付物，用于独立接收校验。 */
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {decodeProject} from '../src/domain/project';
import {createUnifiedDelivery} from '../src/domain/unifiedDelivery';
import {exportIfc} from '../src/domain/ifc';
import {checkIfc} from '../src/domain/ifcCheck';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('需要工程和输出路径');
const p=await decodeProject(Uint8Array.from(await readFile(input)).buffer);
if(!p.building||!p.pairedReview)throw Error('工程缺少建筑或关键帧');
const IFC=createRequire(import.meta.url)('web-ifc'),api=new IFC.IfcAPI();await api.Init();
try{
 const result=await createUnifiedDelivery({source:p.source,model:p.building,review:p.pairedReview,settings:p.settings,annotations:p.annotations,pointCount:2106775,makeIfc:async m=>{const bytes=exportIfc(m);return {bytes,check:checkIfc(api,bytes)};}});
 await writeFile(output,result.archive);console.log(JSON.stringify({files:result.manifest.files.length,source:result.manifest.source.sha256,modelRevision:result.manifest.building.revision,bytes:result.archive.length}));
}finally{api.Dispose();}
