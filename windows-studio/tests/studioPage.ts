import type {Page} from '@playwright/test';
export async function openStudioView(page:Page,name:string){
 if(['建筑模型','建筑效果图','关键帧复核'].includes(name)){
  const menu=page.locator('.extensions-menu');if(!(await menu.evaluate(el=>(el as HTMLDetailsElement).open)))await menu.locator('summary').click();
 }
 await page.getByRole('button',{name,exact:true}).click();
}
