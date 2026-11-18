import {expect,it} from 'vitest';
import {decodeSource} from '../src/pipeline/analysis';
import {demoRoom} from '../src/domain/demo';
import {suggestAutoClean} from '../src/pipeline/autoClean';
import {evaluateWallPreservation, fitWallLines, generateWallDrawing, selectArchitecturalOutline} from '../src/pipeline/wallLines';
import {ClipState,isAutoCleanRule} from '../src/domain/cleaning';
import {encodeProject,decodeProject} from '../src/domain/project';
import type {PointCloudData} from '../../src/domain/types';

async function fixture(){
  const base=await decodeSource('room.pcd',demoRoom(),'m'),extra:number[]=[];
  for(let x=2;x<=2.6;x+=.1)for(let y=2;y<=2.6;y+=.1)for(let z=.3;z<=1.1;z+=.1)extra.push(x,y,z);
  const furnitureCount=extra.length/3;
  for(let i=0;i<160;i++)extra.push(12+(i%13)*.17,12+(i%7)*.19,.2+(i%23)*.31);
  const positions=Float32Array.from([...base.positions,...extra]),cloud:PointCloudData={...base,positions,colors:new Uint8Array(positions.length),visible:new Uint8Array(positions.length/3).fill(1)};
  return {cloud,baseCount:base.visible.length,furnitureCount};
}

it('室外离散点和室内独立家具生成独立掩码，结构保留且撤销与工程重放一致',async()=>{
  const {cloud,baseCount,furnitureCount}=await fixture(),original=cloud.visible.slice(),result=await suggestAutoClean(cloud,{outdoor:true,indoor:true},()=>{});
  expect(result.outdoorRemoved).toBeGreaterThan(100);expect(result.indoorRemoved).toBeGreaterThan(furnitureCount*.8);
  expect(result.rules.map(rule=>rule.operation)).toEqual(['auto-outdoor-v1','auto-indoor-v1']);
  const state=new ClipState(cloud);state.sync(result.rules);
  for(let i=0;i<baseCount;i++)expect(cloud.visible[i],`结构点 ${i}`).toBe(1);
  for(let i=baseCount;i<baseCount+furnitureCount;i++)if(cloud.positions[i*3+2]!>.31)expect(cloud.visible[i]).toBe(0);
  let outdoorHidden=0;for(let i=baseCount+furnitureCount;i<cloud.visible.length;i++)if(!cloud.visible[i])outdoorHidden++;expect(outdoorHidden).toBe(result.outdoorRemoved);
  state.sync([]);expect(cloud.visible).toEqual(original);
  const saved=await encodeProject({source:{name:'room.pcd',bytes:demoRoom(),units:'m',synthetic:true,clips:result.rules},annotations:[],settings:{},projection:'xy'}),restored=await decodeProject(saved.slice().buffer as ArrayBuffer);
  expect(restored.source.clips?.filter(rule=>isAutoCleanRule(rule)).map(rule=>rule.kind==='point-mask'?rule.operation:undefined)).toEqual(['auto-outdoor-v1','auto-indoor-v1']);
});

it('只勾选室内清理时保留室外点',async()=>{
  const {cloud,baseCount,furnitureCount}=await fixture(),result=await suggestAutoClean(cloud,{outdoor:false,indoor:true},()=>{});
  const state=new ClipState(cloud);state.sync(result.rules);
  for(let i=baseCount+furnitureCount;i<cloud.visible.length;i++)expect(cloud.visible[i]).toBe(1);
  expect(result.outdoorRemoved).toBe(0);expect(result.rules.every(rule=>rule.operation==='auto-indoor-v1')).toBe(true);
});

it('带墙面法向的矮柜竖面被清理，贯通层高柱体与墙体保留',async()=>{
  const pos:number[]=[],norm:number[]=[];
  const pushWall=(x:number,y:number,z:number,nx:number,ny:number)=>{pos.push(x,y,z);norm.push(nx,ny,0);};
  for(let z=.2;z<=2.8;z+=.2){
    for(let x=0;x<=8;x+=.05){pushWall(x,0,z,0,127);pushWall(x,6,z,0,-127);}
    for(let y=0;y<=6;y+=.05){pushWall(0,y,z,127,0);pushWall(8,y,z,-127,0);}
  }
  const wallCount=pos.length/3;
  // 贯通层高的结构柱（x=5.6, y=3.0）
  for(let z=.2;z<=2.8;z+=.1)for(let dx=-.08;dx<=.08;dx+=.08)for(let dy=-.08;dy<=.08;dy+=.08)pushWall(5.6+dx,3+dy,z,127,0);
  const columnEnd=pos.length/3;
  // 室内带垂直法向的柜体（未到顶，z<=1.8）
  for(let x=2;x<=2.6;x+=.1)for(let y=2;y<=2.5;y+=.1)for(let z=.4;z<=1.8;z+=.15)pushWall(x,y,z,127,0);
  const cabinetCount=pos.length/3-columnEnd;
  const cloud:PointCloudData={
    id:'normals-room',frameId:'source',stampNs:0n,
    positions:Float32Array.from(pos),colors:new Uint8Array(pos.length),
    visible:new Uint8Array(pos.length/3).fill(1),normals:Int8Array.from(norm),
    attributes:{hasColor:false,hasIntensity:false,hasNormals:true},
  };
  const result=await suggestAutoClean(cloud,{outdoor:false,indoor:true},()=>{});
  expect(result.indoorRemoved).toBeGreaterThan(cabinetCount*.8);
  expect(result.wallsChanged).toBe(false);
  const state=new ClipState(cloud);state.sync(result.rules);
  for(let i=0;i<wallCount;i++)expect(cloud.visible[i],`墙点 ${i}`).toBe(1);
  for(let i=wallCount;i<columnEnd;i++)expect(cloud.visible[i],`柱体点 ${i}`).toBe(1);
  for(let i=columnEnd;i<pos.length/3;i++)expect(cloud.visible[i],`柜体点 ${i}`).toBe(0);
});

it('清理后新显露的墙线保留规则并放入 INFERRED_WALL 复核层',async()=>{
  const base=await decodeSource('room.pcd',demoRoom(),'m');
  const fitted=await fitWallLines(base,()=>{});
  const baseline=selectArchitecturalOutline(fitted.segments,0).kept;

  // 加入一段与外墙相连的新显露内墙（x=4, y=0..4）
  const extra:number[]=[];
  for(let y=0;y<=4;y+=.04)for(let z=.2;z<=2.8;z+=.15)extra.push(4,y,z);
  const positions=Float32Array.from([...base.positions,...extra]);
  const withDiscovered:PointCloudData={...base,positions,colors:new Uint8Array(positions.length),visible:new Uint8Array(positions.length/3).fill(1)};
  const afterFit=await fitWallLines(withDiscovered,()=>{});
  const afterWalls=selectArchitecturalOutline(afterFit.segments,0).kept;

  const preservation=evaluateWallPreservation(baseline,afterWalls);
  expect(preservation.allPreserved).toBe(true);
  expect(preservation.discovered.length).toBeGreaterThanOrEqual(1);

  const model=await generateWallDrawing(withDiscovered,'room.pcd',{},()=>{},baseline);
  const observed=model.entities.filter(e=>e.layer==='OBSERVED_WALL');
  const inferred=model.entities.filter(e=>e.layer==='INFERRED_WALL'&&e.category==='wall');
  expect(observed.length).toBe(4);
  expect(inferred.length).toBeGreaterThanOrEqual(1);
  expect(inferred[0]).toMatchObject({source:'derived',confidence:'inferred',lineType:'DASHED'});
  expect(model.warnings.some(w=>w.code==='INFERRED_CONTENT'&&w.relatedLayer==='INFERRED_WALL')).toBe(true);
});
