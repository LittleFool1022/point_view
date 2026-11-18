import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {decodeProject,encodeProject,type SurveyProject} from '../src/domain/project';
import {isMaskRule} from '../src/domain/cleaning';

function fixture():ArrayBuffer{
  const rows:string[]=[];
  for(let z=.2;z<=2.8;z+=.2){for(let x=0;x<=8;x+=.05)rows.push(`${x} 0 ${z}`,`${x} 6 ${z}`);for(let y=0;y<=6;y+=.05)rows.push(`0 ${y} ${z}`,`8 ${y} ${z}`);}
  for(let x=2;x<=2.6;x+=.1)for(let y=2;y<=2.6;y+=.1)for(let z=.3;z<=1.1;z+=.1)rows.push(`${x} ${y} ${z}`);
  for(let i=0;i<160;i++)rows.push(`${12+(i%13)*.17} ${12+(i%7)*.19} ${.2+(i%23)*.31}`);
  return new TextEncoder().encode(`VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\nPOINTS ${rows.length}\nDATA ascii\n${rows.join('\n')}\n`).buffer as ArrayBuffer;
}
async function saved(page:Page){
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'保存工程',exact:true}).click();const bytes=await readFile((await(await pending).path())!);return decodeProject(bytes.slice().buffer as ArrayBuffer);
}
const operations=(project:SurveyProject)=>project.source.clips?.map(rule=>isMaskRule(rule)?rule.operation:undefined).filter(Boolean)??[];

test('自动清理默认勾选，可撤销、独立反选并随工程恢复',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'导入测量成果',exact:true}).click();await(await chooser).setFiles({name:'auto-clean.pcd',mimeType:'application/octet-stream',buffer:Buffer.from(fixture())});
  await expect(page.getByLabel('去除室外噪点')).toBeChecked();await expect(page.getByLabel('去除室内噪点')).toBeChecked();
  await page.getByRole('button',{name:'预览候选点',exact:true}).click();
  await expect(page.getByLabel('自动清理结果')).toContainText('待清理候选');
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-autoclean-view','candidates');
  expect(operations(await saved(page))).toEqual([]);
  await page.getByRole('button',{name:'应用自动清理',exact:true}).click();
  await expect(page.locator('.status-bar')).toContainText('自动清理完成');
  await expect(page.getByLabel('自动清理结果')).toContainText('本次墙线保持不变');
  await page.getByRole('button',{name:'清理前对照',exact:true}).click();
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-autoclean-view','before');
  await page.getByRole('button',{name:'回到清理后',exact:true}).click();
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-autoclean-view','after');
  await page.screenshot({path:'artifacts/auto-clean.png'});
  expect(operations(await saved(page))).toEqual(['auto-outdoor-v1','auto-indoor-v1']);
  await page.locator('.cloud-tools').getByRole('button',{name:'撤销',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('已应用 0 次清理');expect(operations(await saved(page))).toEqual([]);
  await page.getByRole('button',{name:'应用自动清理',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('自动清理完成');
  await page.getByLabel('去除室外噪点').uncheck();await expect(page.locator('.status-bar')).toContainText('已应用 1 次清理');
  const partial=await saved(page);expect(operations(partial)).toEqual(['auto-indoor-v1']);expect(partial.settings.autoCleanOutdoor).toBe(false);
  const archive=await encodeProject(partial);
  page.once('dialog',dialog=>dialog.accept());const reopen=page.waitForEvent('filechooser');await page.getByRole('button',{name:'打开工程',exact:true}).click();await(await reopen).setFiles({name:'partial.pvplan',mimeType:'application/octet-stream',buffer:Buffer.from(archive)});
  await expect(page.locator('.status-bar')).toContainText('测量工程已恢复');await expect(page.getByLabel('去除室外噪点')).not.toBeChecked();await expect(page.getByLabel('去除室内噪点')).toBeChecked();expect(operations(await saved(page))).toEqual(['auto-indoor-v1']);
  await page.getByLabel('去除室内噪点').uncheck();await expect(page.locator('.status-bar')).toContainText('已应用 0 次清理');expect(operations(await saved(page))).toEqual([]);
  expect(errors).toEqual([]);
});

function cornerRoomWithShortIndoorPartition():ArrayBuffer{
  const rows:string[]=[];
  for(let z=.2;z<=2.8;z+=.2){
    for(let x=0;x<=8;x+=.05)rows.push(`${x} 0 ${z}`,`${x} 6 ${z}`);
    for(let y=0;y<=6;y+=.05)rows.push(`0 ${y} ${z}`,`8 ${y} ${z}`);
    for(let t=0;t<=.55;t+=.025){rows.push(`${5+t} 3 ${z}`,`5 ${3+t} ${z}`);}
  }
  return new TextEncoder().encode(`VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\nPOINTS ${rows.length}\nDATA ascii\n${rows.join('\n')}\n`).buffer as ArrayBuffer;
}

test('关闭自动去噪后切换高保真出图，在 CAD 图纸上直接呈现与规整模式的墙体对照',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  const chooser=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'导入测量成果',exact:true}).click();
  await(await chooser).setFiles({name:'interior-corners.pcd',mimeType:'application/octet-stream',buffer:Buffer.from(cornerRoomWithShortIndoorPartition())});
  await expect(page.locator('.status-bar')).toContainText('已导入 interior-corners.pcd');

  await page.getByRole('button',{name:'智能出图',exact:true}).click();
  await expect(page.locator('.status-bar')).toContainText('工程图已生成',{timeout:30000});
  const headerMeta=page.locator('.drawing-pane .pane-header-meta span');
  const standardText=await headerMeta.innerText();
  const standardWalls=Number(/(\d+) 墙体/.exec(standardText)![1]);

  await page.getByLabel('去除室外噪点').uncheck();
  await page.getByLabel('去除室内噪点').uncheck();
  await expect(page.locator('.auto-clean-mode-note')).toContainText('高保真出图');
  await expect(page.getByRole('button',{name:'预览候选点',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'应用自动清理',exact:true})).toBeDisabled();

  await page.getByRole('button',{name:'更新图纸',exact:true}).click();
  await expect(page.locator('.status-bar')).toContainText('高保真模式',{timeout:30000});
  await expect(headerMeta).toContainText('高保真');
  const fidelityWalls=Number(/(\d+) 墙体/.exec(await headerMeta.innerText())![1]);
  expect(fidelityWalls).toBeGreaterThan(standardWalls);
  await page.screenshot({path:'artifacts/high-fidelity-multiview.png'});
  expect(errors).toEqual([]);
});
