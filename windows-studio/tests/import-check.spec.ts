import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { openStudioView } from "./studioPage";

const fixtureDir = path.resolve("artifacts/import-check-fixtures");
const afterDir = path.resolve("artifacts/after");
const mmPath = path.join(fixtureDir, "room-mm.pcd");
const framesPath = path.join(fixtureDir, "room.pvframes");
let mmBytes: Buffer;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function roomPcd(scale: number) {
  const rows: string[] = [];
  for (let z = .2; z <= 2.8 + 1e-9; z += .2) {
    for (let x = 0; x <= 8 + 1e-9; x += .05) rows.push(`${(x * 1000 * scale).toFixed(2)} 0 ${(z * 1000 * scale).toFixed(2)}`, `${(x * 1000 * scale).toFixed(2)} ${6000 * scale} ${(z * 1000 * scale).toFixed(2)}`);
    for (let y = 0; y <= 6 + 1e-9; y += .05) rows.push(`0 ${(y * 1000 * scale).toFixed(2)} ${(z * 1000 * scale).toFixed(2)}`, `${8000 * scale} ${(y * 1000 * scale).toFixed(2)} ${(z * 1000 * scale).toFixed(2)}`);
  }
  return Buffer.from(`VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\nPOINTS ${rows.length}\nDATA ascii\n${rows.join("\n")}\n`);
}

async function importCloud(page: Page, file: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入测量成果", exact: true }).click();
  await (await chooser).setFiles(file);
  await expect(page.locator(".status-bar")).toContainText("已导入", { timeout: 30000 });
}

async function checkBar(page: Page) {
  return page.getByRole("group", { name: "导入单位与范围核对" });
}

async function failUnitReimport(page: Page) {
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    (window as any).__restoreImportWorker = () => { Worker.prototype.postMessage = original; };
    Worker.prototype.postMessage = function (this: Worker, message: any, transfer?: any) {
      if (message?.action === "import" && message?.source?.units === "mm") {
        const id = message.id;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id, error: "模拟重解码失败" } })));
        return;
      }
      return original.call(this, message, transfer);
    } as typeof Worker.prototype.postMessage;
  });
}

async function restoreUnitReimport(page: Page) {
  await page.evaluate(() => (window as any).__restoreImportWorker?.());
}

test.beforeAll(async () => {
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(afterDir, { recursive: true });
  mmBytes = roomPcd(1);
  await writeFile(mmPath, mmBytes);
  const jpeg = await readFile(new URL("./fixtures/keyframe.jpg", import.meta.url));
  const imageSha = sha256(jpeg);
  const review = {
    schema: "survey-paired-review/1", session: "fixture", sourceSha256: sha256(mmBytes), frameId: "camera_init", poseSpace: "raw", units: "m",
    alignmentVerified: false, captureQuality: "partial", model: { id: "unassigned", revision: "none" },
    camera: { model: "opencv_rational8", width: 16, height: 16, intrinsics: [10, 10, 8, 8], distortion: Array(8).fill(0) },
    walls: [],
    frames: [{
      id: "fixture-frame", name: "fixture.jpg", stampNs: "1000000000", sha256: imageSha,
      image: `data:image/jpeg;base64,${jpeg.toString("base64")}`, cameraId: "front",
      TWorldCamera: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], analyzed: false, candidates: [],
    }],
  };
  await writeFile(framesPath, JSON.stringify(review));
});

test("正常米制导入显示单位、完整范围与点数，成图不增加确认步骤", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto("/");
  await page.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("合成示例");
  const bar = await checkBar(page);
  await expect(bar).toContainText("源单位 米");
  await expect(bar).toContainText("范围 8.00 × 6.00 × 2.40 m");
  await expect(bar).toContainText("7,332 点");
  await expect(bar).not.toContainText("范围可疑");
  await expect(bar.getByRole("button", { name: "按毫米重新导入", exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(afterDir, "01-normal.png") });
  await page.getByRole("button", { name: "生成工程图", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("工程图已生成", { timeout: 30000 });
  expect(dialogs).toEqual([]);
});

test("毫米坐标误按米导入：警告、取消、失败保留原工程，切换后恢复尺寸并可保存恢复", async ({ page }) => {
  await page.goto("/");
  await importCloud(page, mmPath);
  let bar = await checkBar(page);
  await expect(bar).toContainText("源单位 米");
  await expect(bar).toContainText("范围 8000.00 × 6000.00 × 2600.00 m");
  await expect(bar).toContainText("7,896 点");
  await expect(bar).toContainText("范围可疑");
  await expect(bar).toContainText("水平范围 8000.00 m");
  await expect(bar.getByRole("button", { name: "按毫米重新导入", exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(afterDir, "02-mm-as-m.png") });

  // 未确认可疑单位时，成图必须先确认；取消后不生成。
  const generatePrompt = new Promise<string>(resolve => page.once("dialog", async dialog => { resolve(dialog.message()); await dialog.dismiss(); }));
  await page.getByRole("button", { name: "生成工程图", exact: true }).click();
  const generateMessage = await generatePrompt;
  expect(generateMessage).toContain("范围可疑");
  expect(generateMessage).toContain("是否仍按当前单位生成工程图");
  await expect(page.locator(".status-bar")).toContainText("已暂缓生成");
  await expect(page.getByText("暂无工程图纸", { exact: true })).toBeVisible();
  // 用户也可明确选择按当前单位继续；尺寸异常时由既有算法如实失败。
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "生成工程图", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("建筑范围为空或过大", { timeout: 30000 });

  // 取消单位切换保留当前工程。
  const switchPrompt = new Promise<string>(resolve => page.once("dialog", async dialog => { resolve(dialog.message()); await dialog.dismiss(); }));
  await bar.getByRole("button", { name: "按毫米重新导入", exact: true }).click();
  expect(await switchPrompt).toContain("会清理当前工程的裁剪、图纸、标注、建筑模型、精度记录和关键帧关联");
  await expect(page.locator(".status-bar")).toContainText("已取消按毫米重新解码");
  await expect(bar).toContainText("8000.00 × 6000.00 × 2600.00 m");

  // 模拟重解码失败：不提交任何新状态，原工程仍可用。
  await failUnitReimport(page);
  page.once("dialog", dialog => dialog.accept());
  await bar.getByRole("button", { name: "按毫米重新导入", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("模拟重解码失败");
  await expect(bar).toContainText("8000.00 × 6000.00 × 2600.00 m");
  await expect(bar).toContainText("源单位 米");
  await restoreUnitReimport(page);

  // 成功切换到毫米：旧尺度成果清理，恢复正确尺寸并生成墙线图。
  page.once("dialog", dialog => dialog.accept());
  await bar.getByRole("button", { name: "按毫米重新导入", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("已按毫米重新解码");
  bar = await checkBar(page);
  await expect(bar).toContainText("源单位 毫米");
  await expect(bar).toContainText("范围 8.00 × 6.00 × 2.60 m");
  await expect(bar).not.toContainText("范围可疑");
  await expect(bar.getByRole("button", { name: "按米重新导入", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "生成工程图", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("工程图已生成", { timeout: 30000 });

  // 保存工程：源文件字节与 SHA256 保持不变；重新打开后仍显示范围核对。
  const savePromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存工程", exact: true }).click();
  const projectPath = (await (await savePromise).path())!;
  const project = unzipSync(await readFile(projectPath));
  const sourceBin = project["source.bin"]!;
  expect(Buffer.from(sourceBin)).toEqual(mmBytes);
  expect(sha256(sourceBin)).toBe(sha256(mmBytes));
  expect(JSON.parse(strFromU8(project["project.json"]!)).source.units).toBe("mm");
  await expect(page.locator(".status-bar")).toContainText("工程已保存");

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "打开工程", exact: true }).click();
  await (await chooser).setFiles(projectPath);
  await expect(page.locator(".status-bar")).toContainText("测量工程已恢复");
  bar = await checkBar(page);
  await expect(bar).toContainText("源单位 毫米");
  await expect(bar).toContainText("范围 8.00 × 6.00 × 2.60 m");
  await expect(bar).toContainText("7,896 点");
  await expect(bar.getByRole("button", { name: "按米重新导入", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: /^(生成|更新)工程图$/ }).click();
  await expect(page.locator(".status-bar")).toContainText("工程图已生成", { timeout: 30000 });
  await page.screenshot({ path: path.join(afterDir, "03-mm-fixed.png") });
});

test("带关键帧工程：失败切换保留关联，成功切换后清理并可保存重开", async ({ page }) => {
  await page.goto("/");
  await importCloud(page, mmPath);
  await openStudioView(page, "关键帧复核");
  const frames = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入关键帧附件", exact: true }).click();
  await (await frames).setFiles(framesPath);
  await expect(page.locator(".status-bar")).toContainText("关键帧原图与点云校验通过");
  await expect(page.getByText("1 张原图", { exact: false })).toBeVisible();

  // 解码失败时不清理关键帧关联，原工程仍可继续复核。
  await page.getByRole("button", { name: "点云与 CAD", exact: true }).click();
  await failUnitReimport(page);
  page.once("dialog", dialog => dialog.accept());
  await (await checkBar(page)).getByRole("button", { name: "按毫米重新导入", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("模拟重解码失败");
  await openStudioView(page, "关键帧复核");
  await expect(page.getByText("1 张原图", { exact: false })).toBeVisible();
  await restoreUnitReimport(page);

  // 成功切换后清空旧尺度关键帧关联。
  await page.getByRole("button", { name: "点云与 CAD", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await (await checkBar(page)).getByRole("button", { name: "按毫米重新导入", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("已按毫米重新解码");
  await openStudioView(page, "关键帧复核");
  await expect(page.getByRole("heading", { name: "暂无关键帧", exact: true })).toBeVisible();

  // 浏览器工程保存/重开后也不恢复旧关键帧复核。
  await page.getByRole("button", { name: "点云与 CAD", exact: true }).click();
  const save = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存工程", exact: true }).click();
  const savedPath = (await (await save).path())!;
  const entries = unzipSync(await readFile(savedPath));
  expect(JSON.parse(strFromU8(entries["project.json"]!)).pairedReview).toBeUndefined();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "打开工程", exact: true }).click();
  await (await chooser).setFiles(savedPath);
  await expect(page.locator(".status-bar")).toContainText("测量工程已恢复");
  await openStudioView(page, "关键帧复核");
  await expect(page.getByRole("heading", { name: "暂无关键帧", exact: true })).toBeVisible();
});
