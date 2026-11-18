import {openStudioView} from "./studioPage";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const root=process.env.PAIRED_TRI_WORKSPACE;
test("真实三目工程：逐路切换、三维支持、原图及相机身份保存恢复",async({page})=>{
  test.skip(!root,"设置 PAIRED_TRI_WORKSPACE 指向三目工程目录");
  const review=JSON.parse(await readFile(`${root}/三目采集-关键帧.pvframes`,"utf8"));
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/");
  const open=page.waitForEvent("filechooser");await page.getByRole("button",{name:"打开工程",exact:true}).click();await(await open).setFiles(`${root}/三目采集-联合复核.pvplan`);
  await expect(page.locator(".status-bar")).toContainText("测量工程已恢复",{timeout:30000});await openStudioView(page,"关键帧复核");
  await expect(page.locator(".work-toolbar")).toContainText("24 张原图 · 14 条候选");
  for(const [cameraId,name] of [["front","前视"],["left","左视"],["right","右视"]]){
    await page.getByLabel("相机选择",{exact:true}).selectOption(cameraId!);
    await expect(page.getByLabel("关键帧选择",{exact:true}).locator("option")).toHaveCount(8);
    const frame=review.frames.find((f:any)=>f.cameraId===cameraId && f.analyzed && f.candidates.some((a:any)=>a.envelope));
    await page.getByLabel("关键帧选择",{exact:true}).selectOption(frame.id);
    await expect(page.locator(".paired-image footer")).toContainText(`${name} · ${frame.name}`);
    await expect(page.locator(".paired-image image")).toHaveAttribute("href",frame.image);
    const candidate=frame.candidates.find((a:any)=>a.envelope);
    await page.locator(`[aria-label^="图像候选 ${candidate.id} "]`).click();
    await expect(page.locator(".cloud-view")).toHaveAttribute("data-review-candidate",candidate.id);
    await expect.poll(async()=>Number(await page.locator(".cloud-view").getAttribute("data-review-points"))).toBeGreaterThan(0);
    await page.getByLabel("复核备注",{exact:true}).fill(`${name}现场证据`);
    await page.screenshot({path:`artifacts/paired-tri-${cameraId}.png`});
  }
  const exported=page.waitForEvent("download");await page.getByRole("button",{name:"导出复核记录",exact:true}).click();
  const decisions=JSON.parse(await readFile((await(await exported).path())!,"utf8"));
  expect([...new Set(decisions.frames.map((f:any)=>f.cameraId))].sort()).toEqual(["front","left","right"]);
  const saved=page.waitForEvent("download");await page.getByRole("button",{name:"保存工程",exact:true}).click();const project=await saved;
  const reopen=page.waitForEvent("filechooser");await page.getByRole("button",{name:"打开工程",exact:true}).click();await(await reopen).setFiles((await project.path())!);
  await expect(page.locator(".status-bar")).toContainText("测量工程已恢复",{timeout:30000});await openStudioView(page,"关键帧复核");
  await expect(page.getByLabel("复核备注",{exact:true})).toHaveValue("右视现场证据");
  // 从右视复核切换到只有前视的旧工程，筛选必须自动回到可用相机。
  page.once("dialog",d=>d.accept());
  const legacy=page.waitForEvent("filechooser");await page.getByRole("button",{name:"打开工程",exact:true}).click();await(await legacy).setFiles(`${process.env.PAIRED_WORKSPACE}/桌上采集-联合复核.pvplan`);
  await expect(page.locator(".work-toolbar")).toContainText("13 张原图",{timeout:30000});
  await expect(page.getByLabel("相机选择",{exact:true})).toHaveValue("all");
  await expect(page.locator(".paired-image footer")).toContainText("前视");
  expect(errors).toEqual([]);
});
