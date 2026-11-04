import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';

/** 证据截图写到临时目录，避免普通回归运行覆盖 PR #5 的已提交证据。 */
const EVIDENCE=process.env.PR5_EVIDENCE_DIR??'/tmp/pv-pr5-evidence';

async function downloaded(page:Page,name:string){const pending=page.waitForEvent('download');await page.getByRole('button',{name,exact:true}).click();return readFile((await(await pending).path())!);}

/** 点击纵向尺寸线中点选中该尺寸，返回面板显示的文字。 */
async function selectFirstDimension(page:Page){
  const canvas=page.getByLabel('CAD 图纸预览画布',{exact:true});
  // 先切到完整图纸：图框与尺寸线同时可见，点选坐标与图纸构造一致。
  if(await canvas.getAttribute('data-layout-mode')==='model')await page.getByRole('button',{name:'图纸',exact:true}).click();
  await expect(page.getByRole('button',{name:'导出 DXF 成果包',exact:true})).toBeEnabled();
  const box=(await canvas.boundingBox())!;
  const annotations=JSON.parse(strFromU8(Object.entries(unzipSync(await downloaded(page,'导出 DXF 成果包'))).find(([n])=>n.endsWith('.annotations.json'))![1]));
  const dimension=annotations.dimensions[1];
  const center=JSON.parse((await canvas.getAttribute('data-drawing-center'))!),scale=Number(await canvas.getAttribute('data-drawing-scale'));
  const linePoint=[(dimension.start[0]+dimension.end[0])/2,dimension.linePoint[1]];
  await page.mouse.click(box.x+box.width/2+(linePoint[0]-center[0])*scale,box.y+box.height/2-(linePoint[1]-center[1])*scale);
  return annotationDimension(page);
}
async function annotationDimension(page:Page){return page.locator('[data-testid="selected-dimension"]').textContent();}

test('关键尺寸核验：缺参考仍可导出并标未核验，录入后随工程保存重开，几何失效后过期',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button',{name:'打开示例',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('合成示例');
  await page.getByRole('button',{name:'生成工程图',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('工程图已生成');
  const panel=page.getByTestId('dimension-verify');
  await page.getByTestId('dimension-verify-box').locator('summary').click();
  await expect(panel).toContainText('未核验');
  // 1. 缺少独立参考时正常导出，成果包明确未核验，且没有新增逐项确认。
  const plain=unzipSync(await downloaded(page,'导出 DXF 成果包'));
  expect(JSON.parse(strFromU8(plain['survey-drawing/review.json']!)).checks.independentFieldDimensions).toBe('not-verified');
  // 2. 选中关键尺寸（点击尺寸线）后录入独立实测值与容差。
  await page.getByRole('button',{name:'导出参考模板',exact:true}).click();
  await selectFirstDimension(page);
  const measured=Number(/图纸测量 ([\d.]+) mm/.exec((await annotationDimension(page))!)![1]);
  await panel.getByRole('button',{name:'录入选中尺寸'}).click();
  await panel.getByLabel('独立参考值 mm').fill(String(measured));
  await panel.getByLabel('容差 mm').fill('1');
  await panel.getByLabel('测量方法').fill('钢尺实测');
  await panel.getByLabel('测量人').fill('测试员');
  await panel.getByLabel('实测日期').fill('2026-11-01');
  await panel.getByLabel('依据文件').fill('现场实测记录-001');
  await panel.getByRole('button',{name:'记录该尺寸参考值'}).click();
  await expect(panel).toContainText('全部在容差内');
  await expect(page.locator('.dimension-verify-box summary')).toContainText('均在容差内');
  await page.getByTestId('dimension-verify').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${EVIDENCE}/after-verified.png`});
  const verified=unzipSync(await downloaded(page,'导出 DXF 成果包'));
  const verification=JSON.parse(strFromU8(verified['survey-drawing/dimension-verification.json']!));
  expect(verification.status).toBe('sample-within-tolerance');
  expect(verification.independentReference).toBe(true);
  expect(JSON.parse(strFromU8(verified['survey-drawing/review.json']!)).checks.independentFieldDimensions).toBe('sample-within-tolerance');
  // 3. 保存工程并重开后核验仍在；改视图使核验过期，成果包退回未核验。
  const saved=await downloaded(page,'保存工程');
  expect(JSON.parse(strFromU8(unzipSync(saved)['project.json'])).dimensionVerification.reference.entries.length).toBe(1);
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'打开工程',exact:true}).click();await(await chooser).setFiles({name:'verified.pvplan',mimeType:'application/octet-stream',buffer:saved});
  await expect(page.locator('.status-bar')).toContainText('测量工程已恢复');
  await expect(page.getByTestId('dimension-verify')).toContainText('全部在容差内');
  // 改视图即让图纸与核验失配；重新生成平面图后尺寸定义点变化，旧结论仍不可沿用。
  await page.getByLabel('图纸视图',{exact:true}).selectOption('xz');
  await expect(page.locator('.pane-header-meta .is-stale')).toContainText('待更新');
  await page.getByLabel('图纸视图',{exact:true}).selectOption('xy');
  await page.getByRole('button',{name:'更新工程图',exact:true}).click();
  await expect(page.locator('.status-bar')).toContainText('工程图已生成');
  await expect(page.getByTestId('dimension-verify')).toContainText('核验已过期');
  await expect(page.getByTestId('dimension-verify').getByRole('button',{name:'导出核验报告'})).toHaveCount(0);
  await page.getByTestId('dimension-verify').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${EVIDENCE}/after-expired.png`});
  expect(errors).toEqual([]);
});

test('重导出保持同一图纸修订：图幅比例变化时尺寸定义点不变，回读单位毫米',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'打开示例',exact:true}).click();
  await page.getByRole('button',{name:'生成工程图',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('工程图已生成');
  const first=unzipSync(await downloaded(page,'导出 DXF 成果包'));
  const before=JSON.parse(strFromU8(Object.entries(first).find(([n])=>n.endsWith('.annotations.json'))![1])).dimensions;
  await page.getByLabel('图幅',{exact:true}).selectOption('A2');await page.getByLabel('出图比例',{exact:true}).selectOption('1:50');
  await expect(page.getByRole('button',{name:'导出 DXF 成果包',exact:true})).toBeEnabled();
  const second=unzipSync(await downloaded(page,'导出 DXF 成果包'));
  const after=JSON.parse(strFromU8(Object.entries(second).find(([n])=>n.endsWith('.annotations.json'))![1])).dimensions;
  expect(after.map((d:any)=>[d.id,d.start,d.end])).toEqual(before.map((d:any)=>[d.id,d.start,d.end]));
  expect(strFromU8(second[Object.keys(second).find(n=>n.endsWith('.dxf'))!]!)).toContain('$INSUNITS');
  expect(JSON.parse(strFromU8(second['survey-drawing/review.json']!)).plot.modelUnits).toBe('mm');
});
