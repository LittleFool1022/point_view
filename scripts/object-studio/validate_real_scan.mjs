import {_electron as electron,expect} from '@playwright/test';import {writeFile,stat} from 'node:fs/promises';import path from 'node:path';
const root=process.cwd(),out=path.join(root,'artifacts/object-studio-validation');
const app=await electron.launch({executablePath:path.join(root,'.tools/electron-43.2.0/electron'),args:[path.join(root,'scripts/object-studio/electron-validation.cjs'),'--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader'],env:{...process.env,POINT_VIEW_OBJECT_PYTHON:path.join(root,'.tools/object-runtime/bin/python')},timeout:30000});const page=await app.firstWindow(),result={checks:[],errors:[]};page.on('pageerror',e=>result.errors.push(e.message));
try{
 await app.evaluate(({dialog},out)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[out+'/stanford-raw.pcd']});dialog.showSaveDialog=async({defaultPath})=>({canceled:false,filePath:out+'/'+defaultPath});},out);
 await page.getByRole('button',{name:'工作台',exact:true}).click();await page.getByRole('button',{name:'导入',exact:true}).first().click();await expect(page.locator('.cloud-hud')).toContainText('40,256');
 await page.getByRole('button',{name:'创作',exact:true}).click();await page.waitForTimeout(600);await page.getByRole('button',{name:'框选添加',exact:true}).click();const box=await page.locator('.object-stage .point-cloud-canvas canvas').boundingBox();
 await page.mouse.move(box.x+box.width*.025,box.y+box.height*.18);await page.mouse.down();await page.mouse.move(box.x+box.width*.975,box.y+box.height*.84,{steps:10});await page.mouse.up();await expect(page.locator('.object-selection-count strong')).toHaveText('40,256');
 await page.getByRole('button',{name:'确认物体',exact:true}).click();await page.getByLabel('作品名称').fill('real-bunny');await page.getByRole('button',{name:'生成物体表面',exact:true}).click();await expect(page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true})).toBeVisible({timeout:30000});
 await expect(page.getByRole('button',{name:'采集原色',exact:true})).toBeDisabled();await expect(page.locator('.object-preview')).toHaveAttribute('data-material','plaster');
 await page.locator('.object-inspector-scroll').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(500);await page.screenshot({path:out+'/real-scan-studio.png'});
 await page.getByLabel('显示尺寸与实际物体相符').check();await page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true}).click();await expect.poll(async()=>{try{return(await stat(out+'/real-bunny.glb')).size;}catch{return 0;}}).toBeGreaterThan(1000);
 await page.getByRole('button',{name:'保存原貌',exact:true}).click();await expect.poll(async()=>{try{return(await stat(out+'/real-bunny.ply')).size;}catch{return 0;}}).toBeGreaterThan(1000);
 result.checks.push('Stanford 原始单视角扫描 40256 点实际选取、重建、GLB 与 PLY 保存');result.checks.push('无真实颜色时禁用原色，不将占位色导出为扫描 RGB');
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(320,400);w.setContentSize(390,844);});await page.waitForTimeout(400);
 const stage=await page.locator('.object-stage').boundingBox(),header=await page.locator('.topbar').boundingBox();expect(stage.y).toBeGreaterThanOrEqual(header.y+header.height);
 await page.screenshot({path:out+'/mobile-studio-final.png',fullPage:true});result.checks.push('窄屏创作内容位于双行导航下方，标题无遮挡');expect(result.errors).toEqual([]);
}catch(error){result.failure=String(error);console.error(error);process.exitCode=1;await page.screenshot({path:out+'/real-failure.png'});}
finally{await writeFile(out+'/real-scan-result.json',JSON.stringify(result,null,2));await app.close();}
