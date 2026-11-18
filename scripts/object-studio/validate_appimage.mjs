import { _electron as electron, expect } from '@playwright/test';
import { readFile, writeFile, stat, readdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url),asar=require('@electron/asar');
const root=process.cwd(),out=path.join(root,'artifacts/appimage-object-studio-20260907');
const environment={...process.env,APPIMAGE_EXTRACT_AND_RUN:'1'};
delete environment.POINT_VIEW_OBJECT_PYTHON;
delete environment.PYTHONHOME;
delete environment.PYTHONPATH;
const result={checks:[],errors:[],consoleErrors:[]};
const app=await electron.launch({executablePath:path.join(root,'release/Point View-0.1.6.AppImage'),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader',`--user-data-dir=${out}/profile`],env:environment,timeout:60000});
const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.on('console',e=>{if(e.type()==='error')result.consoleErrors.push(e.text());});
const pass=name=>{result.checks.push(name);console.log('PASS',name);};
try{
 result.runtime=await app.evaluate(({app})=>({isPackaged:app.isPackaged,appPath:app.getAppPath(),resourcesPath:process.resourcesPath,override:process.env.POINT_VIEW_OBJECT_PYTHON??null}));
 expect(result.runtime.isPackaged).toBe(true);expect(result.runtime.override).toBeNull();
 const bundled=path.join(result.runtime.resourcesPath,'app.asar');
 let count=0;
 async function verifyDist(folder='dist'){
  for(const entry of await readdir(path.join(root,folder),{withFileTypes:true})){
   const file=folder+'/'+entry.name;
   if(entry.isDirectory())await verifyDist(file);
   else {expect(Buffer.compare(await readFile(path.join(root,file)),asar.extractFile(bundled,file))).toBe(0);count++;}
  }
 }
 await verifyDist();result.frontendFiles=count;
 expect(Buffer.compare(asar.extractFile(bundled,'electron/object-studio/runtime.cjs'),await readFile(root+'/electron/object-studio/runtime.cjs'))).toBe(0);
 expect(Buffer.compare(await readFile(path.join(result.runtime.resourcesPath,'app.asar.unpacked/electron/object-studio/reconstruct.py')),await readFile(root+'/electron/object-studio/reconstruct.py'))).toBe(0);
 result.runtimeManifest=JSON.parse(await readFile(path.join(result.runtime.resourcesPath,'.tools/object-runtime/runtime-manifest.json'),'utf8'));
 pass('实际 AppImage 启动；包内前端与重建脚本匹配当前源码');
 const capability=await page.evaluate(()=>window.pointViewDesktop.objectCapability());expect(capability.available).toBe(true);pass('包内独立运行时可用，无本机解释器覆盖');
 await app.evaluate(({dialog},{fixture,out})=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[fixture]});dialog.showSaveDialog=async({defaultPath})=>({canceled:false,filePath:out+'/'+defaultPath});},{fixture:root+'/artifacts/object-studio-validation/ellipsoid.pcd',out});
 await page.getByRole('button',{name:'工作台',exact:true}).click();await page.getByRole('button',{name:'导入',exact:true}).first().click();await expect(page.locator('.cloud-hud')).toContainText('6,000');
 await page.getByRole('button',{name:'创作',exact:true}).click();await page.waitForTimeout(650);await page.getByRole('button',{name:'框选添加',exact:true}).click();
 const box=await page.locator('.object-stage .point-cloud-canvas canvas').boundingBox();await page.mouse.move(box.x+box.width*.025,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.975,box.y+box.height*.83,{steps:10});await page.mouse.up();await expect(page.locator('.object-selection-count strong')).toHaveText('6,000');
 await page.getByRole('button',{name:'确认物体',exact:true}).click();await page.getByRole('button',{name:'生成物体表面',exact:true}).click();await expect(page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true})).toBeVisible({timeout:60000});
 await expect(page.locator('.object-stage-foot')).toContainText('11,996');pass('包内 Python 与 Open3D BPA 实际生成 11996 个面');
 await page.getByRole('button',{name:'银色金属',exact:true}).click();await page.getByLabel('作品名称').fill('AppImage-object');await page.getByLabel('显示尺寸与实际物体相符').check();await page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true}).click();
 await expect.poll(async()=>{try{return(await stat(out+'/AppImage-object.glb')).size;}catch{return 0;}}).toBeGreaterThan(1000);
 const glb=await readFile(out+'/AppImage-object.glb');expect(glb.readUInt32LE(0)).toBe(0x46546c67);result.glbSha256=createHash('sha256').update(glb).digest('hex');pass('包内界面实际切换材质并保存有效 GLB');
 await page.locator('.object-details summary').click();await page.getByLabel('表面生成方式').selectOption('poisson');await page.getByRole('button',{name:'重新生成表面',exact:true}).click();await expect(page.locator('.object-progress')).toHaveCount(0,{timeout:60000});await expect(page.locator('.object-stage-foot')).toContainText('19,044');pass('包内 Poisson 实际生成 19044 个面');
 await page.screenshot({path:out+'/appimage-running.png'});
 expect(result.errors).toEqual([]);expect(result.consoleErrors).toEqual([]);
 result.status='PASS';
}catch(error){result.failure=String(error);process.exitCode=1;console.error(error);await page.screenshot({path:out+'/failure.png'});}
finally{await writeFile(out+'/appimage-smoke.json',JSON.stringify(result,null,2));await app.close();}
