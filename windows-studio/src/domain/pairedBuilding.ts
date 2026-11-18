import { assertPairedReview, verifyPairedReview, type PairedReview } from './pairedReview';
import { validateBuilding, type BuildingModel, type KeyframeObservation, type Opening } from './building';
import { newBuilding, manualEvidence, sourceStamp } from './buildingOps';
import type { SurveySource } from './project';
export interface OpeningPlacement { wallId: string; offsetM: number; widthM: number; heightM: number; sillM: number }

async function context(m: BuildingModel, source: SurveySource, review: PairedReview, frameId: string, candidateId: string) {
  await verifyPairedReview(review,source);
  if (source.synthetic || source.units!=='m' || m.sourceStamp!==sourceStamp(source) || (m.sourceSha256 && m.sourceSha256!==review.sourceSha256)) throw Error('模型测量关联已变化，请更新模型后关联关键帧。');
  const frame=review.frames.find(f=>f.id===frameId),candidate=frame?.candidates.find(a=>a.id===candidateId);
  if(!frame||!candidate||candidate.decision!=='retain')throw Error('请先保留该候选，再加入或关联建筑构件。');
  if(m.openings.some(o=>o.keyframes?.some(k=>k.session===review.session&&k.frameId===frameId&&k.candidateId===candidateId)))throw Error('该观察证据已关联门窗，请编辑既有构件。');
  const observation:KeyframeObservation={session:review.session,sourceSha256:review.sourceSha256,frameId,cameraId:frame.cameraId??'front',imageSha256:frame.sha256,candidateId,predictedLabel:candidate.label,score:candidate.score,model:{...review.model,...(frame.inference?{artifactSha256:frame.inference.modelSha256,runtime:`${frame.inference.engine}/${frame.inference.version}`}:{})},reviewNote:candidate.note,
    visibleSupport:candidate.envelope&&candidate.wallId?{wallId:candidate.wallId,u:[...candidate.envelope.u],z:[...candidate.envelope.z]}:undefined};
  return {candidate,observation};
}
function checked(m: BuildingModel) {
  const error=validateBuilding(m).find(i=>i.code!=='UNREVIEWED');if(error)throw Error(error.message);return m;
}
/** 墙带保留原始世界轴线；下界仅作楼层初值，不宣称已测得地面或墙厚。 */
export async function buildingFromPairedReview(source:SurveySource,review:PairedReview):Promise<BuildingModel> {
  await verifyPairedReview(review,source);
  if(source.synthetic||source.units!=='m'||!review.walls.length)throw Error('请导入具有墙带证据的实测米制工程。');
  if(source.clips?.length)throw Error('墙带来自未清理原件，请从当前点云生成建筑模型后关联关键帧。');
  const elevationM=Math.min(...review.walls.map(w=>w.bottomM));
  const m=newBuilding(source,{elevationM,heightM:3,thicknessM:.2,levelName:'关键帧楼层'});
  m.sourceSha256=review.sourceSha256;
  m.assumptions=['楼层标高取墙带可见下界作为初值，未独立确认地面；墙厚0.2m为假设。','墙带迹线暂作墙轴、可见上界暂作墙高，均待复核；缺测区域不补造成房间。','关键帧可见支持范围仅为参数初值，完整门窗边界需要编辑复核。'];
  m.walls=review.walls.map(w=>({id:`capture-${w.id}`,name:`关键帧墙带 ${w.id}`,levelId:m.levels[0]!.id,axisM:structuredClone(w.axisM),heightM:w.topM-elevationM,thicknessM:.2,evidence:{...manualEvidence(m),kind:'inferred'}}));
  return checked(m);
}
/** 将可见支持转换至宿主墙局部坐标，兼容宿主轴线方向反转。 */
export function placementFromCandidate(m:BuildingModel,review:PairedReview,frameId:string,candidateId:string):OpeningPlacement|undefined {
  const a=review.frames.find(f=>f.id===frameId)?.candidates.find(a=>a.id===candidateId),band=review.walls.find(w=>w.id===a?.wallId);
  if(!a?.envelope||!band)return;
  const p=band.axisM[0],q=band.axisM[1],length=Math.hypot(q[0]-p[0],q[1]-p[1]),u=[(q[0]-p[0])/length,(q[1]-p[1])/length];
  const endpoints=a.envelope.u.map(t=>[p[0]+u[0]!*t,p[1]+u[1]!*t]);
  let best:{distance:number;placement:OpeningPlacement}|undefined;
  for(const wall of m.walls){
    const v=wall.axisM[0],w=wall.axisM[1],d=Math.hypot(w[0]-v[0],w[1]-v[1]),x=(w[0]-v[0])/d,y=(w[1]-v[1])/d;
    if(Math.abs(x*u[0]!+y*u[1]!)<.98)continue;
    const distance=Math.max(...endpoints.map(e=>Math.abs((e[0]!-v[0])*y-(e[1]!-v[1])*x)));
    const offsets=endpoints.map(e=>(e[0]!-v[0])*x+(e[1]!-v[1])*y),floor=m.levels.find(l=>l.id===wall.levelId);
    if(!floor||distance>.25||Math.min(...offsets)<-.25||Math.max(...offsets)>d+.25)continue;
    const placement={wallId:wall.id,offsetM:Math.min(...offsets),widthM:Math.abs(offsets[1]!-offsets[0]!),heightM:a.envelope.z[1]-a.envelope.z[0],sillM:a.envelope.z[0]-floor.elevationM};
    if(!best||distance<best.distance)best={distance,placement};
  }
  return best?.placement;
}
export async function addKeyframeOpening(m:BuildingModel,source:SurveySource,review:PairedReview,frameId:string,candidateId:string,placement:OpeningPlacement):Promise<BuildingModel> {
  const {candidate,observation}=await context(m,source,review,frameId,candidateId),kind=candidate.reviewedLabel??candidate.label;
  const o:Opening={id:crypto.randomUUID(),name:`${kind==='door'?'门':'窗'} · 关键帧草案`,kind,...placement,design:{template:kind==='door'?'single-door':'fixed-window',frameWidthM:Math.min(.05,placement.widthM/5,placement.heightM/5)},keyframes:[observation],evidence:{...manualEvidence(m),sourceAssetId:review.sourceSha256,kind:'inferred'}};
  return checked({...m,sourceSha256:review.sourceSha256,openings:[...m.openings,o]});
}
/** 多帧或多相机观察显式归并到同一门窗，不重复创建物理构件。 */
export async function linkKeyframeOpening(m:BuildingModel,source:SurveySource,review:PairedReview,frameId:string,candidateId:string,openingId:string):Promise<BuildingModel> {
  const {candidate,observation}=await context(m,source,review,frameId,candidateId),opening=m.openings.find(o=>o.id===openingId);
  if(!opening||opening.kind!==(candidate.reviewedLabel??candidate.label))throw Error('请先核对候选类别，并选择同类既有门窗。');
  return checked({...m,sourceSha256:review.sourceSha256,openings:m.openings.map(o=>o.id===openingId?{...o,keyframes:[...(o.keyframes??[]),observation],evidence:{...o.evidence,confirmed:false}}:o)});
}
