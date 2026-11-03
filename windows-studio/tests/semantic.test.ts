import {it,expect} from 'vitest';
import {resizeRgb,normalizedPixels,semanticCandidates,mergeSemanticCandidates} from '../src/pipeline/semanticCore';
import {keyframeSupport} from '../src/pipeline/keyframeSupport';
import type {PairedCandidate,PairedFocus} from '../src/domain/pairedReview';
it('三角抗混叠RGB缩小接近Pillow固定参考，并采用ImageNet归一化',()=>{
 const rgba=new Uint8ClampedArray(8*6*4);for(let y=0;y<6;y++)for(let x=0;x<8;x++){for(let c=0;c<3;c++)rgba[(y*8+x)*4+c]=(x*17+y*31+c*47)%256;rgba[(y*8+x)*4+3]=255;}
 const actual=resizeRgb(rgba,8,6,3);
 // 参考由Pillow对相同未压缩RGB数据计算，数值逐通道核验。
 const reference=[41, 88, 135, 82, 129, 175, 122, 169, 191, 97, 144, 188, 138, 178, 185, 178, 167, 85, 152, 199, 159, 190, 164, 81, 158, 58, 74];
 expect(Math.max(...actual.map((v,i)=>Math.abs(v-reference[i]!)))).toBeLessThanOrEqual(1);
 expect(normalizedPixels(new Uint8Array([255,0,0]),1)[0]).toBeCloseTo((1-.485)/.229,5);
 expect(actual.length).toBe(27);
});
it('真实形状logits双线性上采样、概率和8连通候选筛选，不把微小斑块当门窗',()=>{
 const logits=new Float32Array(150*128*128).fill(-8);for(let p=0;p<128*128;p++)logits[p]=0;
 for(let y=20;y<50;y++)for(let x=20;x<50;x++)logits[14*128*128+y*128+x]=8;
 for(let y=80;y<110;y++)for(let x=70;x<100;x++)logits[8*128*128+y*128+x]=8;
 logits[14*128*128+120*128+120]=8;
 const {candidates,instances}=semanticCandidates(logits,[1,150,128,128],{'14':'door','8':'windowpane'},2048,1536,'frame');
 expect(candidates.map(c=>c.label)).toEqual(['door','window']);expect(candidates.every(c=>c.score>.9&&c.decision==='pending')).toBe(true);expect(instances[30*4*512+30*4]).toBe(1);expect(instances[90*4*512+80*4]).toBe(2);
});
it('重识别复用观察身份且保留类别修正/排除/备注；未重现旧观察不丢失',()=>{
 const base:PairedCandidate={id:'old',label:'window',score:.8,box:[0,0,100,100],wallSupportPoints:20,wallSupportFraction:.5,decision:'reject',reviewedLabel:'door',note:'人工确认是门'};
 const result=mergeSemanticCandidates([base,{...base,id:'missing',box:[200,0,300,100]}],[{...base,id:'new',score:.9,decision:'pending',reviewedLabel:undefined,note:'',box:[1,1,100,100]}]);
 expect(result).toHaveLength(2);expect(result[0]).toMatchObject({id:'old',score:.9,decision:'reject',reviewedLabel:'door',note:'人工确认是门'});expect(result[1]!.id).toBe('missing');
});
it('从全部源点进行遮挡与墙带关联，前景近点遮挡后不伪造墙面支持',async()=>{
 const frame:any={TWorldCamera:[1,0,0,2,0,0,1,-2,0,-1,0,1.5,0,0,0,1]};
 const focus:PairedFocus={frame,camera:{model:'opencv_rational8',width:512,height:512,intrinsics:[256,256,256,256],distortion:[0,0,0,0,0,0,0,0]}};
 const walls:any=[{id:'wall',axisM:[[0,0],[4,0]],bottomM:0,topM:3}];
 const candidate:PairedCandidate={id:'window',label:'window',score:.9,box:[50,240,210,400],wallSupportPoints:0,wallSupportFraction:0,decision:'pending',note:''},instances=new Uint16Array(512*512);
 for(let y=240;y<400;y++)for(let x=50;x<210;x++)instances[y*512+x]=1;
 const points:number[]=[];for(let z=.5;z<1.5;z+=.025)for(let x=.5;x<1.5;x+=.025)points.push(x,0,z);
 const cloud=(p:number[])=>({id:'test',frameId:'camera_init',stampNs:0n,positions:Float32Array.from(p),colors:new Uint8Array(p.length),visible:new Uint8Array(p.length/3).fill(1)});
 const result=await keyframeSupport(cloud(points),focus,walls,[candidate],instances);expect(result[0]!.wallSupportPoints).toBeGreaterThan(30);expect(result[0]!.wallSupportFraction).toBe(1);expect(result[0]!.envelope).toBeDefined();
 const foreground=[];for(let i=0;i<points.length;i+=3)foreground.push(2+(points[i]!-2)/2,-1,1.5+(points[i+2]!-1.5)/2);
 const blocked=await keyframeSupport(cloud([...points,...foreground]),focus,walls,[candidate],instances);expect(blocked[0]!.wallSupportPoints).toBe(0);expect(blocked[0]!.envelope).toBeUndefined();
});
