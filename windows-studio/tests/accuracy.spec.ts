import {openStudioView} from "./studioPage";
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test('精度空白模板、合成参考样本报告与模型修订失效',async({page})=>{
 const btn=(name:string)=>page.getByRole('button',{name,exact:true});await page.goto('/');await btn('打开示例').click();await expect(page.locator('.status-bar')).toContainText('合成示例');await openStudioView(page,"建筑模型");await btn('从点云生成建筑候选').click();await expect(page.locator('.status-bar')).toContainText('已生成 4 条墙候选');
 const download=page.waitForEvent('download');await btn('导出精度基准模板').click();const template=JSON.parse(await readFile((await(await download).path())!,'utf8'));expect(template.measurements.every((m:any)=>m.reference===null)).toBe(true);
 const wall=template.measurements.find((m:any)=>m.metric==='lengthM'),ref={...template,provenance:{kind:'synthetic',method:'known 8x6 fixture',operator:'test',measuredAt:'2026-10-22',documentRef:'synthetic'},measurements:[{...wall,reference:8,tolerance:10,uncertainty:.001}]};
 await page.getByLabel('精度基准文件',{exact:true}).setInputFiles({name:'reference.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(ref))});await expect(page.locator('.status-bar')).toContainText('已核验 1 项尺寸');const saving=page.waitForEvent('download');await btn('导出尺寸核验报告').click();const report=JSON.parse(await readFile((await(await saving).path())!,'utf8'));expect(report.constructionAccepted).toBe(false);expect(report.independentReference).toBe(false);expect(report.results[0].unit).toBe('m');
 await page.locator('.element-list button').first().click();await page.getByLabel('墙厚 m',{exact:true}).fill('.25');await btn('应用构件修改').click();await expect(btn('导出尺寸核验报告')).toHaveCount(0);await expect(page.locator('.bim-properties')).toContainText('原核验报告失效');
});
