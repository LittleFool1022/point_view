import { openingPieces } from "./domain/openingTemplates";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PointCloudData } from "../../src/domain/types";
import { wallPieces, type BuildingModel } from "./domain/building";
export function BuildingScene({model,levelId,selectedId,cloud,onSelect}:{model?:BuildingModel;levelId?:string;selectedId?:string;cloud?:PointCloudData;onSelect:(id:string)=>void}) {
  const host=useRef<HTMLDivElement>(null), select=useRef(onSelect); select.current=onSelect;
  const pose=useRef<{id:string;position:THREE.Vector3;target:THREE.Vector3} | undefined>(undefined);
  useEffect(()=>{
    if(!host.current||!model)return;
    const node=host.current,scene=new THREE.Scene();scene.background=new THREE.Color('#edf1ef');
    const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));node.append(renderer.domElement);
    const camera=new THREE.PerspectiveCamera(45,1,.01,10000);camera.up.set(0,0,1);const controls=new OrbitControls(camera,renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff,2));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(5,-8,20);scene.add(light);
    const meshes:THREE.Mesh[]=[], geometries:THREE.BufferGeometry[]=[],materials:THREE.Material[]=[];
    const addBox=(id:string,x:number,y:number,z:number,w:number,d:number,h:number,angle:number,color:string,opacity=1)=>{
      const geometry=new THREE.BoxGeometry(w,d,h),material=new THREE.MeshStandardMaterial({color:id===selectedId?'#e79a35':color,transparent:opacity<1,opacity,roughness:.85});geometries.push(geometry);materials.push(material);
      const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);mesh.rotation.z=angle;mesh.userData.id=id;scene.add(mesh);meshes.push(mesh);
    };
    for(const wall of model.walls.filter(w=>!levelId||w.levelId===levelId)) {
      const level=model.levels.find(l=>l.id===wall.levelId)!;const angle=Math.atan2(wall.axisM[1][1]-wall.axisM[0][1],wall.axisM[1][0]-wall.axisM[0][0]);
      for(const p of wallPieces(wall,model.openings))addBox(wall.id,wall.axisM[0][0]+Math.cos(angle)*p.x,wall.axisM[0][1]+Math.sin(angle)*p.x,level.elevationM+p.z,p.width,wall.thicknessM,p.height,angle,wall.evidence.confirmed?'#d4ded9':'#e2d9c8');
      for(const o of model.openings.filter(o=>o.wallId===wall.id))for(const p of openingPieces(o,wall.thicknessM)){const x=o.offsetM+p.x;addBox(o.id,wall.axisM[0][0]+Math.cos(angle)*x,wall.axisM[0][1]+Math.sin(angle)*x,level.elevationM+o.sillM+p.z,p.width,p.depth,p.height,angle,p.material==='glass'?'#74b6ce':p.material==='frame'?'#54665e':'#9c7955',p.material==='glass'?.45:1);}
    }
    for(const room of model.rooms.filter(r=>!levelId||r.levelId===levelId)){const shape=new THREE.Shape(room.boundaryM.map(p=>new THREE.Vector2(...p))),g=new THREE.ShapeGeometry(shape),mat=new THREE.MeshBasicMaterial({color:room.id===selectedId?'#e79a35':'#96b5a1',side:THREE.DoubleSide,transparent:true,opacity:.5});geometries.push(g);materials.push(mat);const mesh=new THREE.Mesh(g,mat);mesh.position.z=model.levels.find(l=>l.id===room.levelId)!.elevationM+.015;mesh.userData.id=room.id;scene.add(mesh);meshes.push(mesh);}
    const bounds=new THREE.Box3();for(const mesh of meshes)bounds.expandByObject(mesh);
    if(bounds.isEmpty()){bounds.min.set(-5,-5,0);bounds.max.set(5,5,3);}
    if(cloud){const pos:number[]=[],rgb:number[]=[];for(let i=0;i<cloud.visible.length;i++)if(cloud.visible[i]){pos.push(...cloud.positions.subarray(i*3,i*3+3));rgb.push(cloud.colors[i*3]!/255,cloud.colors[i*3+1]!/255,cloud.colors[i*3+2]!/255);}const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('color',new THREE.Float32BufferAttribute(rgb,3));const mat=new THREE.PointsMaterial({vertexColors:true,size:.025,transparent:true,opacity:.55});geometries.push(g);materials.push(mat);scene.add(new THREE.Points(g,mat));}
    const center=bounds.getCenter(new THREE.Vector3()),r=Math.max(2,bounds.getSize(new THREE.Vector3()).length());camera.position.copy(center).add(new THREE.Vector3(r*.7,-r*.8,r*.65));controls.target.copy(center);
    if(pose.current?.id===model.id){camera.position.copy(pose.current.position);controls.target.copy(pose.current.target);}controls.update();
    const render=()=>renderer.render(scene,camera),resize=()=>{renderer.setSize(node.clientWidth,node.clientHeight);camera.aspect=node.clientWidth/Math.max(1,node.clientHeight);camera.updateProjectionMatrix();render();};
    const ray=new THREE.Raycaster();let down:[number,number]=[0,0];const begin=(e:PointerEvent)=>{down=[e.clientX,e.clientY];};const pick=(e:PointerEvent)=>{if(Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;const b=renderer.domElement.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2((e.clientX-b.left)/b.width*2-1,1-(e.clientY-b.top)/b.height*2),camera);const hit=ray.intersectObjects(meshes)[0];if(hit)select.current(hit.object.userData.id);};
    renderer.domElement.addEventListener('pointerdown',begin);renderer.domElement.addEventListener('pointerup',pick);controls.addEventListener('change',render);const observer=new ResizeObserver(resize);observer.observe(node);resize();
    return()=>{pose.current={id:model.id,position:camera.position.clone(),target:controls.target.clone()};observer.disconnect();controls.dispose();renderer.domElement.removeEventListener('pointerdown',begin);renderer.domElement.removeEventListener('pointerup',pick);geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());renderer.dispose();renderer.domElement.remove();};
  },[model,levelId,selectedId,cloud]);
  return <div className="building-scene" ref={host} aria-label="建筑模型三维视图">{!model&&<div className="empty-view"><strong>建立可编辑建筑模型</strong><span>生成墙体候选，或新建模型后绘制墙体。</span></div>}</div>;
}
