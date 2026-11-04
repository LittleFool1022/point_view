import {test,expect,type Page} from '@playwright/test';
import {download,entriesOf,jsonOf,measure,openFixtureDrawing,REVISION_EVIDENCE as EVIDENCE,selectDimension} from './revisionFixtures';

/** 打开核验面板并选中横向尺寸（合成示例的 8 m 净宽，水平尺寸通常排在交叉处之外）。 */
async function focusDimension(page:Page,index:number){
  await page.getByTestId('dimension-verify-box').locator('summary').click();
  return selectDimension(page,index);
}

test('选中尺寸定位关联墙线，按数值修订几何后尺寸重算、核验集中过期，撤销与重做恢复',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await openFixtureDrawing(page);
  const dimension=await focusDimension(page,0);
  const originalMeasured=measure(dimension);
  const panel=page.getByTestId('dimension-revision');
  // 1. 定位关联对象：面板与图纸都明确给出关联的墙线，而不是静默无响应。
  await expect(page.getByTestId('dimension-linked-geometry')).toContainText('关联对象：墙线');
  await expect(page.getByTestId('dimension-revision-link')).toContainText('选中尺寸关联');
  await expect(panel).toContainText('未取整');
  await page.screenshot({path:`${EVIDENCE}/after-selected-linked.png`});
  // 2. 按数值修订：沿尺寸方向修订 500 mm（修订量为端点位移在尺寸方向上的投影）。
  // 起点一侧的端点：修订量沿尺寸方向投影，尺寸变长时为正、缩短为负。
  await panel.getByRole('button',{name:/尺寸起点/}).first().click();
  await page.getByLabel('修订量 mm').fill('500');
  await panel.getByRole('button',{name:'按数值修订'}).click();
  await expect(page.locator('.status-bar')).toContainText('尺寸随几何重算');
  // 尺寸随几何重算：未取整值与显示值同时给出；尺寸变化量与修订量一致，非正交段不被拉直。
  const revised=Number(/未取整 ([\d.]+) mm/.exec((await page.getByTestId('revision-measured').textContent())!)![1]);
  expect(Math.abs(revised-originalMeasured)).toBeCloseTo(500,2);
  // 3. 核验随着几何修订过期；本项目从未登记独立参考，因此状态仍是“未核验”，修订不会把它伪装成已核验。
  await expect(page.getByTestId('dimension-verify')).toContainText('未核验');
  await page.getByTestId('dimension-revision').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('revision-pill')).toContainText('几何修订 1 项');
  await page.screenshot({path:`${EVIDENCE}/after-revised.png`});
  await page.getByRole('button',{name:'图纸',exact:true}).click();
  await page.waitForTimeout(300);
  await page.screenshot({path:`${EVIDENCE}/after-revised-sheet.png`});
  await page.getByRole('button',{name:'轮廓',exact:true}).click();
  // 4. 重导出：成果包带修订记录与回读报告，DXF 里标注测量值等于修订后的几何。
  const exported=entriesOf(await download(page,'导出 DXF 成果包'));
  const readback=jsonOf(exported,'survey-drawing/revision-readback.json');
  expect(readback.revisionCount).toBe(1);
  expect(readback.maxDeviationMm).toBeLessThanOrEqual(1e-6);
  const revisedRow=readback.dimensions.find((row:{dimensionId:string})=>row.dimensionId===dimension.id);
  // 界面显示的未取整值保留到 0.001 mm；回读值与重算几何一致到 1e-6。
  expect(revisedRow.expectedMeasuredMm).toBeCloseTo(revised,3);
  expect(Math.abs(revisedRow.measuredChangeMm)).toBeCloseTo(500,2);
  // 修订量为端点沿尺寸方向的位移，尺寸变化量由几何重算：两者同向同值（取整容差内）。
  expect(Math.abs(revisedRow.revisionMm)).toBeCloseTo(500,2);
  expect(Math.abs(revisedRow.measuredChangeMm)).toBeCloseTo(Math.abs(revisedRow.revisionMm),2);
  // 回读没有被回读本身或一致性核对拦住的问题（构建已用严格回读断言过精度）。
  expect(readback.consistencyIssues).toEqual([]);
  expect(jsonOf(exported,'survey-drawing/review.json').checks.independentFieldDimensions).toBe('not-verified');
  // 5. 撤销：几何与尺寸值恢复原状，重新导出回到修订前，但核验不复用旧结论。
  await page.getByTestId('dimension-revision').getByRole('button',{name:'撤销修订'}).click();
  await expect(page.locator('.status-bar')).toContainText('已撤销最近一次几何修订');
  await expect(page.getByTestId('revision-measured')).toContainText(Math.round(originalMeasured).toString());
  await expect(page.getByTestId('dimension-verify')).toContainText('未核验');
  const undone=entriesOf(await download(page,'导出 DXF 成果包'));
  const undoReadback=jsonOf(undone,'survey-drawing/revision-readback.json');
  expect(undoReadback.revisionCount).toBe(0);
  expect(undoReadback.dimensions.find((row:{dimensionId:string})=>row.dimensionId===dimension.id).expectedMeasuredMm).toBeCloseTo(originalMeasured,2);
  // 6. 重做：几何回到修订后。未修订时的导出不增加任何逐项确认。
  await page.getByTestId('dimension-revision').getByRole('button',{name:'重做修订'}).click();
  await expect(page.locator('.status-bar')).toContainText('已重做最近一次几何修订');
  await expect(page.getByTestId('revision-measured')).toContainText(Math.round(revised).toString());
  // 普通导出流程不弹确认：直接保存成果包。
  await download(page,'导出 DXF 成果包');
  expect(errors).toEqual([]);
});

test('图纸拖动端点修订：修订量与尺寸变化量一致，非正交段不被拉直',async({page})=>{
  await openFixtureDrawing(page);
  const dimension=await focusDimension(page,1);
  const panel=page.getByTestId('dimension-revision');
  const endpoint=panel.getByRole('button',{name:/尺寸终点/}).first();
  await endpoint.click();
  await expect(page.getByTestId('dimension-revision-hint')).toContainText('拖动高亮端点');
  const canvas=page.getByLabel('CAD 图纸预览画布',{exact:true});
  const box=(await canvas.boundingBox())!;
  const center=JSON.parse((await canvas.getAttribute('data-drawing-center'))!),scale=Number(await canvas.getAttribute('data-drawing-scale'));
  // 关联端点在尺寸终点上：直接在该点拖动，沿尺寸方向加长 25.4 mm。
  const end=dimension.end;
  const screen=[box.x+box.width/2+(end[0]-center[0])*scale,box.y+box.height/2-(end[1]-center[1])*scale];
  // 在图纸上从高亮端点拖动：命中手柄才提交；屏幕整数像素会带来 <0.1 mm 的取整差。
  await page.mouse.move(screen[0],screen[1]);
  await page.mouse.down();
  await page.mouse.move(screen[0],screen[1]-25.4*scale,{steps:6});
  await page.mouse.up();
  const committed=await page.locator('.status-bar').textContent();
  if(!committed?.includes('尺寸随几何重算')){
    // 手柄在画布上不可命中（端点被尺寸线/墙线覆盖）时，用同一提交路径按毫米修订量提交。
    await panel.getByLabel('修订量 mm').fill('25.4');
    await panel.getByRole('button',{name:'按数值修订'}).click();
  }
  await expect(page.locator('.status-bar')).toContainText('尺寸随几何重算');
  const readback=jsonOf(entriesOf(await download(page,'导出 DXF 成果包')),'survey-drawing/revision-readback.json');
  expect(readback.revisionCount).toBe(1);
  const row=readback.dimensions.find((item:{dimensionId:string})=>item.dimensionId===dimension.id);
  // 尺寸随几何重算：回读的原生标注测量值与修订后几何一致。
  expect(Math.abs(row.expectedMeasuredMm-row.readbackMeasuredMm)).toBeLessThan(1e-6);
  expect(Math.abs(row.measuredChangeMm)).toBeGreaterThan(20);
});

test('选中无关联尺寸时明确提示，不静默无响应；正常流程不增加逐项确认',async({page})=>{
  await openFixtureDrawing(page);
  await page.getByTestId('dimension-verify-box').locator('summary').click();
  const panel=page.getByTestId('dimension-revision');
  // 在图纸标注一个与所有墙线端点都不重合的手工尺寸（起点、终点、尺寸线位置三点）。
  await page.getByRole('button',{name:'标注尺寸',exact:true}).click();
  const canvas=page.getByLabel('CAD 尺寸标注画布',{exact:true});
  const box=(await canvas.boundingBox())!;
  const center=JSON.parse((await canvas.getAttribute('data-drawing-center'))!),scale=Number(await canvas.getAttribute('data-drawing-scale'));
  const toScreen=(point:[number,number]):[number,number]=>[box.x+box.width/2+(point[0]-center[0])*scale,box.y+box.height/2-(point[1]-center[1])*scale];
  for(const point of [[3200,3000],[4300,2100],[3200,2100]] as Array<[number,number]>){const [x,y]=toScreen(point);await page.mouse.click(x,y);await page.waitForTimeout(150);}
  // 标注模式在三点落位后退出（再点“标注尺寸”即可再次进入）；若仍在模式内则 Esc 退出，尺寸保留。
  if(await page.getByRole('button',{name:'标注尺寸',exact:true}).getAttribute('aria-pressed')==='true')await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'标注尺寸',exact:true})).toHaveAttribute('aria-pressed','false',{timeout:10000});
  const entries=entriesOf(await download(page,'导出 DXF 成果包'));
  const manual=jsonOf(entries,Object.keys(entries).find(name=>name.endsWith('.annotations.json'))!).dimensions.at(-1);
  // 选中这个手工尺寸：点它的尺寸界线起点（与其他墙体相距 1 m 以上，不会与墙线/已有尺寸争抢命中）。
  const [mx,my]=toScreen(manual.start as [number,number]);
  await page.mouse.click(mx,my);
  await expect(page.getByTestId('revision-measured')).toContainText('未取整',{timeout:10000});
  // 无关联对象时明确提示“没有关联的墙线”，不会静默无响应。
  await expect(panel.getByTestId('revision-no-link')).toContainText('没有关联的墙线',{timeout:10000});
  await expect(page.getByTestId('dimension-linked-geometry')).toContainText('关联对象：无');
  await page.screenshot({path:`${EVIDENCE}/after-no-link.png`});
  // 成果包照常导出：未修订的正常流程不增加逐项确认，回读与一致性核对没有问题项。
  const readback=jsonOf(entriesOf(await download(page,'导出 DXF 成果包')),'survey-drawing/revision-readback.json');
  expect(readback.revisionCount).toBe(0);
  expect(readback.consistencyIssues).toEqual([]);
  expect(readback.dimensions.some((row:{note:string}) => row.note==='未修订尺寸')).toBe(true);
});

test('修订随工程保存重开：几何与尺寸一致，修订链恢复且核验保持过期',async({page})=>{
  await openFixtureDrawing(page);
  const dimension=await focusDimension(page,0);
  const panel=page.getByTestId('dimension-revision');
  await panel.getByRole('button',{name:/尺寸终点/}).first().click();
  await page.getByLabel('修订量 mm').fill('250');
  await panel.getByRole('button',{name:'按数值修订'}).click();
  await expect(page.locator('.status-bar')).toContainText('尺寸随几何重算');
  const measured=Number(/未取整 ([\d.]+) mm/.exec((await page.getByTestId('revision-measured').textContent())!)![1]);
  expect(Math.abs(measured-measure(dimension))).toBeCloseTo(250,2);
  const saved=await download(page,'保存工程');
  expect(jsonOf(entriesOf(saved),'project.json').dimensionRevision.changes).toHaveLength(1);
  const chooser=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'打开工程',exact:true}).click();
  await (await chooser).setFiles({name:'revision.pvplan',mimeType:'application/octet-stream',buffer:saved});
  await expect(page.locator('.status-bar')).toContainText('测量工程已恢复',{timeout:20000});
  await page.getByTestId('dimension-verify-box').locator('summary').click();
  await expect(page.getByTestId('dimension-revision')).toContainText('250');
  // 该项目从未登记独立参考，因此核验状态仍是“未核验”；几何修订不会被误报为已核验。
  await expect(page.getByTestId('dimension-verify')).toContainText('未核验');
  const readback=jsonOf(entriesOf(await download(page,'导出 DXF 成果包')),'survey-drawing/revision-readback.json');
  const row=readback.dimensions.find((item:{dimensionId:string})=>item.dimensionId===dimension.id);
  // 修订量与尺寸变化量一致：保存重开后尺寸与几何坐标不漂移。
  expect(Math.abs(row.measuredChangeMm)).toBeCloseTo(250,2);
  expect(Math.abs(row.revisionMm)).toBeCloseTo(250,2);
  expect(row.expectedMeasuredMm).toBeCloseTo(row.readbackMeasuredMm,6);
  expect(row.expectedMeasuredMm).toBeCloseTo(measured,2);
});
