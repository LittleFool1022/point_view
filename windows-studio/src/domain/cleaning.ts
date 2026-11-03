import { deflateSync, inflateSync } from 'fflate';
import type { PointCloudData } from '../../../src/domain/types';

export type RegionClipRule = { matrix:number[]; rect:[number,number,number,number]; mode:'remove'|'keep' } | { axis:'x'|'y'|'z'; rangeM:[number,number]; mode:'remove'|'keep' };
/** 按原件点号保存已确认笔画，避免重开工程后因视角或抽样变化而改变结果。 */
export interface MaskClipRule { kind:'point-mask'; mode:'remove'; codec:'delta-deflate-v1'; sourcePoints:number; count:number; rawBytes:number; data:string }
export type ClipRule = RegionClipRule | MaskClipRule;
export type EditedPointCloud = PointCloudData & { retainedPointCount?:number };
const decodedMasks = new WeakMap<MaskClipRule,Uint32Array>();
export function isMaskRule(rule:ClipRule):rule is MaskClipRule { return 'kind' in rule && rule.kind==='point-mask'; }
export function validateClips(rules:unknown):asserts rules is ClipRule[] {
  let payload=0;
  if(!Array.isArray(rules)||rules.length>10000||rules.some(r=>{
    if(!r||!['remove','keep'].includes(r.mode))return true;
    if(r.kind==='point-mask'){
      if(r.mode!=='remove'||r.codec!=='delta-deflate-v1'||!Number.isSafeInteger(r.sourcePoints)||r.sourcePoints<1||r.sourcePoints>50_000_000||!Number.isSafeInteger(r.count)||r.count<1||r.count>r.sourcePoints||!Number.isSafeInteger(r.rawBytes)||r.rawBytes<r.count||r.rawBytes>r.count*5||typeof r.data!=='string'||!r.data.length||r.data.length%4!==0)return true;
      payload+=r.data.length;return payload>12*1024**2||!/^[A-Za-z0-9+/]*={0,2}$/.test(r.data);
    }
    if('kind' in r)return true;
    if('axis' in r)return !['x','y','z'].includes(r.axis)||!Array.isArray(r.rangeM)||r.rangeM.length!==2||!r.rangeM.every(Number.isFinite)||r.rangeM[0]>=r.rangeM[1];
    return !Array.isArray(r.matrix)||r.matrix.length!==16||!r.matrix.every(Number.isFinite)||!Array.isArray(r.rect)||r.rect.length!==4||!r.rect.every((x:number)=>Number.isFinite(x)&&Math.abs(x)<=1)||r.rect[0]>r.rect[2]||r.rect[1]>r.rect[3];
  }))throw Error('点云清理记录无效。');
}
export function createMaskRule(indices:Uint32Array,sourcePoints:number):MaskClipRule {
  if(!indices.length)throw Error('笔画没有命中点。');
  indices.sort();const bytes=new Uint8Array(indices.length*5);let cursor=0,previous=-1;
  for(const value of indices){if(value<=previous||value>=sourcePoints)throw Error('笔画点号无效。');let delta=value-previous;previous=value;
    while(delta>=128){bytes[cursor++]=(delta&127)|128;delta=Math.floor(delta/128);}bytes[cursor++]=delta;
  }
  const packed=deflateSync(bytes.subarray(0,cursor),{level:1});let binary='';
  for(let i=0;i<packed.length;i+=16384)binary+=String.fromCharCode(...packed.subarray(i,i+16384));
  const rule:MaskClipRule={kind:'point-mask',mode:'remove',codec:'delta-deflate-v1',sourcePoints,count:indices.length,rawBytes:cursor,data:btoa(binary)};
  decodedMasks.set(rule,indices);return rule;
}
export function maskIndices(rule:MaskClipRule):Uint32Array {
  const cached=decodedMasks.get(rule);if(cached)return cached;
  validateClips([rule]);const binary=atob(rule.data),packed=Uint8Array.from(binary,c=>c.charCodeAt(0));
  const bytes=inflateSync(packed,{out:new Uint8Array(rule.rawBytes+1)});
  if(bytes.length!==rule.rawBytes)throw Error('点云笔画载荷长度无效。');
  const values=new Uint32Array(rule.count);let cursor=0,previous=-1;
  for(let i=0;i<values.length;i++){
    let delta=0,factor=1,part=0;
    do{if(cursor>=bytes.length||factor>268435456)throw Error('点云笔画点号无效。');part=bytes[cursor++]!;delta+=(part&127)*factor;factor*=128;}while(part&128);
    const next=previous+delta;if(!delta||next>=rule.sourcePoints)throw Error('点云笔画点号超出原件。');values[i]=next;previous=next;
  }
  if(cursor!==bytes.length)throw Error('点云笔画载荷多余。');decodedMasks.set(rule,values);return values;
}
export function pointInClip(x:number,y:number,z:number,rule:ClipRule,sourceIndex?:number):boolean {
  if(isMaskRule(rule)){
    if(sourceIndex===undefined)return false;const values=maskIndices(rule);let lo=0,hi=values.length-1;
    while(lo<=hi){const mid=(lo+hi)>>>1,v=values[mid]!;if(v===sourceIndex)return true;if(v<sourceIndex)lo=mid+1;else hi=mid-1;}return false;
  }
  if('axis' in rule){const v=rule.axis==='x'?x:rule.axis==='y'?y:z;return Number.isFinite(v)&&v>=rule.rangeM[0]&&v<=rule.rangeM[1];}
  const {matrix:m,rect:r}=rule,w=m[3]!*x+m[7]!*y+m[11]!*z+m[15]!;
  const u=(m[0]!*x+m[4]!*y+m[8]!*z+m[12]!)/w,v=(m[1]!*x+m[5]!*y+m[9]!*z+m[13]!)/w,depth=(m[2]!*x+m[6]!*y+m[10]!*z+m[14]!)/w;
  return w>0&&depth>=-1&&depth<=1&&u>=r[0]&&u<=r[2]&&v>=r[1]&&v<=r[3];
}
/** 每笔记录本次由可见变为隐藏的点号；撤销只恢复本笔，不重放整个历史。 */
export class ClipState {
  private entries:Array<{key:string;rule:ClipRule;changed:Uint32Array}>=[];
  retained:number;
  constructor(readonly cloud:PointCloudData){cloud.visible.fill(1);this.retained=cloud.visible.length;}
  sync(rules:ClipRule[]):number {
    validateClips(rules);const keys=rules.map(r=>JSON.stringify(r));let common=0;
    while(common<keys.length&&common<this.entries.length&&keys[common]===this.entries[common]!.key)common++;
    while(this.entries.length>common){const entry=this.entries.pop()!;for(const index of entry.changed)this.cloud.visible[index]=1;this.retained+=entry.changed.length;}
    for(let j=common;j<rules.length;j++){
      const rule=rules[j]!,changed:number[]=[];const {positions:p,visible}=this.cloud;
      if(isMaskRule(rule)){
        if(rule.sourcePoints!==visible.length)throw Error('笔画与完整源点数不匹配。');
        for(const index of maskIndices(rule))if(visible[index]){visible[index]=0;changed.push(index);}
      }else for(let i=0;i<visible.length;i++)if(visible[i]){
        const inside=pointInClip(p[i*3]!,p[i*3+1]!,p[i*3+2]!,rule);
        if(rule.mode==='remove'?inside:!inside){visible[i]=0;changed.push(i);}
      }
      this.retained-=changed.length;this.entries.push({key:keys[j]!,rule,changed:Uint32Array.from(changed)});
    }
    return this.retained;
  }
}
export function applyClips(cloud:PointCloudData,rules:ClipRule[]){return new ClipState(cloud).sync(rules);}
