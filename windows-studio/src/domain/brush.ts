import type {MaskClipRule} from './cleaning';
/** 像素轨迹使用CSS尺寸；viewMatrix将米制世界坐标变为相机坐标。 */
export interface BrushStroke { matrix:number[]; viewMatrix:number[]; viewport:[number,number]; path:Array<[number,number]>; radiusPx:number; depth:'surface'|'through'; thicknessM:number }
export interface BrushEditResult { rule?:MaskClipRule; visible:Uint8Array; affectedCount:number; retainedCount:number }
export function validateStroke(s:BrushStroke){
  const matrix=(m:unknown)=>Array.isArray(m)&&m.length===16&&m.every(Number.isFinite);
  if(!s||!matrix(s.matrix)||!matrix(s.viewMatrix)||!Array.isArray(s.viewport)||s.viewport.length!==2||!s.viewport.every(v=>Number.isFinite(v)&&v>=1&&v<=8192)||!Array.isArray(s.path)||!s.path.length||s.path.length>8192||!s.path.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=0&&p[1]>=0&&p[0]<=s.viewport[0]&&p[1]<=s.viewport[1])||!Number.isFinite(s.radiusPx)||s.radiusPx<1||s.radiusPx>300||!['surface','through'].includes(s.depth)||!Number.isFinite(s.thicknessM)||s.thicknessM<=0||s.thicknessM>10)throw Error('点云画笔参数无效。');
}
