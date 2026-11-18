import {openStudioView} from "./studioPage";
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';
test('本地建筑效果图、同视角约束包、场景保存恢复和来源过期拦截',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await openStudioView(page,"建筑效果图");await expect(page.getByRole('button',{name:'导出效果图 PNG',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'点云与 CAD',exact:true}).click();await page.getByRole('button',{name:'打开示例',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('合成示例');
 await openStudioView(page,"建筑模型");await page.getByRole('button',{name:'从点云生成建筑候选',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('已生成 4 条墙候选');
 await openStudioView(page,"建筑效果图");await expect(page.locator('.render-canvas canvas')).toBeVisible();
 await page.getByLabel('材质方案',{exact:true}).selectOption('concrete');await page.getByRole('button',{name:'俯视效果',exact:true}).click();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出图片与约束包',exact:true}).click();const zip=unzipSync(await readFile((await(await download).path())!));
 expect(Object.keys(zip).sort()).toEqual(['building.json','depth.png','edges.png','render.json','view.png']);
 const manifest=JSON.parse(strFromU8(zip['render.json']!));expect(manifest.aiGenerated).toBe(false);expect(manifest.settings.theme).toBe('concrete');expect(manifest.image).toEqual({width:1920,height:1080});expect(manifest.camera.position).toHaveLength(3);
 for(const key of ['view.png','depth.png','edges.png']){const bytes=zip[key]!;expect([...bytes.slice(0,8)]).toEqual([137,80,78,71,13,10,26,10]);expect(new DataView(bytes.buffer,bytes.byteOffset).getUint32(16)).toBe(1920);}
 // 重新加载 PNG 并验证约束图含有效几何，避免只导出空白图。
 const stats=await page.evaluate(async(entries)=>{const result:any={};for(const [name,data] of Object.entries(entries)){const bitmap=await createImageBitmap(new Blob([new Uint8Array(data)],{type:'image/png'}));const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d')!;ctx.drawImage(bitmap,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;let min=255,max=0;for(let i=0;i<pixels.length;i+=4){min=Math.min(min,pixels[i]!);max=Math.max(max,pixels[i]!);}result[name]={min,max};bitmap.close();}return result;},Object.fromEntries(['depth.png','edges.png'].map(k=>[k,Array.from(zip[k]!)])));
 expect(stats['edges.png'].max-stats['edges.png'].min).toBeGreaterThan(50);expect(stats['depth.png'].max-stats['depth.png'].min).toBeGreaterThan(10);
 await page.screenshot({path:'artifacts/render-workspace.png'});
 const saving=page.waitForEvent('download');await page.getByRole('button',{name:'保存工程',exact:true}).click();const saved=await saving;
 await page.getByLabel('材质方案',{exact:true}).selectOption('warm');page.once('dialog',d=>d.accept());const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'打开工程',exact:true}).click();await(await chooser).setFiles((await saved.path())!);await expect(page.locator('.status-bar')).toContainText('测量工程已恢复');await openStudioView(page,"建筑效果图");await expect(page.getByLabel('材质方案',{exact:true})).toHaveValue('concrete');
 await page.getByRole('button',{name:'点云与 CAD',exact:true}).click();await page.getByRole('button',{name:'选区',exact:true}).click();await page.getByLabel('视角',{exact:true}).selectOption('top');const b=(await page.locator('.cloud-view canvas').boundingBox())!;await page.mouse.move(b.x+b.width*.15,b.y+b.height*.45);await page.mouse.down();await page.mouse.move(b.x+b.width*.5,b.y+b.height*.8,{steps:8});await page.mouse.up();await page.getByRole('button',{name:'删除选中',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('已应用 1 次清理');await openStudioView(page,"建筑效果图");await expect(page.getByRole('button',{name:'导出图片与约束包',exact:true})).toBeDisabled();expect(errors).toEqual([]);
});
