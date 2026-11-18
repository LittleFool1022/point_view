import {_electron as electron,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const root=process.cwd(),out=root+'/artifacts/object-studio-validation';
const app=await electron.launch({executablePath:root+'/.tools/electron-43.2.0/electron',args:[root+'/scripts/object-studio/electron-validation.cjs','--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader'],env:{...process.env,POINT_VIEW_OBJECT_PYTHON:root+'/.tools/object-runtime/bin/python',POINT_VIEW_VALIDATION_PROFILE:process.env.POINT_VIEW_VALIDATION_PROFILE}});
const result={checks:[],errors:[]};
try{
 const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));
 await page.getByRole('button',{name:'创作',exact:true}).click();await page.getByRole('button',{name:'我的作品',exact:true}).click();await page.getByRole('button',{name:/studio-ceramic/}).click();await expect(page.locator('.object-library')).toHaveCount(0);
 await expect(page.getByLabel('显示尺寸与实际物体相符')).toBeInViewport();await page.getByLabel('显示尺寸与实际物体相符').check();await expect(page.getByRole('button',{name:'导出 Blender 模型 · GLB',exact:true})).toBeEnabled();result.checks.push('桌面固定底部尺寸确认可见，勾选后导出可用');
 await page.screenshot({path:out+'/studio-final-desktop.png'});
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(320,400);w.setContentSize(390,844);});await page.waitForTimeout(500);
 const header=await page.locator('.topbar').boundingBox(),stage=await page.locator('.object-stage').boundingBox(),title=await page.locator('.object-stage-heading').boundingBox(),preview=await page.locator('.object-preview').boundingBox();expect(stage.y).toBeGreaterThanOrEqual(header.y+header.height);expect(preview.y).toBeGreaterThan(title.y+title.height);
 await page.screenshot({path:out+'/mobile-studio-final.png',fullPage:true});result.checks.push('390像素双行导航、标题与模型画布均不重叠');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);await page.getByLabel('显示尺寸与实际物体相符').scrollIntoViewIfNeeded();await expect(page.getByLabel('显示尺寸与实际物体相符')).toBeInViewport();result.checks.push('窄屏无横向溢出，可滚动到确认与导出操作');expect(result.errors).toEqual([]);result.status='PASS';
}catch(error){result.failure=String(error);process.exitCode=1;console.error(error);}
finally{await writeFile(out+'/layout-final.json',JSON.stringify(result,null,2));await app.close();}
