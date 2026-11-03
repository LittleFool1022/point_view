import { polygonArea, validPolygon, type BuildingModel, type Evidence, type Room, type Vec2, type Wall } from "./building";
import type { SurveySource } from "./project";
import { sourceSize } from "./source";
import type { WallSegment } from "../pipeline/wallLines";
export interface BuildingOptions { elevationM:number; heightM:number; thicknessM:number; levelName:string }
export const sourceStamp = (s: SurveySource) => JSON.stringify({name:s.name,bytes:sourceSize(s),units:s.units,clips:s.clips??[]});
export const newBuilding = (source: SurveySource, options: BuildingOptions): BuildingModel => ({ schema:"survey-building/1",id:crypto.randomUUID(),revision:1,units:"m",up:"Z",sourceStamp:sourceStamp(source),sourceName:source.name,sourceSha256:source.native?.sha256,levels:[{id:crypto.randomUUID(),name:options.levelName,elevationM:options.elevationM}],walls:[],openings:[],rooms:[],assumptions:[`楼层标高${options.elevationM}m、墙高${options.heightM}m、墙厚${options.thicknessM}m为用户设置，未作为实测值验证。`,"候选墙面迹线暂作墙轴，需复核中心轴与厚度；门窗不从点云缺口自动推断。"] });
export const manualEvidence = (m: BuildingModel): Evidence => ({kind:"manual",sourceAssetId:m.sourceSha256??m.sourceStamp??m.id,revision:m.revision,confirmed:false});
export function buildingFromSegments(source:SurveySource, options:BuildingOptions, segments:WallSegment[]) {
  const m=newBuilding(source,options), level=m.levels[0]!;
  m.walls=segments.map((s,i)=>({id:crypto.randomUUID(),name:`墙 ${i+1}`,levelId:level.id,axisM:[s.a,s.b],heightM:options.heightM,thicknessM:options.thicknessM,evidence:{...manualEvidence(m),kind:"inferred"}}));
  m.rooms=roomsFromWalls(m,level.id,options.heightM); return m;
}
/** 仅处理度数均为2的独立闭合墙环；缺边、分叉和多房间网络交给人工复核。 */
export function roomsFromWalls(m: BuildingModel, levelId: string, heightM: number) {
  return wallRoomCandidates(m, levelId, heightM).map(c => c.room);
}
function wallRoomCandidates(m: BuildingModel, levelId: string, heightM?: number) {
  const walls=m.walls.filter(w=>w.levelId===levelId), nodes:Vec2[]=[], ends: [number,number][]=[], adjacent:number[][]=[];
  const node=(p:Vec2)=>{let i=nodes.findIndex(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<.002);if(i<0){i=nodes.length;nodes.push(p);adjacent.push([]);}return i;};
  walls.forEach((w,i)=>{const a=node(w.axisM[0]),b=node(w.axisM[1]);ends.push([a,b]);adjacent[a]!.push(i);adjacent[b]!.push(i);});
  const visited=new Set<number>(), rooms:Array<{room:Room;wallKey:string}>=[];
  for(let edge=0;edge<walls.length;edge++){
    if(visited.has(edge))continue;
    const component:number[]=[], queue=[edge];while(queue.length){const e=queue.pop()!;if(visited.has(e))continue;visited.add(e);component.push(e);for(const n of ends[e]!) for(const other of adjacent[n]!)if(!visited.has(other))queue.push(other);}
    if(component.length<3 || component.some(e=>ends[e]!.some(n=>adjacent[n]!.length!==2)))continue;
    const order:Vec2[]=[], ordered:Wall[]=[];let n=ends[edge]![0], e=edge;
    for(let i=0;i<component.length;i++){order.push(nodes[n]!);ordered.push(walls[e]!);n=ends[e]![0]===n?ends[e]![1]:ends[e]![0];e=adjacent[n]!.find(other=>other!==e)!;}
    if(!validPolygon(order))continue;
    const signed=order.reduce((sum,p,i)=>{const q=order[(i+1)%order.length]!;return sum+p[0]*q[1]-q[0]*p[1];},0), sign=signed>0?1:-1;
    // 墙轴向房间内侧偏移半墙厚，交点构成净边界；拒绝无效收缩结果。
    const shifted=order.map((p,i)=>{const q=order[(i+1)%order.length]!,dx=q[0]-p[0],dy=q[1]-p[1],len=Math.hypot(dx,dy),d=ordered[i]!.thicknessM/2;return {p:[p[0]-sign*dy/len*d,p[1]+sign*dx/len*d] as Vec2,u:[dx,dy] as Vec2};});
    const inner:Vec2[]=[];for(let i=0;i<shifted.length;i++){const a=shifted[(i+shifted.length-1)%shifted.length]!,b=shifted[i]!,det=a.u[0]*b.u[1]-a.u[1]*b.u[0];if(Math.abs(det)<1e-8){inner.length=0;break;}const t=((b.p[0]-a.p[0])*b.u[1]-(b.p[1]-a.p[1])*b.u[0])/det;inner.push([a.p[0]+a.u[0]*t,a.p[1]+a.u[1]*t]);}
    if(validPolygon(inner) && polygonArea(inner)<polygonArea(order))rooms.push({wallKey:JSON.stringify(ordered.map(w=>w.id).sort()),room:{id:crypto.randomUUID(),name:`房间 ${rooms.length+1}`,levelId,boundaryM:inner,heightM:heightM??Math.min(...ordered.map(w=>w.heightM)),evidence:{...manualEvidence(m),kind:"inferred"}}});
  }
  return rooms;
}

/** 墙属性更新仅在平面几何变化时重算净边界，同一墙环保留房间身份和净高。 */
export function updateWall(m: BuildingModel, wall: Wall): BuildingModel {
  const old = m.walls.find(w => w.id === wall.id);
  if (!old) throw Error('待修改墙体不存在。');
  const next = {...m, walls: m.walls.map(w => w.id === wall.id ? wall : w)};
  const planarChanged = old.levelId !== wall.levelId || old.thicknessM !== wall.thicknessM || JSON.stringify(old.axisM) !== JSON.stringify(wall.axisM);
  if (!planarChanged && old.heightM === wall.heightM) return next;
  next.openings = m.openings.map(o => o.wallId === wall.id ? {...o, evidence: {...o.evidence, confirmed: false}} : o);
  const affected = new Set([old.levelId, wall.levelId]);
  if (!planarChanged) {
    next.rooms = m.rooms.map(r => affected.has(r.levelId) ? {...r, evidence: {...r.evidence, confirmed: false}} : r);
    return next;
  }
  // 兼容旧工程：先用旧净边界找回宿主墙环，再按墙 ID 对应新边界；不按数组序号猜测房间。
  const sameBoundary = (a: Vec2[], b: Vec2[]) => a.length === b.length && b.some((_, start) =>
    [1, -1].some(step => a.every((p, i) => {
      const q = b[(start + step * i + b.length) % b.length]!;
      return Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-7;
    })));
  next.rooms = m.rooms.filter(r => !affected.has(r.levelId) || r.evidence.kind !== 'inferred')
    .map(r => affected.has(r.levelId) ? {...r, evidence: {...r.evidence, confirmed: false}} : r);
  const previous = new Map<string, Room>();
  for (const level of affected) for (const c of wallRoomCandidates(m, level)) {
    const room = m.rooms.find(r => r.levelId === level && r.evidence.kind === 'inferred' && sameBoundary(r.boundaryM, c.room.boundaryM));
    if (room) previous.set(c.wallKey, room);
  }
  for (const level of affected) {
    for (const c of wallRoomCandidates(next, level)) {
      const room = previous.get(c.wallKey);
      if (room) next.rooms.push(sameBoundary(room.boundaryM, c.room.boundaryM) && room.levelId === level ? room :
        {...room, levelId: level, boundaryM: c.room.boundaryM, evidence: {...room.evidence, revision: m.revision, confirmed: false}});
    }
  }
  return next;
}

/** 用户确认类别与边界后转换为待复核构件，不自动标记为已测量或已复核。 */
export function openingFromElevation(m:BuildingModel,wallId:string,c:import('../pipeline/wallElevation').OpeningCandidate,e:import('../pipeline/wallElevation').WallElevation,template:import('./openingTemplates').OpeningTemplateId){
  const wall=m.walls.find(w=>w.id===wallId),floor=m.levels.find(l=>l.id===wall?.levelId);
  if(!wall||!floor||c.kind==='unknown'||e.wallId!==wallId||JSON.stringify(e.axisM)!==JSON.stringify(wall.axisM)||c.supportPoints<20)throw Error('请选择有效墙面证据，并确认候选属于门或窗。');
  if(c.bottomM<floor.elevationM-1e-7||c.bottomM+c.heightM>floor.elevationM+wall.heightM+1e-7)throw Error('候选超出当前墙体标高范围，请先依据立面证据修正楼层标高或墙高。');
  return {id:crypto.randomUUID(),name:(c.kind==='door'?'门':'窗')+' · 立面候选',kind:c.kind,wallId,offsetM:c.offsetM,widthM:c.widthM,heightM:c.heightM,sillM:c.bottomM-floor.elevationM,design:{template,frameWidthM:Math.min(.05,c.widthM/5,c.heightM/5)},evidence:{...manualEvidence(m),kind:'inferred' as const},detection:{method:'wall-elevation/1' as const,cellM:e.options.cellM,slabM:e.options.slabM,sourcePoints:e.sourcePointCount,supportPoints:c.supportPoints,cues:c.cues,proposalM:[c.offsetM,c.bottomM,c.widthM,c.heightM] as [number,number,number,number]}};
}
