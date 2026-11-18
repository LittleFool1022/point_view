import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';
import {decodeProject} from '../src/domain/project';
async function downloaded(page:Page,name:string){const pending=page.waitForEvent('download');await page.getByRole('button',{name,exact:true}).click();return readFile((await(await pending).path())!);}
test('CAD 主流程独立交付、捕捉尺寸、撤销重做以及旧图保存恢复',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 await expect(page.getByRole('button',{name:'点云与 CAD',exact:true})).toHaveAttribute('aria-current','page');
 await expect(page.getByRole('button',{name:'建筑模型',exact:true})).not.toBeVisible();
 await page.getByRole('button',{name:'打开示例',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('合成示例');
 await page.getByRole('button',{name:'智能出图',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('工程图已生成');
 await page.getByRole('button',{name:'CAD 图层',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:/家具/})).not.toBeChecked();
 await page.getByRole('button',{name:'关闭 CAD 图层',exact:true}).click();
 const initial=unzipSync(await downloaded(page,'导出三视图成果包'));
 const annotations=JSON.parse(strFromU8(Object.entries(initial).find(([n])=>n.endsWith('.annotations.json'))![1]));
 const wall=annotations.entities.find((e:any)=>e.layer==='OBSERVED_WALL'&&e.type==='line');expect(wall).toBeTruthy();
 const canvas=page.getByLabel('CAD 图纸预览画布',{exact:true}),box=(await canvas.boundingBox())!,center=JSON.parse((await canvas.getAttribute('data-drawing-center'))!),scale=Number(await canvas.getAttribute('data-drawing-scale'));
 const screen=(p:number[])=>({x:box.x+box.width/2+(p[0]-center[0])*scale,y:box.y+box.height/2-(p[1]-center[1])*scale});
 const a=screen(wall.geometry.start_mm),b=screen(wall.geometry.end_mm);
 await page.getByText('尺寸与工程标注',{exact:true}).click();
 await page.getByRole('button',{name:'标注尺寸',exact:true}).click();
 // 有意偏离端点 4px，验证写入的是精确端点而非点击坐标。
 await page.mouse.click(a.x+4,a.y+3);await expect(page.locator('.cad-preview-shell')).toHaveAttribute('data-dimension-step','1');
 await page.mouse.click(b.x-4,b.y+3);await expect(page.locator('.cad-preview-shell')).toHaveAttribute('data-dimension-step','2');
 await page.mouse.click((a.x+b.x)/2,(a.y+b.y)/2+45);await expect(page.locator('.cad-preview-shell')).toHaveAttribute('data-dimension-step','0');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'撤销 CAD 编辑',exact:true}).click();await page.getByRole('button',{name:'重做 CAD 编辑',exact:true}).click();
 const final=unzipSync(await downloaded(page,'导出三视图成果包'));const record=JSON.parse(strFromU8(Object.entries(final).find(([n])=>n.endsWith('.annotations.json'))![1]));
 const manual=record.dimensions.find((d:any)=>d.source==='manual');expect(manual.start).toEqual(wall.geometry.start_mm);expect(manual.end).toEqual(wall.geometry.end_mm);
 const review=JSON.parse(strFromU8(final['survey-drawing/review.json']));expect(review.constructionAccepted).toBe(false);expect(review.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
 await page.getByText('出图设置',{exact:true}).click();
 await page.getByLabel('图幅',{exact:true}).selectOption('A2');await page.getByLabel('出图比例',{exact:true}).selectOption('1:100');await page.getByLabel('尺寸取整 mm',{exact:true}).selectOption('0.1');
 await expect(page.getByRole('button',{name:'导出三视图成果包',exact:true})).toBeEnabled();
 const restyled=unzipSync(await downloaded(page,'导出三视图成果包'));const styledRecord=JSON.parse(strFromU8(Object.entries(restyled).find(([n])=>n.endsWith('.annotations.json'))![1]));
 expect(styledRecord.dimensions.find((d:any)=>d.id===manual.id)).toMatchObject({start:manual.start,end:manual.end,linePoint:manual.linePoint,roundingMm:.1,unit:'m'});
 expect(styledRecord.entities.find((e:any)=>e.id===`${manual.id}:text`).text).toMatch(/ m$/);
 expect(strFromU8(restyled['survey-drawing/multiview.html'])).toContain('size:594mm 420mm');
 await page.screenshot({path:'artifacts/cad-core-20261029/cad-dimensions.png'});
 await page.getByRole('button',{name:'图纸交付',exact:true}).click();await expect(page.getByRole('button',{name:'导出成果包',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'生成同修订成果包',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'点云与 CAD',exact:true}).click();
 const saved=await downloaded(page,'保存工程');const entries=unzipSync(saved);const project=JSON.parse(strFromU8(entries['project.json']));expect(project.drawingStale).toBe(false);expect(project.projection).toBe('xy');expect(project.drawing.view).toBe('top_xy');expect(project.drawing.parameters.analysisMode).toBe('point-cloud-multi-view');expect(project.drawing.dimensions.some((d:any)=>d.id===manual.id)).toBe(true);
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'打开工程',exact:true}).click();await(await chooser).setFiles({name:'restored.pvplan',mimeType:'application/octet-stream',buffer:saved});await expect(page.locator('.status-bar')).toContainText('测量工程已恢复');await expect(page.getByRole('button',{name:'导出三视图成果包',exact:true})).toBeEnabled();
 expect(errors).toEqual([]);
});
test('任一视图生成失败时保留当前总图和人工编辑历史',async({page})=>{
 await page.addInitScript(()=>{
  const host=window as Window&{__failXz?:boolean};host.__failXz=false;
  const original=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(message:unknown){
   const data=message as {action?:string;projection?:string;id?:number;settings?:Record<string,unknown>};
   if(host.__failXz&&data.action==='drawing'&&data.projection==='xz')original.call(this,{...data,settings:{...data.settings,roundingMm:-1}});
   else original.call(this,message);
  };
 });
 await page.goto('/');await page.getByRole('button',{name:'打开示例',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('合成示例');
 await page.getByRole('button',{name:'智能出图',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('工程图已生成');
 const initial=await downloaded(page,'保存工程'),project=await decodeProject(initial.slice().buffer as ArrayBuffer),drawing=project.drawing;
 if(!drawing)throw Error('测试图纸缺失');
 const wall=drawing.entities.find(entity=>entity.type==='line'&&entity.category==='wall');if(!wall||wall.type!=='line')throw Error('测试墙线缺失');
 const canvas=page.getByLabel('CAD 图纸预览画布',{exact:true}),box=(await canvas.boundingBox())!,center=JSON.parse((await canvas.getAttribute('data-drawing-center'))!),scale=Number(await canvas.getAttribute('data-drawing-scale'));
 const screen=(point:number[])=>({x:box.x+box.width/2+(point[0]!-center[0])*scale,y:box.y+box.height/2-(point[1]!-center[1])*scale}),a=screen(wall.start),b=screen(wall.end);
 await page.getByText('尺寸与工程标注',{exact:true}).click();
 await page.getByRole('button',{name:'标注尺寸',exact:true}).click();await page.mouse.click(a.x+2,a.y-2);await page.mouse.click(b.x-2,b.y+2);await page.mouse.click((a.x+b.x)/2,(a.y+b.y)/2+40);
 await page.getByRole('button',{name:'撤销 CAD 编辑',exact:true}).click();await expect(page.getByRole('button',{name:'重做 CAD 编辑',exact:true})).toBeEnabled();
 await page.evaluate(()=>{(window as Window&{__failXz?:boolean}).__failXz=true;});
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'智能出图',exact:true}).click();
 await expect(page.locator('.status-bar')).toContainText('尺寸定义无效或尺寸为零');
 await expect(page.getByRole('button',{name:'重做 CAD 编辑',exact:true})).toBeEnabled();await page.getByRole('button',{name:'重做 CAD 编辑',exact:true}).click();
 const preserved=await decodeProject((await downloaded(page,'保存工程')).slice().buffer as ArrayBuffer);
 expect(preserved.drawing?.drawingId).toBe(drawing.drawingId);expect(preserved.drawing?.dimensions?.some(d=>d.source==='manual')).toBe(true);
});

test('高度剖切可重复设置、撤销并随工程保存，建筑扩展需显式进入',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'打开示例',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('合成示例');
 const retained=page.locator('.clean-history'),count=async()=>Number(/保留 ([\d,]+) 点/.exec(await retained.innerText())![1].replaceAll(',',''));
 await expect.poll(count).toBeGreaterThan(0);const initialPoints=await count();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByLabel('剖切下限 m').fill('.5');await page.getByLabel('剖切上限 m').fill('1.8');await page.getByRole('button',{name:'保留高度范围',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('已应用 1 次清理');
 await expect.poll(count).toBeLessThan(initialPoints);const narrowPoints=await count();
 await page.getByLabel('剖切下限 m').fill('0');await page.getByLabel('剖切上限 m').fill('3');await page.getByRole('button',{name:'保留高度范围',exact:true}).click();
 await expect.poll(count).toBe(initialPoints);await expect(page.locator('.clean-history')).toContainText('1 次清理');
 const saved=unzipSync(await downloaded(page,'保存工程'));expect(JSON.parse(strFromU8(saved['project.json'])).source.clips).toEqual([{axis:'z',rangeM:[0,3],mode:'keep'}]);
 await page.getByRole('button',{name:'撤销',exact:true}).click();await expect.poll(count).toBe(narrowPoints);await expect(page.locator('.status-bar')).toContainText('已应用 1 次清理');
 await page.getByRole('button',{name:'撤销',exact:true}).click();await expect.poll(count).toBe(initialPoints);await expect(page.locator('.status-bar')).toContainText('已应用 0 次清理');
 await page.locator('.extensions-menu>summary').click();await page.getByRole('button',{name:'建筑模型',exact:true}).click();await expect(page.getByRole('button',{name:'从点云生成建筑候选',exact:true})).toBeVisible();await expect(page.locator('.extensions-menu')).not.toHaveAttribute('open','');
});
