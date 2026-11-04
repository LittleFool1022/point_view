import {expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';

/** 修订证据截图目录；CI 等不保存仓库文件的场景可用 REVISION_EVIDENCE_DIR 改到临时目录。 */
export const REVISION_EVIDENCE=process.env.REVISION_EVIDENCE_DIR??'docs/pr-evidence/cad-minimal-revision';

/** 打开合成示例并生成工程图；无独立实测时用 1 mm 取整，便于核对修订后的显示值。 */
export async function openFixtureDrawing(page:Page){
  await page.goto('/');
  await page.getByRole('button',{name:'打开示例',exact:true}).click();
  await expect(page.locator('.status-bar')).toContainText('合成示例',{timeout:15000});
  await page.getByRole('button',{name:'生成工程图',exact:true}).click();
  await expect(page.locator('.status-bar')).toContainText('工程图已生成',{timeout:20000});
}

export async function download(page:Page,name:string){
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name,exact:true}).click();
  return readFile((await(await pending).path())!);
}

export function entriesOf(bytes:Uint8Array){return unzipSync(bytes);}
export function jsonOf(entries:Record<string,Uint8Array>,name:string){return JSON.parse(strFromU8(entries[name]!));}

/**
 * 在图纸上点选一个尺寸：用导出包里的尺寸定义定位尺寸线中点，
 * 与 PR #5 的选尺寸方式一致（不依赖画布内部实现）。
 */
export async function selectDimension(page:Page,index:number){
  const canvas=page.getByLabel('CAD 图纸预览画布',{exact:true});
  if(await canvas.getAttribute('data-layout-mode')==='model')await page.getByRole('button',{name:'图纸',exact:true}).click();
  const entries=entriesOf(await download(page,'导出 DXF 成果包'));
  const annotations=jsonOf(entries,Object.keys(entries).find(name=>name.endsWith('.annotations.json'))!);
  const dimension=annotations.dimensions[index];
  const box=(await canvas.boundingBox())!;
  const center=JSON.parse((await canvas.getAttribute('data-drawing-center'))!),scale=Number(await canvas.getAttribute('data-drawing-scale'));
  const toScreen=(point:[number,number]):[number,number]=>[box.x+box.width/2+(point[0]-center[0])*scale,box.y+box.height/2-(point[1]-center[1])*scale];
  const vertical=Math.abs(dimension.end[0]-dimension.start[0])<1e-6;
  const mid=[(dimension.start[0]+dimension.end[0])/2,(dimension.start[1]+dimension.end[1])/2];
  // 横向尺寸的尺寸线在起点下方、纵向尺寸在起点左侧；从 15% 到 70% 依次试探，
  // 命中尺寸线即选中该尺寸（命中墙线会显示“已选图元”，不满足条件继续试探）。
  const fractions=[0.15,0.3,0.5,0.7];
  const candidates:[number,number][]=fractions.map(fraction=>vertical
    ?[dimension.start[0]+(dimension.linePoint[0]-dimension.start[0])*fraction,mid[1]]
    :[mid[0],dimension.start[1]+(dimension.linePoint[1]-dimension.start[1])*fraction]);
  let matched=false;
  for(const target of candidates){
    const [x,y]=toScreen(target);
    await page.mouse.click(x,y);
    const measured=Number(/图纸几何尺寸 ([\d.]+) mm/.exec((await page.getByTestId('cartesian-dimension-properties').textContent({timeout:1000}).catch(()=>''))??'')?.[1]??NaN);
    if(Math.abs(measured-measure(dimension))<0.01){matched=true;break;}
  }
  if(!matched){
    // 画布点选不可用时退回核验表：先录入一条合成参考，用表格行选中夹具尺寸（表单不提交）。
    const panel=page.getByTestId('dimension-verify');
    await panel.getByRole('button',{name:/录入选中尺寸|收起录入/}).first().click();
    await panel.getByLabel('独立参考值 mm').fill('1');
    await panel.getByLabel('容差 mm').fill('1');
    await panel.getByLabel('测量方法').fill('夹具');
    await panel.getByLabel('测量人').fill('夹具');
    await panel.getByLabel('实测日期').fill('2026-11-01');
    await panel.getByLabel('依据文件').fill('fixture');
    await panel.getByLabel('参考来源').selectOption('synthetic');
    await panel.getByRole('button',{name:'记录该尺寸参考值'}).click();
    await page.getByTestId('dimension-verify').getByRole('button',{name:new RegExp(`^尺寸 ${index+1}$`)}).first().click();
  }
  await expect(page.getByTestId('revision-measured')).toContainText(dimension.id);
  return dimension as {id:string;kind:string;start:[number,number];end:[number,number]};
}

/** 长度：对齐尺寸取两点距离，水平/垂直按轴向。 */
export function measure(d:{kind:string;start:[number,number];end:[number,number]}){
  if(d.kind==='horizontal')return Math.abs(d.end[0]-d.start[0]);
  if(d.kind==='vertical')return Math.abs(d.end[1]-d.start[1]);
  return Math.hypot(d.end[0]-d.start[0],d.end[1]-d.start[1]);
}
