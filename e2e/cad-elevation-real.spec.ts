import { basename } from "node:path";
import { expect, test } from "@playwright/test";

test("真实室内 PCD 的前视和侧视 CAD 仅使用二维地图实测墙带", async ({ page }) => {
  test.skip(!process.env.CAD_REAL_FIXTURE, "未提供 CAD_REAL_FIXTURE");
  test.setTimeout(120_000);
  const source = process.env.CAD_REAL_FIXTURE!;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1800, height: 1130 });
  await page.goto("/");

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入点云" }).click();
  await (await chooserPromise).setFiles(source);
  await expect(page.getByText(new RegExp(`已加载 ${basename(source)}`))).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "CAD", exact: true }).click();

  const wallMetric = page.locator(".cad-metrics > div").filter({ hasText: "实测 / 推断" }).locator("strong");
  await expect(page.locator(".cad-inspector-tabs").getByRole("tab")).toHaveCount(3);
  await expect(page.locator(".cad-layer-panel")).toHaveCount(0);
  const previewBox = await page.locator(".cad-preview-pane").boundingBox();
  const inspectorBox = await page.locator(".cad-parameter-panel").boundingBox();
  expect(previewBox).not.toBeNull(); expect(inspectorBox).not.toBeNull();
  expect(previewBox!.width).toBeGreaterThan(inspectorBox!.width * 2);
  await page.getByRole("button", { name: "生成预览" }).click();
  await expect(page.locator(".cad-workflow-badge")).toContainText("预览可导出", { timeout: 30_000 });
  await expect(wallMetric).toContainText("6 / 0", { timeout: 30_000 });
  await page.screenshot({ path: "/tmp/point-view-cad-top-xy-evidence.png" });

  await page.getByLabel("CAD 投影平面").selectOption("xz");
  await page.getByRole("button", { name: "重新预览" }).click();
  await expect(page.locator(".cad-workflow-badge")).toContainText("预览可导出", { timeout: 30_000 });
  await expect(wallMetric).toContainText("10 / 0", { timeout: 30_000 });
  await page.screenshot({ path: "/tmp/point-view-cad-front-xz-fixed.png" });

  await page.getByLabel("CAD 投影平面").selectOption("yz");
  await page.getByRole("button", { name: "重新预览" }).click();
  await expect(page.locator(".cad-workflow-badge")).toContainText("预览可导出", { timeout: 30_000 });
  await expect(wallMetric).toContainText("10 / 0", { timeout: 30_000 });
  await page.screenshot({ path: "/tmp/point-view-cad-side-yz-fixed.png" });
  await page.getByRole("tab", { name: /^复核/ }).click();
  await page.getByText("处理记录").click();
  await expect(page.getByText("EVIDENCE_MAP_DRIVEN", { exact: true })).toBeVisible();
  await expect(page.getByText("ORTHOGONAL_ALIGNMENT", { exact: true })).toBeVisible();

  expect(pageErrors).toEqual([]);
});
