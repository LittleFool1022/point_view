import { test, expect } from "@playwright/test";
import { encodeProject } from "../src/domain/project";
import { demoRoom } from "../src/domain/demo";

type DigestGate = { started: Promise<void>; finished: Promise<void>; release(): void };
declare global { interface Window { digestGate: DigestGate } }

function installDigestGate() {
  const subtle = crypto.subtle, original = subtle.digest.bind(subtle);
  let open!: () => void, started!: () => void, finished!: () => void;
  const hold = new Promise<void>(resolve => { open = resolve; });
  const gate: DigestGate = {
    started: new Promise<void>(resolve => { started = resolve; }),
    finished: new Promise<void>(resolve => { finished = resolve; }),
    release: () => open(),
  };
  Object.assign(window, { digestGate: gate });
  let blocked = false;
  subtle.digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
    if (blocked) return original(...args);
    blocked = true; started(); await hold;
    try { return await original(...args); } finally { finished(); }
  };
}


test("取消打开旧工程后，迟到的解码不能覆盖新示例", async ({ page }) => {
  const bytes = await encodeProject({ source: { name: "old-project.pcd", bytes: demoRoom(), units: "m", synthetic: true }, annotations: [], projection: "xy", settings: {} });
  await page.addInitScript(installDigestGate);
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "打开工程", exact: true }).click();
  await (await chooser).setFiles({ name: "old.pvplan", mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
  await page.evaluate(() => window.digestGate.started);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("合成示例");
  await page.evaluate(() => { window.digestGate.release(); return window.digestGate.finished; });
  await expect(page.locator(".file-name")).toHaveText("合成房间示例.pcd · 未保存");
  await expect(page.locator(".status-bar")).toContainText("合成示例");
});

test("取消保存后不下载旧快照，也不清除后续编辑的未保存状态", async ({ page }) => {
  const downloads: string[] = []; page.on("download", download => downloads.push(download.suggestedFilename()));
  await page.goto("/");
  await page.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("合成示例");
  await page.getByRole("button", { name: "智能出图", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("工程图已生成");
  await page.evaluate(installDigestGate);
  await page.getByRole("button", { name: "保存工程", exact: true }).click();
  await page.evaluate(() => window.digestGate.started);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByText("尺寸与工程标注", { exact: true }).click();
  await page.getByRole("button", { name: "在图纸放置标注", exact: true }).click();
  const canvas = page.getByLabel("在图纸中放置标注 取消后的新修改", { exact: true }), bounds = await canvas.boundingBox();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await expect(page.getByText("1 条人工标注", { exact: false })).toBeVisible();
  await page.evaluate(() => { window.digestGate.release(); return window.digestGate.finished; });
  await expect(page.locator(".file-name")).toHaveClass(/is-dirty/);
  await expect(page.locator(".file-name")).toContainText("未保存");
  expect(downloads).toEqual([]);
});
