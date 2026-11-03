import { openingPieces } from "./domain/openingTemplates";
import {useEffect,useRef,useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {zipSync,strToU8} from 'fflate';
import {wallPieces,validateBuilding,type BuildingModel} from './domain/building';
import {DEFAULT_RENDER_SCENE,renderManifest,type RenderSceneSettings} from './domain/renderScene';
import {saveFile} from './platform';

type Props={model?:BuildingModel;settings?:RenderSceneSettings;stale:boolean;busy:boolean;onChange:(s:RenderSceneSettings)=>void;onNotice:(s:string)=>void;onBuilding:()=>void;onExporting:(active:boolean)=>void};
const palettes={warm:{wall:'#f1e6d6',floor:'#b5a085',door:'#785641',background:'#ede8df'},white:{wall:'#f7f8f5',floor:'#c9c5bc',door:'#66756d',background:'#e5ece9'},concrete:{wall:'#aeb3b1',floor:'#777d7b',door:'#444f51',background:'#dbe1e2'}};
export function RenderWorkspace({model,settings,stale,busy,onChange,onNotice,onBuilding,onExporting}:Props){
  const config=settings??DEFAULT_RENDER_SCENE,host=useRef<HTMLDivElement>(null);
  const api=useRef<{capture:(bundle:boolean)=>Promise<void>;preset:(name:string)=>void} | undefined>(undefined);
  const [ready,setReady]=useState(false),[exporting,setExporting]=useState(false),[error,setError]=useState('');
  const callbacks=useRef({onChange,onNotice});callbacks.current={onChange,onNotice};
  const invalid=model?validateBuilding(model).some(i=>i.code!=='UNREVIEWED'):false;
  const emptyLevel=!!config.levelId&&!model?.walls.some(w=>w.levelId===config.levelId);
  const enabled=!!model?.walls.length&&!invalid&&!emptyLevel&&!stale&&!busy;
  useEffect(()=>{
    setReady(false);setError('');
    if(!host.current||!model||!model.walls.length||invalid)return;
    const node=host.current,palette=palettes[config.theme];
    let renderer:THREE.WebGLRenderer;
    try{renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});}catch{setError('无法建立图形上下文，请检查显卡与驱动。');return;}
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=config.exposure;
    node.append(renderer.domElement);
    const scene=new THREE.Scene();scene.background=new THREE.Color(palette.background);
    const camera=new THREE.PerspectiveCamera(45,1,.05,1000);camera.up.set(0,0,1);
    const controls=new OrbitControls(camera,renderer.domElement);controls.minDistance=.1;controls.maxPolarAngle=Math.PI*.95;
    const solids=new THREE.Group(),edges=new THREE.Group();edges.visible=false;scene.add(solids,edges);
    const geometries:THREE.BufferGeometry[]=[],materials:THREE.Material[]=[];
    const edgeMaterial=new THREE.LineBasicMaterial({color:'#1d2928'});materials.push(edgeMaterial);
    const mesh=(g:THREE.BufferGeometry,mat:THREE.Material,x:number,y:number,z:number,angle=0)=>{
      geometries.push(g);materials.push(mat);const m=new THREE.Mesh(g,mat);m.position.set(x,y,z);m.rotation.z=angle;m.castShadow=true;m.receiveShadow=true;solids.add(m);
      const eg=new THREE.EdgesGeometry(g,25);geometries.push(eg);const line=new THREE.LineSegments(eg,edgeMaterial);line.position.copy(m.position);line.rotation.copy(m.rotation);edges.add(line);return m;
    };
    const standard=(color:string)=>new THREE.MeshStandardMaterial({color,roughness:config.theme==='concrete'?.95:.7,side:THREE.DoubleSide});
    const levels=config.levelId?model.levels.filter(l=>l.id===config.levelId):model.levels;
    const ids=new Set(levels.map(l=>l.id));
    for(const wall of model.walls.filter(w=>ids.has(w.levelId))){
      const level=levels.find(l=>l.id===wall.levelId)!;const angle=Math.atan2(wall.axisM[1][1]-wall.axisM[0][1],wall.axisM[1][0]-wall.axisM[0][0]);
      for(const p of wallPieces(wall,model.openings))mesh(new THREE.BoxGeometry(p.width,wall.thicknessM,p.height),standard(palette.wall),wall.axisM[0][0]+Math.cos(angle)*p.x,wall.axisM[0][1]+Math.sin(angle)*p.x,level.elevationM+p.z,angle);
      for(const o of model.openings.filter(o=>o.wallId===wall.id))for(const p of openingPieces(o,wall.thicknessM)){
        const d=o.offsetM+p.x,mat=p.material==='glass'?new THREE.MeshStandardMaterial({color:'#a8d6df',transparent:true,opacity:.28,roughness:.12,depthWrite:false}):standard(p.material==='frame'?'#52615c':palette.door);
        mesh(new THREE.BoxGeometry(p.width,p.depth,p.height),mat,wall.axisM[0][0]+Math.cos(angle)*d,wall.axisM[0][1]+Math.sin(angle)*d,level.elevationM+o.sillM+p.z,angle);
      }
    }
    for(const room of model.rooms.filter(r=>ids.has(r.levelId))){const shape=new THREE.Shape(room.boundaryM.map(p=>new THREE.Vector2(...p)));mesh(new THREE.ShapeGeometry(shape),standard(palette.floor),0,0,levels.find(l=>l.id===room.levelId)!.elevationM+.01);}
    const box=new THREE.Box3().setFromObject(solids),center=box.isEmpty()?new THREE.Vector3():box.getCenter(new THREE.Vector3()),radius=box.isEmpty()?10:Math.max(3,box.getSize(new THREE.Vector3()).length());
    camera.far=Math.max(100,radius*12);camera.updateProjectionMatrix();
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(radius*8,radius*8),standard(palette.background));geometries.push(ground.geometry);materials.push(ground.material);ground.position.set(center.x,center.y,box.isEmpty()?-.03:box.min.z-.03);ground.receiveShadow=true;scene.add(ground);
    // 环境地面只是承接阴影，不纳入模型、边线或深度约束。
    scene.add(new THREE.HemisphereLight(0xffffff,0x73877c,2));
    const sun=new THREE.DirectionalLight('#fff3dc',4),angle=config.sunAngle*Math.PI/180;sun.position.copy(center).add(new THREE.Vector3(Math.cos(angle)*radius,Math.sin(angle)*radius,radius*1.2));sun.target.position.copy(center);scene.add(sun.target);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-radius;sun.shadow.camera.right=radius;sun.shadow.camera.top=radius;sun.shadow.camera.bottom=-radius;sun.shadow.camera.far=radius*5;sun.shadow.normalBias=.025;scene.add(sun);
    const render=()=>renderer.render(scene,camera);
    const remember=()=>callbacks.current.onChange({...config,camera:{position:camera.position.toArray() as [number,number,number],target:controls.target.toArray() as [number,number,number]}});
    const preset=(name:string)=>{
      controls.target.copy(center);
      if(name==='top')camera.position.copy(center).add(new THREE.Vector3(0,-.001,radius*1.25));
      else if(name==='front')camera.position.copy(center).add(new THREE.Vector3(0,-radius*1.2,radius*.3));
      else camera.position.copy(center).add(new THREE.Vector3(radius*.75,-radius*.85,radius*.65));
      controls.update();render();remember();
    };
    if(config.camera){camera.position.fromArray(config.camera.position);controls.target.fromArray(config.camera.target);}else{camera.position.copy(center).add(new THREE.Vector3(radius*.75,-radius*.85,radius*.65));controls.target.copy(center);}controls.update();
    const resize=()=>{const w=Math.max(1,node.clientWidth),h=Math.max(1,node.clientHeight);renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();render();};
    const observer=new ResizeObserver(resize);observer.observe(node);controls.addEventListener('change',render);controls.addEventListener('end',remember);resize();
    const png=async(label?:string)=>{
      render();const out=document.createElement('canvas');out.width=renderer.domElement.width;out.height=renderer.domElement.height;const ctx=out.getContext('2d')!;ctx.drawImage(renderer.domElement,0,0);
      if(label){ctx.fillStyle='#fff';ctx.fillRect(0,out.height-52,out.width,52);ctx.fillStyle='#243d36';ctx.font='18px sans-serif';ctx.fillText(label,20,out.height-20);}
      const blob=await new Promise<Blob>((resolve,reject)=>out.toBlob(b=>b?resolve(b):reject(Error('图片编码失败。')),'image/png'));return new Uint8Array(await blob.arrayBuffer());
    };
    api.current={preset,capture:async(bundle)=>{
      controls.enabled=false;
      const width=1920,height=1080,oldSize=renderer.getSize(new THREE.Vector2()),ratio=renderer.getPixelRatio(),oldAspect=camera.aspect;
      const background=scene.background,oldTone=renderer.toneMapping;
      const white=new THREE.MeshBasicMaterial({color:'white',side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});
      const originalMaterials=solids.children.map(o=>(o as THREE.Mesh).material);
      const depth=new THREE.ShaderMaterial({uniforms:{nearM:{value:camera.near},farM:{value:camera.far}},vertexShader:'varying float vDepth; void main(){vec4 p=modelViewMatrix*vec4(position,1.0);vDepth=-p.z;gl_Position=projectionMatrix*p;}',fragmentShader:'uniform float nearM;uniform float farM;varying float vDepth;void main(){float d=1.0-clamp((vDepth-nearM)/(farM-nearM),0.0,1.0);gl_FragColor=vec4(vec3(d),1.0);}',side:THREE.DoubleSide});
      try{
        renderer.setPixelRatio(1);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();
        const view=await png(`观曜 · 本地建筑渲染 · 修订 ${model.revision} · 设计表达 / 非测量成果`);
        let data=view,name='建筑效果图.png';
        if(bundle){
          ground.visible=false;renderer.toneMapping=THREE.NoToneMapping;scene.background=new THREE.Color('white');solids.children.forEach(o=>(o as THREE.Mesh).material=white);edges.visible=true;const edge=await png();
          solids.children.forEach((o,i)=>(o as THREE.Mesh).material=originalMaterials[i]!);
          edges.visible=false;scene.background=new THREE.Color('black');scene.overrideMaterial=depth;const depthImage=await png();
          const actual={...config,camera:{position:camera.position.toArray() as [number,number,number],target:controls.target.toArray() as [number,number,number]}};
          const manifest=renderManifest(model,actual,{position:camera.position.toArray(),target:controls.target.toArray(),near:camera.near,far:camera.far,fov:camera.fov},width,height);
          data=zipSync({'view.png':view,'edges.png':edge,'depth.png':depthImage,'render.json':strToU8(JSON.stringify(manifest,null,2)),'building.json':strToU8(JSON.stringify(model,null,2))});name='建筑效果图与约束.zip';
        }
        callbacks.current.onNotice(await saveFile(name,data)?'建筑渲染已保存，保留当前模型修订和视角。':'已取消保存。');
      }finally{solids.children.forEach((o,i)=>(o as THREE.Mesh).material=originalMaterials[i]!);scene.overrideMaterial=null;scene.background=background;ground.visible=true;edges.visible=false;renderer.toneMapping=oldTone;renderer.setPixelRatio(ratio);renderer.setSize(oldSize.x,oldSize.y);camera.aspect=oldAspect;camera.updateProjectionMatrix();white.dispose();depth.dispose();controls.enabled=true;render();}
    }};
    setReady(true);
    return()=>{api.current=undefined;observer.disconnect();controls.dispose();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());sun.shadow.dispose();renderer.dispose();renderer.domElement.remove();};
  },[model,config,invalid]);
  const change=(p:Partial<RenderSceneSettings>)=>onChange({...config,...p});
  const capture=async(bundle:boolean)=>{if(!enabled||!ready||!api.current)return;setExporting(true);onExporting(true);try{await api.current.capture(bundle);}catch(e){onNotice(e instanceof Error?e.message:'效果图导出失败。');}finally{setExporting(false);onExporting(false);}};
  return <main className="render-workspace"><div className="work-toolbar"><div></div><button disabled={exporting||busy} onClick={onBuilding}>编辑建筑模型</button><button disabled={!enabled||!ready||exporting} onClick={()=>capture(false)}>导出效果图 PNG</button><button className="primary" disabled={!enabled||!ready||exporting} onClick={()=>capture(true)}>{exporting?'正在导出…':'导出图片与约束包'}</button></div>
    {stale&&<p className="bim-warning">测量依据已变化，请到建筑模型更新关联并复核，再导出效果图。</p>}
    <div className="render-body"><section className="render-viewport"><div className="render-canvas" ref={host} aria-label="建筑效果图三维视图">{(!model?.walls.length||invalid||error)&&<div className="render-empty"><h2>{error||(!model?.walls.length?'先建立建筑模型':'建筑模型存在几何问题')}</h2><button onClick={onBuilding}>前往建筑模型</button></div>}</div></section>
    <aside className="render-controls"><fieldset disabled={!model||invalid||stale||busy||exporting}><legend>场景设置</legend><label>效果图楼层<select aria-label="效果图楼层" value={config.levelId} onChange={e=>change({levelId:e.target.value,camera:undefined})}><option value="">全部楼层</option>{model?.levels.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><label>材质方案<select aria-label="材质方案" value={config.theme} onChange={e=>change({theme:e.target.value as RenderSceneSettings['theme']})}><option value="warm">暖木与米白</option><option value="white">现代素白</option><option value="concrete">清水混凝土</option></select></label><label>曝光 {config.exposure.toFixed(1)}<input aria-label="效果图曝光" type="range" min="0.3" max="2.5" step="0.1" value={config.exposure} onChange={e=>change({exposure:Number(e.target.value)})}/></label><label>日照方向 {config.sunAngle}°<input aria-label="日照方向" type="range" min="0" max="360" step="15" value={config.sunAngle} onChange={e=>change({sunAngle:Number(e.target.value)})}/></label><div className="tool-grid">{[['iso','轴测视角'],['top','俯视效果'],['front','正面视角']].map(([id,name])=><button key={id} onClick={()=>api.current?.preset(id!)}>{name}</button>)}</div></fieldset>
    {emptyLevel&&<p className="help">当前楼层没有墙体，请选择其他楼层。</p>}<h2>模型依据</h2><p>{model?`修订 ${model.revision} · ${model.walls.length} 墙 · ${model.rooms.length} 房间`:'未建立模型'}</p><p className="help">本地渲染 · 1920 × 1080</p>{model&&<p className="help">{[...model.walls,...model.openings,...model.rooms].filter(e=>!e.evidence.confirmed).length} 个构件待复核。</p>}</aside></div></main>;
}
