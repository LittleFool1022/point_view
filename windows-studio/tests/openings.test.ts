import {expect,it} from 'vitest';
import type {PointCloudData} from '../../src/domain/types';
import {buildWallElevation,candidateFromBox} from '../src/pipeline/wallElevation';
import {newBuilding,manualEvidence,openingFromElevation} from '../src/domain/buildingOps';
import {validateBuilding,type Wall} from '../src/domain/building';
import {encodeProject,decodeProject} from '../src/domain/project';
import {demoRoom} from '../src/domain/demo';
function fixture(){
 const p:number[]=[],rgb:number[]=[];
 for(let x=0;x<8;x+=.015)for(let z=0;z<3;z+=.015){const door=x>=1&&x<=2&&z<=2.1,window=x>=4&&x<=6&&z>=.9&&z<=2.2,frame=Math.abs(x-5)<.035;const d=window&&!frame?-.06:0;p.push(x,d,z);rgb.push(...(door?[120,35,30]:window&&!frame?[90,130,165]:[220,220,220]));}
 const source={name:'fixture.pcd',bytes:demoRoom(),units:'m' as const,synthetic:true},m=newBuilding(source,{elevationM:0,heightM:3,thicknessM:.2,levelName:'L1'}),wall:Wall={id:'wall',levelId:m.levels[0]!.id,axisM:[[0,0],[8,0]],heightM:3,thicknessM:.2,evidence:manualEvidence(m)};m.walls=[wall];
 const cloud:PointCloudData={id:'known',frameId:'source',stampNs:0n,positions:Float32Array.from(p),colors:Uint8Array.from(rgb),visible:new Uint8Array(p.length/3).fill(1),attributes:{hasColor:true,hasIntensity:false}};return {cloud,source,m,wall};
}
const options={bottomM:-.5,topM:3.5,slabM:.2,cellM:.03};
it('关闭彩色门无空洞仍产生候选，双分格窗先合为整樘；全量点投影与局部坐标可追溯',async()=>{
 const {cloud,wall}=fixture(),e=await buildWallElevation(cloud,wall,0,options);expect(e.pointCount).toBe(cloud.visible.length);expect(e.sourcePointCount).toBe(cloud.visible.length);
 const doors=e.candidates.filter(c=>c.kind==='door'),windows=e.candidates.filter(c=>c.kind==='window');expect(doors).toHaveLength(1);expect(windows).toHaveLength(1);expect(doors[0]!.offsetM).toBeCloseTo(1,1);expect(doors[0]!.widthM).toBeCloseTo(1,1);expect(windows[0]!.widthM).toBeCloseTo(2,1);expect(doors[0]!.cues).toContain('颜色区别');expect(windows[0]!.cues).toContain('深度变化');
});
it('无点洞口不被当窗，隐藏点不参与，缺RGB时不能用假颜色识别门',async()=>{
 const {cloud,wall}=fixture();cloud.attributes!.hasColor=false;const e=await buildWallElevation(cloud,wall,0,options);expect(e.candidates.some(c=>c.kind==='door')).toBe(false);expect(e.candidates.some(c=>c.kind==='unknown'&&c.cues.includes('深度变化'))).toBe(true);
 for(let i=0;i<cloud.visible.length;i++)if(cloud.positions[i*3]!>3.8)cloud.visible[i]=0;
 const missing=await buildWallElevation(cloud,wall,0,options);expect(missing.candidates).toHaveLength(0);expect(missing.pointCount).toBeLessThan(missing.sourcePointCount);expect(()=>candidateFromBox(missing,[4,.8,6,2.3])).toThrow('证据不足');
});
it('确认后保留来源且仍待复核，几何/宿主校验与工程保存恢复继续有效',async()=>{
 const {cloud,wall,m,source}=fixture(),e=await buildWallElevation(cloud,wall,0,options),c=e.candidates.find(c=>c.kind==='door')!,opening=openingFromElevation(m,wall.id,c,e,'single-door');m.openings=[opening];expect(opening.evidence.kind).toBe('inferred');expect(opening.evidence.confirmed).toBe(false);expect(opening.detection.sourcePoints).toBe(cloud.visible.length);expect(validateBuilding(m).every(i=>i.code==='UNREVIEWED')).toBe(true);
 const bytes=await encodeProject({source,building:m,annotations:[],settings:{},projection:'xy'});expect((await decodeProject(bytes.slice().buffer as ArrayBuffer)).building!.openings[0]!.detection).toEqual(opening.detection);
 expect(()=>openingFromElevation(m,wall.id,{...c,kind:'unknown'},e,'single-door')).toThrow('确认');wall.axisM[1][0]=7;expect(()=>openingFromElevation(m,wall.id,c,e,'single-door')).toThrow();
});
