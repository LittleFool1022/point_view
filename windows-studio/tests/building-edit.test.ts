import {expect,it} from 'vitest';
import {buildingFromSegments,updateWall} from '../src/domain/buildingOps';
import {buildingQuantities,validateBuilding,type Vec2} from '../src/domain/building';

function fixture(){
  const segments=[0,20].flatMap(x=>{
    const p:Vec2[]=[[x,0],[x+8,0],[x+8,6],[x,6]];
    return p.map((a,i)=>({a,b:p[(i+1)%4]!,support:20,rmsM:.01}));
  });
  const m=buildingFromSegments({name:'rooms.pcd',bytes:new ArrayBuffer(1),units:'m',synthetic:true},
    {elevationM:0,heightM:4,thicknessM:.2,levelName:'L1'},segments);
  m.rooms[0]!.name='保留房间名称';m.rooms[1]!.heightM=5;
  m.rooms.forEach(r=>r.evidence.confirmed=true);
  m.openings=[{id:'door',kind:'door',wallId:m.walls[0]!.id,offsetM:1,widthM:.9,heightM:2.1,sillM:0,evidence:{...m.walls[0]!.evidence,confirmed:true}}];
  return m;
}

it('改墙名或复核标记不重建房间，改墙高不覆盖已有净高',()=>{
  const m=fixture(),wall=m.walls[0]!;
  const renamed=updateWall(m,{...wall,name:'新墙名',evidence:{...wall.evidence,confirmed:true}});
  expect(renamed.rooms).toEqual(m.rooms);expect(renamed.openings).toEqual(m.openings);
  const taller=updateWall(m,{...wall,heightM:4.5});
  expect(taller.rooms.map(r=>[r.id,r.name,r.heightM,r.boundaryM])).toEqual(m.rooms.map(r=>[r.id,r.name,r.heightM,r.boundaryM]));
  expect(taller.rooms.every(r=>!r.evidence.confirmed)).toBe(true);
  expect(taller.openings[0]!.evidence.confirmed).toBe(false);
});

it('墙厚变化更新同一墙环净边界且保留身份净高，断环不串用其他房间属性',()=>{
  const m=fixture(),wall=m.walls[0]!,room=m.rooms[0]!;
  // 旧工程边界起点和绕向可以不同。
  room.boundaryM=[...room.boundaryM.slice(1),room.boundaryM[0]!].reverse();
  const thicker=updateWall(m,{...wall,thicknessM:.4}),changed=thicker.rooms.find(r=>r.id===room.id)!;
  expect(changed.name).toBe(room.name);expect(changed.heightM).toBe(4);expect(changed.evidence.confirmed).toBe(false);
  expect(changed.boundaryM).not.toEqual(room.boundaryM);
  expect(buildingQuantities(thicker).rooms.find(r=>r.id===room.id)!.areaM2).toBeCloseTo(7.8*5.7);
  expect(thicker.rooms[1]).toEqual(m.rooms[1]);expect(validateBuilding(thicker).every(i=>i.code==='UNREVIEWED')).toBe(true);
  const broken=updateWall(m,{...wall,axisM:[wall.axisM[0],[7,0]]});
  expect(broken.rooms).toEqual([m.rooms[1]]);
  expect(m.rooms[0]).toEqual(room);
});
