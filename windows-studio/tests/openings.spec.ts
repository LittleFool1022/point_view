import {openStudioView} from "./studioPage";
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';
import {openingRoomPcd} from './fixtures/openings';
test('完整源点立面识别关闭门/分格窗，确认建模、来源保存和过期立面失效',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const btn=(name:string)=>page.getByRole('button',{name,exact:true});await page.goto('/');
 const choose=page.waitForEvent('filechooser');await btn('导入测量成果').click();await(await choose).setFiles({name:'合成门窗验证.pcd',mimeType:'application/octet-stream',buffer:Buffer.from(openingRoomPcd())});await expect(page.locator('.status-bar')).toContainText('已导入');
 await openStudioView(page,"建筑模型");await btn('新建空建筑模型').click();await btn('新增墙体').click();await page.getByLabel('终点 X m',{exact:true}).fill('8');await btn('应用构件修改').click();await btn('墙面门窗识别').click();await btn('生成墙面正立面').click();await expect(page.locator('.status-bar')).toContainText('2 个待确认候选');
 const choices=page.getByLabel('自动门窗候选',{exact:true});await choices.selectOption({index:1});await expect(page.getByLabel('候选类别',{exact:true})).toHaveValue('door');await expect(btn('加入 BIM 待复核')).toBeDisabled();await page.getByLabel('已检查候选类别与边界',{exact:true}).check();await btn('加入 BIM 待复核').click();await expect(page.locator('.work-toolbar')).toContainText('1 门窗');
 await choices.selectOption({index:2});await expect(page.getByLabel('候选类别',{exact:true})).toHaveValue('window');await page.getByLabel('候选模板',{exact:true}).selectOption('double-window');await page.getByLabel('已检查候选类别与边界',{exact:true}).check();await btn('加入 BIM 待复核').click();await expect(page.locator('.work-toolbar')).toContainText('2 门窗');await expect(btn('导出交付 IFC')).toBeDisabled();
 await btn('深度证据').click();await page.screenshot({path:'artifacts/openings-20261023/ui-elevation.png'});
 const saving=page.waitForEvent('download');await btn('保存工程').click();const file=await saving,archive=unzipSync(await readFile((await file.path())!)),state=JSON.parse(strFromU8(archive['project.json']!));expect(state.building.openings).toHaveLength(2);expect(state.building.openings.every((o:any)=>o.detection.method==='wall-elevation/1'&&o.evidence.confirmed===false)).toBe(true);expect(state.building.openings[0].detection.sourcePoints).toBeGreaterThan(120000);
 await page.getByLabel('立面下界 m',{exact:true}).fill('-1.5');await expect(page.locator('.elevation-stage image')).toHaveCount(0);await expect(choices).toBeDisabled();expect(errors).toEqual([]);
});
