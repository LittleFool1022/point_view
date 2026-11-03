import {openStudioView} from "./studioPage";
import {test,expect,_electron as electron,type ElectronApplication,type Page} from '@playwright/test';
import {mkdtemp,mkdir,rm,readFile,writeFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync,strFromU8} from 'fflate';

test('完整PCD与全部原图卷自动接收→本地AI/BIM→切卷保存→脱离设备恢复→统一交付',async()=>{
  const endpoint=process.env.SURVEY_DEVICE_REPLAY;
  test.skip(!endpoint,'设置只读设备回放地址SURVEY_DEVICE_REPLAY');
  test.setTimeout(60000);
  const output=process.env.SURVEY_PAGES_OUTPUT??'artifacts/production-pages';await mkdir(output,{recursive:true});
  const project=path.resolve(output,'production-pages.pvplan'),archive=path.resolve(output,'production-pages-review.zip');
  const temporary=await mkdtemp(path.join(tmpdir(),'survey-pages-ui-'));
  const root=fileURLToPath(new URL('../',import.meta.url));
  let app:ElectronApplication|undefined;let page:Page;const errors:string[]=[];
  async function launch(profile:string){
    app=await electron.launch({args:[`--user-data-dir=${path.join(temporary,profile)}`,root]});
    page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    await page.locator('.brand strong').waitFor();
    await app.evaluate(({dialog},destinations)=>{
      const queue=[...destinations];
      dialog.showSaveDialog=async()=>({canceled:false,filePath:queue.shift()!});
      dialog.showMessageBoxSync=()=>1;
    },[project,archive]);
  }
  async function switchPage(id:string){
    if(await page!.getByLabel('原图卷',{exact:true}).inputValue()===id)return;
    await page!.getByLabel('原图卷',{exact:true}).selectOption(id);
    await expect(page!.locator('.status-bar')).toContainText('原图卷已恢复');
  }
  try{
    await launch('first');
    await page!.getByRole('button',{name:'从设备接收',exact:true}).click();
    await page!.getByLabel('设备地址',{exact:true}).fill(endpoint!);
    await page!.getByRole('button',{name:'读取扫描列表',exact:true}).click();
    await expect(page!.locator('.device-projects')).toContainText('2,106,775');
    await page!.getByRole('button',{name:'接收并导入',exact:true}).click();
    await expect(page!.locator('.status-bar')).toContainText('卷原图已接收并校验',{timeout:20000});await openStudioView(page!,"关键帧复核");
    const options=await page!.getByLabel('原图卷',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value));
    expect(options.length).toBeGreaterThan(1);
    let selected='';
    for(const id of options){
      await switchPage(id);
      if(await page!.getByLabel('相机选择',{exact:true}).locator('option[value=left]').count()){selected=id;break;}
    }
    expect(selected).not.toBe('');
    await page!.getByLabel('相机选择',{exact:true}).selectOption('left');
    await page!.getByRole('button',{name:'本地 AI 识别当前帧',exact:true}).click();
    await expect(page!.locator('.status-bar')).toContainText('本地 AI 已完成 1 帧识别',{timeout:20000});
    await expect(page!.locator('.paired-candidates button').first()).toBeVisible();
    await page!.getByRole('button',{name:'保留候选',exact:true}).click();
    await page!.getByLabel('复核备注',{exact:true}).fill('跨原图卷自动流程测试，物理尺寸尚待人工核验');
    await page!.getByRole('button',{name:'生成墙带建筑草案',exact:true}).click();
    await expect(page!.locator('.status-bar')).toContainText('面墙带草案');
    await page!.getByRole('button',{name:'按当前参数加入 BIM 草案',exact:true}).click();
    await expect(page!.locator('.status-bar')).toContainText('已加入待复核 BIM 草案');
    const another=options.find(id=>id!==selected)!;await switchPage(another);
    await page!.getByRole('button',{name:'保存工程',exact:true}).click();
    await expect(page!.locator('.status-bar')).toContainText('工程已保存');
    const handle=await open(project,'r'),head=Buffer.alloc(12);await handle.read(head,0,12,0);await handle.close();
    expect(head.subarray(0,8).toString()).toBe('PVPLAN3\n');expect(head.readUInt32LE(8)).toBeLessThan(1024**2);
    await app!.close();app=undefined;
    await launch('restored');
    await app!.evaluate(({dialog},project)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[project]});dialog.showSaveDialog=async()=>({canceled:false,filePath:project.replace(/\.pvplan$/,'-review.zip')});},project);
    // 已接收工程不依赖设备；renderer 禁网后仍从工程原件及原图卷恢复。
    await page!.context().setOffline(true);
    await page!.getByRole('button',{name:'打开工程',exact:true}).click();
    await expect(page!.locator('.status-bar')).toContainText('测量工程已恢复',{timeout:20000});await openStudioView(page!,"关键帧复核");
    expect(await page!.getByLabel('原图卷',{exact:true}).locator('option').count()).toBe(options.length);
    await expect(page!.getByLabel('原图卷',{exact:true})).toHaveValue(another);
    await openStudioView(page!,"建筑模型");
    await page!.getByRole('button',{name:'导出 CAD / BIM 复核包',exact:true}).click();
    await expect(page!.locator('.status-bar')).toContainText('同修订成果包已保存');
    const entries=unzipSync(await readFile(archive)),manifest=JSON.parse(strFromU8(entries['manifest.json']!)),model=JSON.parse(strFromU8(entries['building.json']!)),report=JSON.parse(strFromU8(entries['review.json']!));
    expect(manifest.source.points).toBe(2106775);expect(manifest.deviceReceipt.keyframeSets).toHaveLength(options.length);
    expect(model.openings).toHaveLength(1);expect(report.issues.some((issue:any)=>issue.code==='OBSERVATION_UNAVAILABLE')).toBe(false);
    expect(report.constructionAccepted).toBe(false);
    const frames=JSON.parse(strFromU8(entries['keyframe-decisions.json']!)).frames;
    expect(new Set(frames.map((frame:any)=>frame.pageId)).size).toBe(options.length);
    await openStudioView(page!,"关键帧复核");await switchPage(selected);
    await page!.getByLabel('相机选择',{exact:true}).selectOption('left');
    await expect(page!.getByLabel('复核备注',{exact:true})).toHaveValue('跨原图卷自动流程测试，物理尺寸尚待人工核验');
    await page!.screenshot({path:path.join(output,'restored-pages.png')});
    await writeFile(path.join(output,'validation.json'),JSON.stringify({liveOMNI:false,endpoint,pages:options.length,frames:frames.length,sourcePoints:manifest.source.points,sourceSha256:manifest.source.sha256,walls:model.walls.length,openings:model.openings.length,manifestBytes:head.readUInt32LE(8),engineeringAccepted:false,nativePicker:'test override; actual main-process streaming IO',errors},null,2));
    expect(errors).toEqual([]);
  }finally{
    if(app){
      // 用例已验证保存；销毁隔离测试窗口，避免自动化与beforeunload同时处理对话框。
      const closed=app.waitForEvent('close');
      await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();});
      await closed;
    }
    await rm(temporary,{recursive:true,force:true});
  }
});
