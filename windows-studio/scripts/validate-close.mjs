import {_electron as electron,expect} from '@playwright/test';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
const out=path.resolve('artifacts/windows-close-20261020');await mkdir(out,{recursive:true});const results=[];
async function launch(){const profile=await mkdtemp(path.join(os.tmpdir(),'survey-close-'));return electron.launch({executablePath:path.resolve('../node_modules/electron/dist/electron'),args:[path.resolve('.'),'--no-sandbox','--user-data-dir='+profile],env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});}
function dialogs(page){page.on('dialog',d=>{if(d.type()!=='beforeunload')void d.dismiss().catch(()=>{});});return page;}
async function closeWindow(app){await app.evaluate(({BrowserWindow})=>{setTimeout(()=>BrowserWindow.getAllWindows()[0].close(),20);});}
async function closed(app){if(app.process().exitCode!==null)return;await Promise.race([new Promise(r=>app.process().once('exit',r)),new Promise((_,j)=>setTimeout(()=>j(Error('Application did not exit')),8000))]);}
let app;
try{
 app=await launch();dialogs(await app.firstWindow());await closeWindow(app);await closed(app);results.push('未修改空工程正常退出，无确认框');app=undefined;
 app=await launch();let page=dialogs(await app.firstWindow());await app.evaluate(({dialog})=>{globalThis.closeChoices=[];globalThis.closeChoice=0;dialog.showMessageBoxSync=(_w,options)=>{globalThis.closeChoices.push(options);return globalThis.closeChoice;};});
 await page.getByRole('button',{name:'打开示例',exact:true}).click();await expect(page.locator('.file-name')).toContainText('未保存');
 await closeWindow(app);await expect.poll(()=>app.evaluate(()=>globalThis.closeChoices.length)).toBe(1);expect(page.isClosed()).toBe(false);expect(await app.evaluate(()=>globalThis.closeChoices[0].cancelId)).toBe(0);results.push('未保存工程关闭触发原生确认，返回保留窗口与内容');
 const saved=path.join(await mkdtemp(path.join(os.tmpdir(),'survey-close-save-')),'保存后关闭.pvplan');await app.evaluate(({dialog},target)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:target});},saved);await page.getByRole('button',{name:'保存工程',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('工程已保存');await closeWindow(app);await closed(app);results.push('返回保存后可正常退出');app=undefined;
 app=await launch();page=dialogs(await app.firstWindow());await app.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>1;});await page.getByRole('button',{name:'打开示例',exact:true}).click();await expect(page.locator('.file-name')).toContainText('未保存');await closeWindow(app);await closed(app);results.push('明确放弃未保存修改后可正常退出');app=undefined;
 app=await launch();page=dialogs(await app.firstWindow());await app.evaluate(({dialog,ipcMain})=>{globalThis.busyClosePrompts=0;dialog.showMessageBoxSync=()=>{globalThis.busyClosePrompts++;return 0;};ipcMain.removeHandler('survey:open');ipcMain.handle('survey:open',()=>new Promise(r=>{globalThis.finishOpen=r;}));});await page.getByRole('button',{name:'导入测量成果',exact:true}).click();await expect(page.locator('.status-bar')).toContainText('读取测量成果');await closeWindow(app);await expect.poll(()=>app.evaluate(()=>globalThis.busyClosePrompts)).toBe(1);expect(page.isClosed()).toBe(false);await app.evaluate(()=>globalThis.finishOpen(undefined));await expect(page.getByRole('button',{name:'导入测量成果',exact:true})).toBeEnabled();await closeWindow(app);await closed(app);results.push('未修改但正在执行任务时同样确认，任务结束后可退出');app=undefined;
}catch(error){await writeFile(path.join(out,'local-result.json'),JSON.stringify({results,error:String(error)},null,2));throw error;}
finally{if(app)app.process().kill();}
await writeFile(path.join(out,'local-result.json'),JSON.stringify({results},null,2));console.log(results);
