import { _electron as electron, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(), out=path.join(root,'artifacts/object-studio-validation');
await mkdir(out,{recursive:true});
const app=await electron.launch({executablePath:path.join(root,'.tools/electron-43.2.0/electron'),args:[path.join(root,'scripts/object-studio/electron-validation.cjs'),'--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader'], env:{...process.env, POINT_VIEW_OBJECT_PYTHON:path.join(root,'.tools/object-runtime/bin/python')}, timeout:30000});
const result={checks:[],errors:[],consoleErrors:[]};
const pass=(name)=>{result.checks.push(name); console.log('PASS',name);};
const page=await app.firstWindow();
page.on('pageerror',e=>result.errors.push(e.message));
page.on('console',e=>{if(e.type()==='error')result.consoleErrors.push(e.text());});
try {
 await app.evaluate(({dialog},out)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[out+'/ellipsoid.pcd']});dialog.showSaveDialog=async({defaultPath})=>({canceled:false,filePath:out+'/'+defaultPath});},out);
 await page.getByRole('button',{name:'工作台',exact:true}).click();
 await page.getByRole('button',{name:'导入',exact:true}).first().click();
 await expect(page.locator('.cloud-hud')).toContainText('6,000');
 await page.getByRole('button',{name:'创作',exact:true}).click();
 await expect(page.getByRole('heading',{name:'物体创作台'})).toBeVisible();
 await page.waitForTimeout(700);
 await page.screenshot({path:out+'/01-select.png'});
 await page.getByRole('button',{name:'框选添加',exact:true}).click();
 const box=await page.locator('.object-stage .point-cloud-canvas canvas').boundingBox();
 await page.mouse.move(box.x+box.width*.025,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.975,box.y+box.height*.83,{steps:10});await page.mouse.up();
 await expect(page.locator('.object-selection-count strong')).toHaveText('6,000');
 pass('完整框选 6000 点');
 await page.getByRole('button',{name:'撤销选取',exact:true}).click();await expect(page.locator('.object-selection-count strong')).toHaveText('0');
 await page.mouse.move(box.x+box.width*.025,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.975,box.y+box.height*.83,{steps:10});await page.mouse.up();
 await expect(page.locator('.object-selection-count strong')).toHaveText('6,000');pass('框选可撤销并重选');
 await page.getByRole('button',{name:'确认物体',exact:true}).click();
 await expect(page.getByRole('button',{name:'生成物体表面',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'生成物体表面',exact:true}).click();
 await expect(page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true})).toBeVisible({timeout:60000});
 await expect(page.locator('.object-preview')).toHaveAttribute('data-preview-mode','surface');pass('真实 Electron IPC 与 Open3D 生成有效表面');
 await page.getByRole('button',{name:'对照扫描原貌',exact:true}).click();await expect(page.locator('.object-preview')).toHaveAttribute('data-preview-mode','points');
 await page.getByRole('button',{name:'查看创作表面',exact:true}).click();pass('原貌与表面可来回对照');
 await expect(page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true})).toBeDisabled();
 await page.getByLabel('显示尺寸与实际物体相符').check();pass('导出前核对单位尺寸');
 for(const [preset,label] of [['original','采集原色'],['plaster','石膏'],['metal','银色金属'],['ceramic','青釉陶瓷']]){
   await page.getByRole('button',{name:label,exact:true}).click();
   await page.getByLabel('作品名称').fill('studio-'+preset);
   await expect(page.locator('.object-preview')).toHaveAttribute('data-material',preset);
   await page.waitForTimeout(500);
   await page.screenshot({path:out+'/material-'+preset+'.png'});
   await page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true}).click();
   await expect(page.locator('.object-message')).toContainText('GLB 已保存');
 }
 pass('四种材质真实预览并导出 GLB');
 await page.getByRole('button',{name:'收藏作品',exact:true}).click();await expect(page.locator('.object-message')).toContainText('作品已收藏');
 await page.getByRole('button',{name:'我的作品',exact:true}).click();await expect(page.locator('.object-library img')).toHaveCount(1);
 await page.getByRole('button',{name:/studio-ceramic/}).click();await expect(page.locator('.object-library')).toHaveCount(0);await expect(page.getByLabel('作品名称')).toHaveValue('studio-ceramic');pass('作品持久化、真实缩略图与恢复');
 await page.getByLabel('原始坐标单位').selectOption('0.001');await expect(page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true})).toBeDisabled();
 await page.getByLabel('作品名称').fill('studio-mm');await page.getByLabel('显示尺寸与实际物体相符').check();
 await page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true}).click();await expect(page.locator('.object-message')).toContainText('GLB 已保存');pass('单位变更重新确认并导出');
 await page.getByRole('button',{name:'关闭物体创作台',exact:true}).click();await expect(page.locator('.object-studio')).toHaveCount(0);await expect(page.locator('.cloud-hud')).toContainText('6,000');
 await page.getByRole('button',{name:'图纸',exact:true}).click();await expect(page.locator('.cad-workspace')).toBeVisible();pass('退出恢复空间并保留 CAD 入口');
 expect(result.errors).toEqual([]);expect(result.consoleErrors).toEqual([]);
} catch(error){result.failure=String(error);await page.screenshot({path:out+'/desktop-failure.png'});console.error(error);process.exitCode=1;}
finally{await writeFile(out+'/desktop-result.json',JSON.stringify(result,null,2));await app.close();}
