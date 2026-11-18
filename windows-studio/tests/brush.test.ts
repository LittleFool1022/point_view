import {expect,it} from 'vitest';
import type {PointCloudData} from '../../src/domain/types';
import {ClipState,applyClips,createMaskRule,maskIndices,validateClips} from '../src/domain/cleaning';
import {BrushIndex} from '../src/pipeline/brushSelection';
import {validateStroke,type BrushStroke} from '../src/domain/brush';
import {encodeProject,decodeProject} from '../src/domain/project';
import {demoRoom} from '../src/domain/demo';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function cloud(points:number[]):PointCloudData{return {id:'fixture',frameId:'source',stampNs:0n,positions:Float32Array.from(points),colors:new Uint8Array(points.length),visible:new Uint8Array(points.length/3).fill(1)};}
function stroke(overrides:Partial<BrushStroke>={}):BrushStroke{return {matrix:identity,viewMatrix:identity,viewport:[200,200],path:[[50,100],[150,100]],radiusPx:8,depth:'surface',thicknessM:.05,...overrides};}
it('表面刷保护同屏背层，穿透显式开启；快拖轨迹连续且无命中不擦除',()=>{
 const c=cloud([-.5,0,.5,0,0,.5,.5,0,.5,0,0,-.5,0,.4,.5]);
 const index=new BrushIndex(c,{min:[-.5,0,-.5],max:[.5,.4,.5]});
 expect([...index.select(stroke())].sort()).toEqual([0,1,2]);
 expect([...index.select(stroke({depth:'through'}))].sort()).toEqual([0,1,2,3]);
 expect([...index.select(stroke({path:[[10,10]],radiusPx:2}))]).toEqual([]);
});
it('选择尊重已有清理和裁剪深度，不把NDC距离当作米',()=>{
 const c=cloud([0,0,.5,0,0,.47,0,0,.3,0,0,2]);c.visible[1]=0;
 const index=new BrushIndex(c,{min:[0,0,.3],max:[0,0,2]});
 expect([...index.select(stroke())]).toEqual([0]);
 expect([...index.select(stroke({thicknessM:.25}))].sort()).toEqual([0,2]);
});
it('增量掩码逐笔撤销/重做精确，编码和持久化重放与原点号一致',async()=>{
 const c=cloud([0,0,0,1,0,0,2,0,0,3,0,0]);const state=new ClipState(c);
 const a=createMaskRule(Uint32Array.from([0,2]),4),b=createMaskRule(Uint32Array.from([1]),4);
 expect(state.sync([a,b])).toBe(1);expect([...c.visible]).toEqual([0,0,0,1]);
 expect(state.sync([a])).toBe(2);expect([...c.visible]).toEqual([0,1,0,1]);
 expect(state.sync([])).toBe(4);expect(state.sync([a,b])).toBe(1);
 const restored=JSON.parse(JSON.stringify(a));expect([...maskIndices(restored)]).toEqual([0,2]);
 expect(applyClips(c,[restored])).toBe(2);
 const bytes=demoRoom(),{decodeSource}=await import('../src/pipeline/analysis'),original=await decodeSource('demo.pcd',bytes,'m');
 const persisted=createMaskRule(Uint32Array.of(0,2),original.visible.length);
 const saved=await encodeProject({source:{name:'demo.pcd',units:'m',synthetic:true,bytes,clips:[persisted]},projection:'xy',settings:{},annotations:[]});
 const project=await decodeProject(saved.slice().buffer as ArrayBuffer);expect([...maskIndices(project.source.clips![0] as typeof a)]).toEqual([0,2]);
});
it('连续150笔没有旧100条规则限制，保留历史边界且拒绝坏载荷和错源点数',()=>{
 const c=cloud(Array.from({length:603},(_,i)=>i%3===0?i/3:0)),state=new ClipState(c);
 const rules=Array.from({length:150},(_,i)=>createMaskRule(Uint32Array.of(i),201));
 expect(state.sync(rules)).toBe(51);expect(state.sync(rules.slice(0,73))).toBe(128);expect(state.sync(rules)).toBe(51);
 expect(()=>validateClips([{...rules[0],data:'invalid$'}])).toThrow();
 expect(()=>maskIndices({...rules[0]!,rawBytes:2})).toThrow();
 expect(()=>applyClips(c,[createMaskRule(Uint32Array.of(1),202)])).toThrow('不匹配');
 expect(()=>validateStroke(stroke({radiusPx:NaN}))).toThrow();
});
it('倾斜相机和稀疏网格查询结果与逐点投影一致',()=>{
 const p:number[]=[];for(let i=0;i<5000;i++)p.push(Math.sin(i*1.1),Math.cos(i*.27),Math.sin(i*.17));
 const c=cloud(p),angle=.37,cs=Math.cos(angle),sn=Math.sin(angle),matrix=[cs,sn,0,0,-sn,cs,0,0,0,0,1,0,0,0,0,1];
 const s=stroke({matrix,depth:'through',path:[[35,55],[165,150]],radiusPx:13});
 const hits=new Set(new BrushIndex(c,{min:[-1,-1,-1],max:[1,1,1]}).select(s));
 // 离刷边超过3像素的点必须与解析胶囊判定一致（深度格为2 CSS像素）。
 for(let i=0;i<c.visible.length;i++){
  const x=p[i*3]!,y=p[i*3+1]!,u=(cs*x-sn*y+1)*100,v=(1-sn*x-cs*y)*100;
  const a=s.path[0]!,b=s.path[1]!,dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((u-a[0])*dx+(v-a[1])*dy)/(dx*dx+dy*dy))),d=Math.hypot(u-a[0]-t*dx,v-a[1]-t*dy);
  if(u>=0&&u<=200&&v>=0&&v<=200&&Math.abs(d-s.radiusPx)>3)expect(hits.has(i)).toBe(d<s.radiusPx);
 }
});
