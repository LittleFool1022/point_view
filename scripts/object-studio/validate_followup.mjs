import {_electron as electron,expect} from '@playwright/test';
import {writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'artifacts/object-studio-validation');
const app=await electron.launch({executablePath:path.join(root,'.tools/electron-43.2.0/electron'),args:[path.join(root,'scripts/object-studio/electron-validation.cjs'),'--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader'],env:{...process.env,POINT_VIEW_OBJECT_PYTHON:path.join(root,'.tools/object-runtime/bin/python'),POINT_VIEW_VALIDATION_PROFILE:process.env.POINT_VIEW_VALIDATION_PROFILE},timeout:30000});
const page=await app.firstWindow(),result={checks:[],errors:[]};
page.on('pageerror',e=>result.errors.push(e.message));
const pass=name=>{result.checks.push(name);console.log('PASS',name);};
try{
 await app.evaluate(({dialog},out)=>{dialog.showSaveDialog=async({defaultPath})=>({canceled:false,filePath:out+'/'+defaultPath});},out);
 await page.getByRole('button',{name:'创作',exact:true}).click();
 await page.getByRole('button',{name:'我的作品',exact:true}).click();
 await page.getByRole('button',{name:/studio-ceramic/}).click();
 await expect(page.locator('.object-library')).toHaveCount(0);await expect(page.getByLabel('作品名称')).toHaveValue('studio-ceramic');pass('重启应用后恢复持久化作品');
 await page.getByLabel('原始坐标单位').selectOption('0.001');await page.getByLabel('作品名称').fill('studio-mm');await page.getByLabel('显示尺寸与实际物体相符').check();
 await page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true}).click();
 await expect.poll(async()=>{try{return(await stat(out+'/studio-mm.glb')).size;}catch{return 0;}}).toBeGreaterThan(1000);pass('毫米单位 GLB 实际文件落盘');
 await page.locator('.object-details summary').click();await page.getByRole('button',{name:'重新生成表面',exact:true}).click();
 await expect(page.locator('.object-progress')).toBeVisible();await page.locator('.object-progress').getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.object-progress')).toHaveCount(0,{timeout:15000});
 await expect(page.locator('.object-preview')).toHaveAttribute('data-preview-mode','surface');pass('取消真实重建任务，保留已有表面与原貌');
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(320,400);w.setContentSize(390,844);});
 await page.waitForTimeout(500);await page.screenshot({path:out+'/mobile-studio.png',fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);expect(overflow).toBe(false);
 await page.getByRole('button',{name:'收藏作品',exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole('button',{name:'收藏作品',exact:true})).toBeInViewport();pass('390像素窄屏可滚动操作，无横向溢出');
 await page.getByRole('button',{name:'关闭物体创作台',exact:true}).scrollIntoViewIfNeeded();await page.getByRole('button',{name:'关闭物体创作台',exact:true}).click();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
 // 超过普通 GPU 预算的合成点云，确认抽样显示不会漏选数据。
 const n=600001,header=Buffer.from(`VERSION .7\nFIELDS x y z r g b\nSIZE 4 4 4 1 1 1\nTYPE F F F U U U\nCOUNT 1 1 1 1 1 1\nWIDTH ${n}\nHEIGHT 1\nPOINTS ${n}\nDATA binary\n`),body=Buffer.alloc(n*15);
 for(let i=0;i<n;i++){const j=i%6000,z=1-2*(j+.5)/6000,t=j*Math.PI*(3-Math.sqrt(5)),r=Math.sqrt(1-z*z);body.writeFloatLE(.6*r*Math.cos(t),i*15);body.writeFloatLE(.4*r*Math.sin(t),i*15+4);body.writeFloatLE(.8*z,i*15+8);body[i*15+12]=176;body[i*15+13]=106;body[i*15+14]=68;}
 await writeFile(out+'/selection-budget.pcd',Buffer.concat([header,body]));
 await app.evaluate(({dialog},out)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[out+'/selection-budget.pcd']});},out);
 await page.getByRole('button',{name:'导入',exact:true}).first().click();await expect(page.locator('.cloud-hud')).toContainText('600,001',{timeout:15000});
 await page.getByRole('button',{name:'创作',exact:true}).click();await page.waitForTimeout(500);await page.getByRole('button',{name:'框选添加',exact:true}).click();
 const box=await page.locator('.object-stage .point-cloud-canvas canvas').boundingBox();await page.mouse.move(box.x+box.width*.025,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.975,box.y+box.height*.83,{steps:10});await page.mouse.up();
 await expect(page.locator('.object-selection-count strong')).toHaveText('600,001',{timeout:15000});pass('GPU 抽样显示下完整框选 600001 点');
 await page.getByRole('button',{name:'框选减去',exact:true}).click();await page.mouse.move(box.x+box.width*.025,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.975,box.y+box.height*.5,{steps:5});await page.mouse.up();
 await expect.poll(async()=>Number((await page.locator('.object-selection-count strong').textContent()).replaceAll(',',''))).toBeLessThan(600001);pass('减选背景生效');
 await page.locator('.object-details summary').click();await page.getByLabel('物体范围起点').fill('30');
 await expect(page.getByRole('button',{name:'确认物体',exact:true})).toBeEnabled();pass('轴向范围过滤保留可确认选区');
 expect(result.errors).toEqual([]);
}catch(error){result.failure=String(error);console.error(error);await page.screenshot({path:out+'/followup-failure.png'});process.exitCode=1;}
finally{await writeFile(out+'/followup-result.json',JSON.stringify(result,null,2));await app.close();}
