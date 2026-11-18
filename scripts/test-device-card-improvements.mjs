import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "artifacts/omni-app/device-card-check");
await mkdir(output, { recursive: true });

let vite, browser;
try {
  vite = await createServer({
    configFile: join(root, "vite.omni.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: true, open: false }
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;

  browser = await chromium.launch({
    executablePath: join(root, ".tools/playwright/chromium-1234/chrome-linux64/chrome"),
    headless: true,
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"]
  });

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  await page.goto(`${origin}/lab.html?mode=live`);
  const app = page.frameLocator("iframe");
  await app.getByRole("heading", { name: "扫描工作台" }).waitFor();

  // 1. Verify three dots button is gone
  const ellipsisCount = await app.locator(".section-mini-title button").count();
  assert.equal(ellipsisCount, 0, "Three dots button must be removed from section-mini-title");
  console.log("1. Checked: Three dots button removed from device card");

  // Take screenshot of home page default state
  await page.screenshot({ path: join(output, "1-home-default.png") });

  // 2. Click '连接设备' to expand the inline dropdown
  await app.getByRole("button", { name: /连接设备|已连接 OMNI/ }).click();
  await page.waitForTimeout(300);

  // Assert dropdown panel is visible
  const dropdownCount = await app.locator(".device-dropdown-panel").count();
  assert.equal(dropdownCount, 1, "device-dropdown-panel must be visible");

  // Assert NO modal dialog is open
  const modalCount = await app.locator(".demo-dialog[open]").count();
  assert.equal(modalCount, 0, "No modal should open when expanding device dropdown");
  console.log("2. Checked: '连接设备' expands inline dropdown smoothly without modal");

  await page.screenshot({ path: join(output, "2-device-dropdown-expanded.png") });

  // 3. Test '开始扫描 ->' button: directly enters capture without confirmation
  await app.getByRole("button", { name: "开始扫描", exact: true }).click();
  await page.waitForTimeout(300);

  // Assert we are in capture page
  await app.locator(".capture-page").waitFor();
  const captureModalCount = await app.locator(".demo-dialog[open]").count();
  assert.equal(captureModalCount, 0, "No modal should open when clicking '开始扫描'");
  console.log("3. Checked: '开始扫描' directly entered capture view without any confirmation popup");

  await page.screenshot({ path: join(output, "3-capture-direct-entry.png") });

  // Return to home page
  await app.getByRole("button", { name: /返回设备|返回扫描工作台/ }).click();
  await app.getByRole("heading", { name: "扫描工作台" }).waitFor();

  // 4. Test opening connect modal via header device-pill to verify the new modal card design
  await app.locator(".device-pill").click();
  await page.waitForTimeout(300);

  const modalOpen = await app.locator(".demo-dialog[open]").count();
  assert.equal(modalOpen, 1, "Modal should open when clicking header device-pill");

  const modalDeviceCard = await app.locator(".modal-device-card").count();
  assert.equal(modalDeviceCard, 1, "New modal-device-card must be rendered");

  console.log("4. Checked: Header device-pill opens cleanly redesigned modal-device-card");
  await page.screenshot({ path: join(output, "4-redesigned-modal.png") });

  console.log("ALL DEVICE CARD IMPROVEMENT TESTS PASSED!");
} finally {
  await browser?.close();
  await vite?.close();
}
