import {openStudioView} from "./studioPage";
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';
import {buildingFromSegments} from '../src/domain/buildingOps';
import {encodeProject} from '../src/domain/project';
import {demoRoom} from '../src/domain/demo';
import type {Vec2} from '../src/domain/building';

test('旧工程改墙名保留4米房间，更新BIM图纸保留门窗、标注与修订关联',async({page})=>{
  const source={name:'review.pcd',bytes:demoRoom(),units:'m' as const,synthetic:true};
  const p:Vec2[]=[[0,0],[8,0],[8,6],[0,6]];
  const model=buildingFromSegments(source,{elevationM:0,heightM:4,thicknessM:.2,levelName:'旧工程楼层'},p.map((a,i)=>({a,b:p[(i+1)%4]!,support:20,rmsM:.01})));
  model.openings=[{id:'door',kind:'door',wallId:model.walls[0]!.id,offsetM:1,widthM:.9,heightM:2.1,sillM:0,evidence:{...model.walls[0]!.evidence}},
    {id:'window',kind:'window',wallId:model.walls[0]!.id,offsetM:4,widthM:1.2,heightM:1.2,sillM:.9,evidence:{...model.walls[0]!.evidence}}];
  const bytes=await encodeProject({source,building:model,annotations:[],settings:{},projection:'xy'});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const btn=(name:string)=>page.getByRole('button',{name,exact:true});
  await page.goto('/');const choose=page.waitForEvent('filechooser');await btn('打开工程').click();
  await(await choose).setFiles({name:'review.pvplan',mimeType:'application/octet-stream',buffer:Buffer.from(bytes)});
  await expect(page.locator('.status-bar')).toContainText('测量工程已恢复');
  await openStudioView(page,"建筑模型");await btn('由模型生成平面图').click();
  await page.getByLabel('标注内容',{exact:true}).fill('保留此标注');await btn('在图纸放置标注').click();
  const canvas=page.getByLabel('在图纸中放置标注 保留此标注',{exact:true});const bounds=(await canvas.boundingBox())!;
  await page.mouse.click(bounds.x+bounds.width*.5,bounds.y+bounds.height*.5);
  await openStudioView(page,"建筑模型");await page.locator('.element-list button').first().click();
  await page.getByLabel('构件名称',{exact:true}).fill('仅改墙名');await btn('应用构件修改').click();
  await btn('点云与 CAD').click();await expect(btn('导出 DXF 成果包')).toBeDisabled();
  await btn('更新工程图').click();await expect(page.locator('.status-bar')).toContainText('模型平面图已生成');
  await expect(btn('导出 DXF 成果包')).toBeEnabled();
  const saving=page.waitForEvent('download');await btn('保存工程').click();const saved=await saving;
  const state=JSON.parse(strFromU8(unzipSync(await readFile((await saved.path())!))['project.json']!));
  expect(state.building.rooms).toEqual(model.rooms);
  expect(state.drawing.statistics.doorCount).toBe(1);expect(state.drawing.statistics.windowCount).toBe(1);
  expect(state.drawing.statistics.roomCount).toBe(1);
  expect(state.drawing.entities.some((e:any)=>e.category==='door'&&e.source==='derived')).toBe(true);
  expect(state.drawing.entities.some((e:any)=>e.category==='window'&&e.source==='derived')).toBe(true);
  expect(state.drawing.parameters).toMatchObject({analysisMode:'building-model',buildingId:model.id,buildingLevelId:model.levels[0]!.id,buildingRevision:state.building.revision});
  expect(state.annotations).toHaveLength(1);expect(state.annotations[0].text).toBe('保留此标注');
  expect(state.drawing.annotations).toHaveLength(1);
  // 模型被替换后应明确阻止更新，不能退回点云提取并恢复导出。
  await openStudioView(page,"建筑模型");await btn('新建空建筑模型').click();await btn('点云与 CAD').click();await btn('更新工程图').click();
  await expect(page.locator('.status-bar')).toContainText('原图关联的建筑模型或楼层已不存在');
  await expect(btn('导出 DXF 成果包')).toBeDisabled();expect(errors).toEqual([]);
});
