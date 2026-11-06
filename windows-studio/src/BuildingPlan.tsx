import { openingPlanSegments } from "./domain/openingTemplates";
import { activeWalls, type BuildingModel, type UnclosedIssue, type Vec2 } from "./domain/building";
import { SNAP_REACH_M } from "./domain/buildingReview";
import { useEffect, useMemo, useState } from "react";

/** 画布吸附：先取 ≤0.25 m 的墙网节点/墙轴投影点（与模型层处置同一口径），否则用点击位置。 */
export function snapToWalls(p: Vec2, walls: Array<{ axisM: [Vec2, Vec2] }>): Vec2 {
  let best: { point: Vec2; gap: number } | undefined;
  const consider = (point: Vec2, gap: number) => { if (gap <= SNAP_REACH_M && (!best || gap < best.gap - 1e-12)) best = { point, gap }; };
  for (const { axisM } of walls) {
    for (const end of axisM) consider(end, Math.hypot(p[0] - end[0], p[1] - end[1]));
    const dx = axisM[1][0] - axisM[0][0], dy = axisM[1][1] - axisM[0][1], length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((p[0] - axisM[0][0]) * dx + (p[1] - axisM[0][1]) * dy) / (length * length)));
    const q: Vec2 = [axisM[0][0] + dx * t, axisM[0][1] + dy * t];
    consider(q, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  return best ? (best as { point: Vec2 }).point : p;
}
const round = (p: Vec2): Vec2 => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
const same = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

export function BuildingPlan({model,levelId,selectedId,onSelect,onWall,onRoom,disabled,issues=[],issueId,picking=false,onPick,onCancelPick}:{model:BuildingModel;levelId:string;selectedId?:string;onSelect:(id:string)=>void;onWall:(a:Vec2,b:Vec2)=>void;onRoom:(p:Vec2[])=>void;disabled?:boolean;issues?:UnclosedIssue[];issueId?:string;picking?:boolean;onPick?:(a:Vec2,b:Vec2)=>void;onCancelPick?:()=>void}) {
  const [tool,setTool]=useState<'select'|'wall'|'room'>('select'),[points,setPoints]=useState<Vec2[]>([]),[zoom,setZoom]=useState(1),[hover,setHover]=useState<Vec2>();
  const walls=activeWalls(model,levelId),rooms=model.rooms.filter(r=>r.levelId===levelId);
  // 复核定位：以选中未闭合项为中心取三倍缺口幅面的视图；选中另一项或取消选择即恢复整层视图。
  const focus=useMemo(()=>{const issue=issues.find(i=>i.id===issueId);if(!issue)return undefined;const p=issue.pointM,q=issue.toM??p,span=Math.max(4,2*Math.hypot(q[0]-p[0],q[1]-p[1])+3);return {cx:(p[0]+q[0])/2,cy:(p[1]+q[1])/2,span};},[issues,issueId]);
  useEffect(()=>{setPoints([]);},[issueId]);
  const box=useMemo(()=>{const p=walls.flatMap(w=>w.axisM).concat(rooms.flatMap(r=>r.boundaryM),issues.flatMap(i=>[i.pointM,...(i.toM?[i.toM]:[])]));if(!p.length)return [-5,-5,15,12];const x=Math.min(...p.map(v=>v[0])),y=Math.min(...p.map(v=>v[1])),maxX=Math.max(...p.map(v=>v[0])),maxY=Math.max(...p.map(v=>v[1]));return [x-2,-maxY-2,Math.max(8,maxX-x+4),Math.max(6,maxY-y+4)];},[model,levelId,issues]);
  const view=focus?[focus.cx-focus.span/2,-focus.cy-focus.span/2,focus.span,focus.span]:[box[0]!+box[2]!*(1-zoom)/2,box[1]!+box[3]!*(1-zoom)/2,box[2]!*zoom,box[3]!*zoom],stroke=Math.max(view[2]!,view[3]!)*.002;
  const toPoint=(e:{clientX:number;clientY:number;currentTarget:SVGSVGElement|null}):Vec2|undefined=>{const matrix=e.currentTarget?.getScreenCTM();if(!matrix)return undefined;const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());return round([p.x,-p.y]);};
  const patchA=picking&&points[0]?snapToWalls(points[0],walls):undefined, patchB=picking&&points[0]&&hover?snapToWalls(hover,walls):undefined;
  const snapping=!!patchB&&!same(patchB,hover!);
  function click(e:React.MouseEvent<SVGSVGElement>){
    const point=toPoint(e);if(!point)return;
    if(picking){if(!onPick)return;if(!points.length)setPoints([point]);else{onPick(points[0]!,point);setPoints([]);setHover(undefined);}return;}
    if(disabled||tool==='select')return;
    if(tool==='wall'&&points.length===1){onWall(points[0]!,point);setPoints([]);}else setPoints([...points,point]);
  }
  // 细墙在定位视图下仍要有可见线宽：取墙厚与视图千分之二幅面的较大者。
  const width=(w:{thicknessM:number})=>Math.max(w.thicknessM,stroke*2);
  const hint=picking?(points.length?`点击第二点补墙 · 长度 ${patchA&&patchB?Math.hypot(patchB[0]-patchA[0],patchB[1]-patchA[1]).toFixed(3):'—'} m${snapping?' · 已吸附墙网':''}`:'点击要补墙的起点，也可直接点在缺口两端'):tool==='wall'?'依次点击墙轴起点和终点':tool==='room'?`已选 ${points.length} 个边界顶点，完成后形成闭合房间`:focus?'已定位到未闭合项 · 点击“取消绘制”恢复整层视图':'点击墙体、门窗、房间或未闭合标记选择构件';
  return <div className="building-plan"><div className="plan-tools">{([['select','选择构件'],['wall','绘制墙体'],['room','绘制房间']] as const).map(([id,text])=><button key={id} disabled={disabled||picking} aria-pressed={tool===id} onClick={()=>{setTool(id);setPoints([]);}}>{text}</button>)}<button disabled={disabled||picking||tool!=='room'||points.length<3} onClick={()=>{onRoom(points);setPoints([]);}}>完成房间边界</button><button disabled={!points.length} onClick={()=>{setPoints([]);setHover(undefined);if(picking)onCancelPick?.();}}>取消绘制</button><button disabled={!!focus} onClick={()=>setZoom(z=>Math.max(.15,z*.8))}>放大平面</button><button disabled={!!focus} onClick={()=>setZoom(z=>Math.min(4,z/ .8))}>缩小平面</button></div>
    <svg aria-label="建筑模型平面编辑" data-view={focus?'focus':'layer'} data-zoom={focus?`${focus.span.toFixed(2)}m`:`${zoom.toFixed(2)}x`} viewBox={view.join(' ')} onClick={click} onMouseMove={e=>{if(picking&&points.length)setHover(toPoint(e));}} onMouseLeave={()=>setHover(undefined)}>
      {rooms.map(r=><polygon key={r.id} points={r.boundaryM.map(p=>`${p[0]},${-p[1]}`).join(' ')} fill={selectedId===r.id?'#e4bb72':'#e1ece5'} stroke="#9cb3a4" strokeWidth={stroke} onClick={e=>{if(tool==='select'&&!picking){e.stopPropagation();onSelect(r.id);}}}/>)}
      {issues.map(i=>{const a:[number,number]=[i.pointM[0],-i.pointM[1]],b=i.toM?[i.toM[0],-i.toM[1]] as [number,number]:undefined,picked=i.id===issueId;
        return <g key={i.id} data-issue={i.kind} onClick={e=>{if(tool==='select'&&!picking){e.stopPropagation();onSelect(i.id);}}}>
          {b&&<line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={picked?'#d0602a':'#c8742a'} strokeWidth={stroke*2} strokeDasharray={`${stroke*4} ${stroke*3}`}/>}
          <circle cx={a[0]} cy={a[1]} r={stroke*(picked?9:6)} fill={picked?'#d0602a':'#f2b45a'} stroke="#7d4a17" strokeWidth={stroke}/>
          {b&&picked&&<circle cx={b[0]} cy={b[1]} r={stroke*5} fill="none" stroke="#d0602a" strokeWidth={stroke*1.5}/>}
        </g>;})}
      {walls.map(w=><line key={w.id} x1={w.axisM[0][0]} y1={-w.axisM[0][1]} x2={w.axisM[1][0]} y2={-w.axisM[1][1]} stroke={selectedId===w.id?'#d88a27':w.source?.kind==='manual'?'#8a5fb0':w.evidence.confirmed?'#476351':'#9c8c68'} strokeWidth={width(w)} onClick={e=>{if(tool==='select'&&!picking){e.stopPropagation();onSelect(w.id);}}}/>)}
      {model.openings.map(o=>{const w=walls.find(w=>w.id===o.wallId);if(!w)return null;const len=Math.hypot(w.axisM[1][0]-w.axisM[0][0],w.axisM[1][1]-w.axisM[0][1]),ux=(w.axisM[1][0]-w.axisM[0][0])/len,uy=(w.axisM[1][1]-w.axisM[0][1])/len;return <g key={o.id} onClick={e=>{if(tool==='select'&&!picking){e.stopPropagation();onSelect(o.id);}}}><line x1={w.axisM[0][0]+ux*o.offsetM} y1={-(w.axisM[0][1]+uy*o.offsetM)} x2={w.axisM[0][0]+ux*(o.offsetM+o.widthM)} y2={-(w.axisM[0][1]+uy*(o.offsetM+o.widthM))} stroke="#f7f8f5" strokeWidth={w.thicknessM*1.2}/>{openingPlanSegments(o,w.thicknessM).map(([a,b],i)=>{const at=(p:Vec2)=>[w.axisM[0][0]+ux*(o.offsetM+p[0])-uy*p[1],-(w.axisM[0][1]+uy*(o.offsetM+p[0])+ux*p[1])];const p=at(a),q=at(b);return <line key={i} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={selectedId===o.id?'#d88a27':o.kind==='door'?'#ac7952':'#4992b5'} strokeWidth={stroke*1.5}/>;})}</g>;})}
      {points.length>0&&!picking&&<><polyline points={points.map(p=>`${p[0]},${-p[1]}`).join(' ')} fill="none" stroke="#c37824" strokeWidth={stroke*2}/>{points.map((p,i)=><circle key={i} cx={p[0]} cy={-p[1]} r={stroke*3} fill="#c37824"/>)}</>}
      {patchA&&<circle data-snap="start" cx={patchA[0]} cy={-patchA[1]} r={stroke*4} fill="#6d3fa0"/>}
      {patchA&&patchB&&<><line data-snap="preview" x1={patchA[0]} y1={-patchA[1]} x2={patchB[0]} y2={-patchB[1]} stroke="#6d3fa0" strokeWidth={stroke*2.5} strokeDasharray={`${stroke*5} ${stroke*2}`}/><circle data-snap="end" cx={patchB[0]} cy={-patchB[1]} r={stroke*(snapping?5:3)} fill="none" stroke="#6d3fa0" strokeWidth={stroke}/></>}
    </svg><small>{hint} · 坐标与尺寸单位 m</small>
  </div>;
}
