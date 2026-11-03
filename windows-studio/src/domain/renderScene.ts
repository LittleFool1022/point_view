import type { BuildingModel } from './building';
export type RenderTheme = 'warm' | 'white' | 'concrete';
export interface RenderSceneSettings {
  theme: RenderTheme; levelId: string; exposure: number; sunAngle: number;
  camera?: { position: [number,number,number]; target: [number,number,number] };
}
export const DEFAULT_RENDER_SCENE: RenderSceneSettings = {theme:'warm',levelId:'',exposure:1.1,sunAngle:45};
export function assertRenderScene(s: any): asserts s is RenderSceneSettings {
  const vector=(v:any)=>Array.isArray(v)&&v.length===3&&v.every((x:any)=>Number.isFinite(x)&&Math.abs(x)<1e9);
  if(!s||!['warm','white','concrete'].includes(s.theme)||typeof s.levelId!=='string'||!Number.isFinite(s.exposure)||s.exposure<.3||s.exposure>2.5||!Number.isFinite(s.sunAngle)||s.sunAngle<0||s.sunAngle>360||s.camera&&(!vector(s.camera.position)||!vector(s.camera.target)||Math.hypot(...s.camera.position.map((x:number,i:number)=>x-s.camera.target[i]))<.001))throw Error('效果图场景参数无效。');
}
export function renderManifest(model:BuildingModel,settings:RenderSceneSettings,camera:{position:number[];target:number[];near:number;far:number;fov:number},width:number,height:number) {
  return {schema:'survey-render/1',purpose:'design-visualization',engine:'three-local',aiGenerated:false,createdAt:new Date().toISOString(),modelId:model.id,modelRevision:model.revision,source:{name:model.sourceName,sha256:model.sourceSha256,stamp:model.sourceStamp},settings,camera:{...camera,up:[0,0,1],units:'m'},image:{width,height},depth:{file:'depth.png',encoding:'8-bit linear grayscale',nearM:camera.near,farM:camera.far,nearValue:255,farValue:0,backgroundValue:0},files:['view.png','edges.png','depth.png','building.json'],limitations:['本地材质渲染，非AI生成；材质与环境地面为设计表达。','使用当前模型几何；未复核构件和假设尺寸不转为实测结论。','深度图为8位线性相机深度，不是精密测量数据。'],assumptions:model.assumptions??[],unreviewed:[...model.walls,...model.openings,...model.rooms].filter(e=>!e.evidence.confirmed).length};
}
