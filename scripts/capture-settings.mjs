import { chromium } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const chromePath = join(root, ".tools/playwright/chromium-1234/chrome-linux64/chrome");
const outDir = "/home/jn/.gemini/antigravity-cli/brain/36423190-4459-471f-8c81-ae463b4cacf4";

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  // 1. Live mode settings modal dialog
  const pageLive = await browser.newPage({ viewport: { width: 440, height: 900 } });
  await pageLive.goto("http://127.0.0.1:5174/index.html");
  await pageLive.waitForSelector(".app-header .avatar");
  await pageLive.locator(".app-header .avatar").click();
  await pageLive.waitForSelector(".demo-dialog");
  await pageLive.waitForTimeout(600);
  await pageLive.locator(".demo-dialog").screenshot({ path: join(outDir, "live-settings-modal.png") });
  await pageLive.screenshot({ path: join(outDir, "live-settings-full.png") });
  await pageLive.close();

  // 2. Demo mode settings modal dialog
  const pageDemo = await browser.newPage({ viewport: { width: 440, height: 900 } });
  await pageDemo.goto("http://127.0.0.1:5174/index.html?mode=demo");
  await pageDemo.waitForSelector(".app-header .avatar");
  await pageDemo.locator(".app-header .avatar").click();
  await pageDemo.waitForSelector(".demo-dialog");
  await pageDemo.waitForTimeout(600);
  await pageDemo.locator(".demo-dialog").screenshot({ path: join(outDir, "demo-settings-modal.png") });
  await pageDemo.screenshot({ path: join(outDir, "demo-settings-full.png") });
  await pageDemo.close();

  console.log("Screenshots captured successfully!");
} catch (e) {
  console.error("Failed to capture screenshots:", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
