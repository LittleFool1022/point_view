import {test, expect, type Page} from '@playwright/test';
import {openStudioView} from './studioPage';

async function drag(page:Page,button:'left'|'right'|'middle',a:[number,number],b:[number,number]){
  await page.mouse.move(...a);await page.mouse.down({button});await page.mouse.move(...b,{steps:10});await page.mouse.up({button});
}

test('连续画笔、取消、同步期间导航排队、逐笔撤销与工程恢复',async({page})=>{
  // 模拟较慢的完整点云工作进程，验证排队期间仍可操作相机。
  await page.addInitScript(()=>{
    const original=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(message:any,...args:any[]){
      if(message?.action==='brush')setTimeout(()=>original.call(this,message,...args as [any]),800);
      else original.call(this,message,...args as [any]);
    };
  });
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('button',{name:'打开示例',exact:true}).click();
  await expect(page.locator('.status-bar')).toContainText('合成示例');
  await page.getByRole('button',{name:'橡皮擦',exact:true}).click();
  await expect(page.locator('.work-body')).toHaveClass(/focus-cloud/);
  await page.getByLabel('视角',{exact:true}).selectOption('front');
  const canvas=page.locator('.cloud-view canvas');const original=await canvas.elementHandle();
  const box=(await canvas.boundingBox())!;
  const a:[number,number]=[box.x+box.width*.40,box.y+box.height*.50],b:[number,number]=[box.x+box.width*.60,box.y+box.height*.50];
  await page.mouse.move(...a);await page.mouse.down();await page.mouse.move(...b,{steps:12});
  await page.keyboard.press('Escape');await page.mouse.up();
  await expect(page.locator('.clean-history')).toContainText('0 次清理');
  await expect(page.getByRole('button',{name:'撤销',exact:true})).toBeDisabled();
  await drag(page,'left',a,b);
  await expect(page.getByRole('button',{name:'保存工程',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'橡皮擦',exact:true})).toBeEnabled();
  await drag(page,'right',[box.x+box.width*.7,box.y+box.height*.6],[box.x+box.width*.75,box.y+box.height*.65]);
  await drag(page,'middle',[box.x+box.width*.7,box.y+box.height*.6],[box.x+box.width*.72,box.y+box.height*.61]);
  await page.mouse.wheel(0,-80);
  await page.getByLabel('视角',{exact:true}).selectOption('front');
  // 第二笔换一条带，保证不是重复擦同一批点。
  await drag(page,'left',[a[0],a[1]-55],[b[0],b[1]-55]);
  await expect(page.locator('.clean-history')).toContainText('2 次清理',{timeout:15000});
  await expect(page.getByRole('button',{name:'保存工程',exact:true})).toBeEnabled();
  expect(await original!.evaluate(el=>el===document.querySelector('.cloud-view canvas'))).toBe(true);
  await page.locator('.cloud-view').focus();await page.keyboard.press('Control+z');
  await expect(page.locator('.clean-history')).toContainText('1 次清理');
  await page.keyboard.press('Control+y');await expect(page.locator('.clean-history')).toContainText('2 次清理');
  await page.mouse.move(10,10);await page.screenshot({path:'artifacts/brush-editor.png'});
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'保存工程',exact:true}).click();const saved=await download;
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'打开工程',exact:true}).click();await(await chooser).setFiles((await saved.path())!);
  await expect(page.locator('.status-bar')).toContainText('测量工程已恢复');await expect(page.locator('.clean-history')).toContainText('2 次清理');
  expect(errors).toEqual([]);
});

test('双栏与414px点云栏布局、CAD可用、只读关键帧无擦除入口',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('button',{name:'打开示例',exact:true}).click();
  await expect(page.locator('.status-bar')).toContainText('合成示例');
  await page.getByRole('button',{name:'生成工程图',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('工程图已生成');
  for(const [width,height] of [[1366,900],[1600,1000]]){
    await page.setViewportSize({width:width!,height:height!});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.getByRole('button',{name:'导出 DXF 成果包',exact:true})).toBeEnabled();
    await page.screenshot({path:`artifacts/brush-layout-${width}.png`});
  }
  await page.addStyleTag({content:'.work-body:not(.focus-cloud):not(.focus-drawing){grid-template-columns:414px 8px minmax(300px,1fr) 260px!important}'});
  await page.getByRole('button',{name:'橡皮擦',exact:true}).click();
  await page.getByRole('button',{name:'恢复双栏对照',exact:true}).click();
  const bounds=await page.locator('.cloud-view').boundingBox();expect(bounds!.width).toBeLessThanOrEqual(414);
  expect(await page.locator('.cloud-options').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.screenshot({path:'artifacts/brush-layout-414.png'});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  page.once('dialog',d=>d.accept());const chooser=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'打开工程',exact:true}).click();
  await(await chooser).setFiles('/mnt/zk/3DGS/artifacts/keyframe_tabletop_20261027/workspace/桌上采集-联合复核.pvplan');
  await expect(page.locator('.status-bar')).toContainText('测量工程已恢复');await openStudioView(page,'关键帧复核');
  await expect(page.locator('.cloud-view canvas')).toBeVisible();await expect(page.getByRole('button',{name:'橡皮擦',exact:true})).toHaveCount(0);
  await page.locator('.cloud-view').evaluate(el=>(el as HTMLElement).style.width='414px');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const toolbar=(await page.locator('.cloud-tools').boundingBox())!,settings=(await page.locator('.point-cloud-settings').boundingBox())!;
  expect(settings.y).toBeGreaterThanOrEqual(toolbar.y+toolbar.height);
  await page.screenshot({path:'artifacts/brush-keyframe-414.png'});expect(errors).toEqual([]);
});
