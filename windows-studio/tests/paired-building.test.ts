import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {unzipSync,strFromU8} from 'fflate';
import {demoRoom} from '../src/domain/demo';
import {sha256,type PairedReview} from '../src/domain/pairedReview';
import {buildingFromPairedReview,placementFromCandidate,addKeyframeOpening,linkKeyframeOpening} from '../src/domain/pairedBuilding';
import {encodeProject,decodeProject,validateProjectState} from '../src/domain/project';
import {validateBuilding} from '../src/domain/building';
import {createUnifiedDelivery} from '../src/domain/unifiedDelivery';
import {exportIfc} from '../src/domain/ifc';
import {checkIfc} from '../src/domain/ifcCheck';
const IFC=createRequire(import.meta.url)('web-ifc');let api:any;
beforeAll(async()=>{api=new IFC.IfcAPI();await api.Init();});afterAll(()=>api.Dispose());
async function fixture(){
 const source={name:'paired-room.pcd',bytes:demoRoom(),units:'m' as const,synthetic:false};
 const jpeg=await readFile(new URL('./fixtures/keyframe.jpg',import.meta.url));
 const review:PairedReview={schema:'survey-paired-review/1',session:'capture',sourceSha256:await sha256(source.bytes),frameId:'camera_init',poseSpace:'raw',units:'m',alignmentVerified:false,captureQuality:'partial',model:{id:'segformer',revision:'frozen'},camera:{model:'opencv_rational8',width:100,height:100,intrinsics:[100,100,50,50],distortion:[0,0,0,0,0,0,0,0]},walls:[{id:'band',axisM:[[0,0],[4,0]],bottomM:0,topM:3}],frames:[]};
 for(const [i,cameraId] of (['front','left','right'] as const).entries())review.frames.push({id:`f${i}`,cameraId,camera:review.camera,name:`${cameraId}.jpg`,stampNs:`${100+i}`,sha256:await sha256(Uint8Array.from(jpeg).buffer),image:`data:image/jpeg;base64,${jpeg.toString('base64')}`,TWorldCamera:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],analyzed:true,candidates:[{id:`c${i}`,label:'window',score:.8,box:[1,1,90,90],wallId:'band',wallSupportPoints:100,wallSupportFraction:.8,envelope:{u:[.7,1.5],z:[.5,1.8]},decision:'retain',note:'被遮挡，只保留可见证据'}]});
 let model=await buildingFromPairedReview(source,review);const placement=placementFromCandidate(model,review,'f0','c0')!;
 model=await addKeyframeOpening(model,source,review,'f0','c0',placement);
 return {source,review,model,placement};
}
describe('关键帧到建筑与同修订交付',()=>{
 it('采用原始世界墙带，支持宿主轴线反向，尺寸与来源保持待复核',async()=>{
  const {source,review,model,placement}=await fixture();expect(model.walls[0]!.axisM).toEqual(review.walls[0]!.axisM);expect(placement.offsetM).toBeCloseTo(.7);expect(placement.widthM).toBeCloseTo(.8);
  expect(model.openings[0]!.evidence.confirmed).toBe(false);expect(model.openings[0]!.keyframes![0]).toMatchObject({cameraId:'front',imageSha256:review.frames[0]!.sha256,model:review.model});
  model.walls[0]!.axisM=[[4,0],[0,0]];const reversed=placementFromCandidate(model,review,'f1','c1')!;expect(reversed.offsetM).toBeCloseTo(2.5);expect(reversed.widthM).toBeCloseTo(.8);
  await expect(addKeyframeOpening(model,{...source,clips:[{id:'clip',mode:'remove',projection:'xy',min:[0,0],max:[1,1]} as any]},review,'f1','c1',reversed)).rejects.toThrow('测量关联');
 });
 it('跨相机观察归并一个构件，拒绝重复观察、重叠洞口和类别冲突',async()=>{
  const {source,review,model,placement}=await fixture(),id=model.openings[0]!.id;
  const linked=await linkKeyframeOpening(model,source,review,'f1','c1',id);expect(linked.openings).toHaveLength(1);expect(linked.openings[0]!.keyframes!.map(k=>k.cameraId)).toEqual(['front','left']);
  const duplicate=structuredClone(linked);duplicate.openings.push({...duplicate.openings[0]!,id:'copy',offsetM:2.5});expect(validateBuilding(duplicate).some(i=>i.code==='KEYFRAME_DUPLICATE')).toBe(true);
  await expect(linkKeyframeOpening(linked,source,review,'f1','c1',id)).rejects.toThrow('已关联');
  await expect(addKeyframeOpening(model,source,review,'f1','c1',placement)).rejects.toThrow('重叠');
  review.frames[2]!.candidates[0]!.reviewedLabel='door';await expect(linkKeyframeOpening(model,source,review,'f2','c2',id)).rejects.toThrow('同类');
 });
 it('拒绝错误源件、已排除候选和越界参数；保存恢复完整来源',async()=>{
  const {source,review,model,placement}=await fixture();const wrong=source.bytes.slice(0);new Uint8Array(wrong)[0]^=1;
  await expect(addKeyframeOpening(model,{...source,bytes:wrong},review,'f1','c1',placement)).rejects.toThrow('SHA256');
  review.frames[1]!.candidates[0]!.decision='reject';await expect(addKeyframeOpening(model,source,review,'f1','c1',placement)).rejects.toThrow('先保留');
  review.frames[1]!.candidates[0]!.decision='retain';await expect(addKeyframeOpening(model,source,review,'f1','c1',{...placement,offsetM:100,widthM:99})).rejects.toThrow('超出宿主');
  const data=await encodeProject({source,pairedReview:review,building:model,annotations:[],projection:'xy',settings:{}});expect((await decodeProject(data.slice().buffer as ArrayBuffer)).building).toEqual(model);
  const broken=structuredClone(model);broken.openings[0]!.keyframes![0]!.imageSha256='b'.repeat(64);
  await expect(decodeProject((await encodeProject({source,pairedReview:review,building:broken,annotations:[],projection:'xy',settings:{}})).slice().buffer as ArrayBuffer)).rejects.toThrow('来源无法');
 });
 it('同修订包逐件哈希、CAD与IFC门窗宿主和观察来源由独立引擎核验',async()=>{
  const {source,review,model}=await fixture();const linked=await linkKeyframeOpening(model,source,review,'f1','c1',model.openings[0]!.id);
  const result=await createUnifiedDelivery({source,model:linked,review,settings:{},pointCount:7332,makeIfc:async m=>{const bytes=exportIfc(m,'review');return {bytes,check:checkIfc(api,bytes)};}});
  const entries=unzipSync(result.archive);for(const file of result.manifest.files){expect(entries[file.name]!.length).toBe(file.bytes);expect(await sha256(entries[file.name]!.slice().buffer as ArrayBuffer)).toBe(file.sha256);}
  expect(result.manifest.source.sha256).toBe(review.sourceSha256);expect(result.report.constructionAccepted).toBe(false);expect(result.drawings[0]!.statistics.windowCount).toBe(1);expect(result.report.ifcCheck.schema).toBe('IFC4');
  const id=api.OpenModel(entries['model-review.ifc']);try{
   expect(api.GetLineIDsWithType(id,IFC.IFCWINDOW).size()).toBe(1);expect(api.GetLineIDsWithType(id,IFC.IFCRELVOIDSELEMENT).size()).toBe(1);expect(api.GetLineIDsWithType(id,IFC.IFCRELFILLSELEMENT).size()).toBe(1);
   const sets=api.GetLineIDsWithType(id,IFC.IFCPROPERTYSET);let observations:any;
   for(let i=0;i<sets.size();i++){const set=api.GetLine(id,sets.get(i),true);const p=set.HasProperties.find((p:any)=>p.Name.value==='KeyframeObservations');if(p)observations=JSON.parse(p.NominalValue.value);}
   expect(observations.map((o:any)=>o.cameraId)).toEqual(['front','left']);
  }finally{api.CloseModel(id);}
  const cad=Object.keys(entries).find(n=>n.endsWith('.dxf'))!;expect(strFromU8(entries[cad]!)).toContain('WINDOW');
  expect(JSON.parse(strFromU8(entries['building.json']!)).revision).toBe(model.revision);
 });
 it('切到其他原图卷后，模型来源仍可恢复，统一包保留跨卷决策',async()=>{
  const {source,review,model}=await fixture();
  const index=review.frames.map(({image,...frame},i)=>({...frame,pageId:`page-${String(i+1).padStart(6,'0')}`,session:review.session,sourceSha256:review.sourceSha256,model:review.model,captureQuality:review.captureQuality,alignmentVerified:review.alignmentVerified}));
  const active={...review,frames:[review.frames[1]!]};
  const state={schema:'survey-project/3',source:{name:source.name,units:'m',synthetic:false,sha256:review.sourceSha256},pairedReview:active,activeKeyframePage:'page-000002',pairedReviewIndex:index,building:model,settings:{},annotations:[],projection:'xy'};
  validateProjectState(state);
  const result=await createUnifiedDelivery({source,model,review:active,reviewIndex:index,settings:{},pointCount:7332,makeIfc:async m=>{const bytes=exportIfc(m);return{bytes,check:checkIfc(api,bytes)};}});
  expect(result.report.issues.some(i=>i.code==='OBSERVATION_UNAVAILABLE')).toBe(false);
  const decisions=JSON.parse(strFromU8(unzipSync(result.archive)['keyframe-decisions.json']!));
  expect(decisions.frames).toHaveLength(review.frames.length);expect(decisions.frames[0].pageId).toBe('page-000001');
  const broken=structuredClone(state);broken.pairedReviewIndex[0]!.sha256='f'.repeat(64);
  expect(()=>validateProjectState(broken)).toThrow('来源无法');
 });
 it('清理后旧模型禁止混交；来源意见变化留在统一待处理清单',async()=>{
  const {source,review,model}=await fixture();let called=false;
  await expect(createUnifiedDelivery({source:{...source,clips:[{} as any]},model,settings:{},pointCount:7332,makeIfc:async()=>{called=true;throw Error('unexpected');}})).rejects.toThrow('依据已过期');expect(called).toBe(false);
  review.frames[0]!.candidates[0]!.decision='reject';
  const r=await createUnifiedDelivery({source,model,review,settings:{},pointCount:7332,makeIfc:async m=>{const bytes=exportIfc(m);return {bytes,check:checkIfc(api,bytes)};}});expect(r.report.issues.some(i=>i.code==='OBSERVATION_CHANGED')).toBe(true);
  const broken=structuredClone(model);broken.openings[0]!.keyframes![0]!.sourceSha256='f'.repeat(64);expect(validateBuilding(broken).some(i=>i.code==='KEYFRAME_SOURCE')).toBe(true);
 });
});
