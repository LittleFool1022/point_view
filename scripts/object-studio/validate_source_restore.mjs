import {_electron as electron,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';import path from 'node:path';
const root=process.cwd(),out=path.join(root,'artifacts/object-studio-validation'),n=4000001;
const header=Buffer.from(`VERSION .7\nFIELDS x y z r g b\nSIZE 4 4 4 1 1 1\nTYPE F F F U U U\nCOUNT 1 1 1 1 1 1\nWIDTH ${n}\nHEIGHT 1\nPOINTS ${n}\nDATA binary\n`),body=Buffer.alloc(n*15);
for(let i=0;i<n;i++){const j=i%6000,z=1-2*(j+.5)/6000,t=j*Math.PI*(3-Math.sqrt(5)),r=Math.sqrt(1-z*z);body.writeFloatLE(.6*r*Math.cos(t),i*15);body.writeFloatLE(.4*r*Math.sin(t),i*15+4);body.writeFloatLE(.8*z,i*15+8);body[i*15+12]=176;body[i*15+13]=106;body[i*15+14]=68;}
await writeFile(out+'/full-source.pcd',Buffer.concat([header,body]));
const app=await electron.launch({executablePath:path.join(root,'.tools/electron-43.2.0/electron'),args:[path.join(root,'scripts/object-studio/electron-validation.cjs'),'--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader'],env:{...process.env,POINT_VIEW_OBJECT_PYTHON:path.join(root,'.tools/object-runtime/bin/python')},timeout:30000});
const page=await app.firstWindow(),result={checks:[],errors:[]};page.on('pageerror',e=>result.errors.push(e.message));
try{
 await app.evaluate(({dialog},out)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[out+'/full-source.pcd']});},out);
 await page.getByRole('button',{name:'工作台',exact:true}).click();await page.getByRole('button',{name:'导入',exact:true}).first().click();await expect(page.locator('.cloud-hud')).toContainText('4,000,000',{timeout:30000});
 await page.getByRole('button',{name:'创作',exact:true}).click();await expect(page.locator('.object-stage-foot')).toContainText('4,000,001',{timeout:30000});await expect(page.locator('.object-loading')).toHaveCount(0);
 result.checks.push('PCD 导入上限 4000000，创作 Worker 从原始快照恢复 4000001 点');
 await page.waitForTimeout(600);await page.getByRole('button',{name:'框选添加',exact:true}).click();const box=await page.locator('.object-stage .point-cloud-canvas canvas').boundingBox();
 await page.mouse.move(box.x+box.width*.025,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.975,box.y+box.height*.83,{steps:10});await page.mouse.up();
 await expect(page.locator('.object-selection-count strong')).toHaveText('4,000,001',{timeout:30000});result.checks.push('完整源恢复后全点框选，不随 GPU 预算降精度');
 await page.getByRole('button',{name:'关闭物体创作台',exact:true}).click();await expect(page.locator('.cloud-hud')).toContainText('4,000,000');result.checks.push('退出恢复主工程的原显示预算');expect(result.errors).toEqual([]);
}catch(error){result.failure=String(error);process.exitCode=1;console.error(error);await page.screenshot({path:out+'/source-failure.png'});}
finally{await writeFile(out+'/source-result.json',JSON.stringify(result,null,2));await app.close();}
