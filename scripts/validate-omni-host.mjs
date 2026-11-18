import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

// 真机接收验证：只操作 App，不登录主机、不调用设备服务。
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "artifacts/omni-app/host-preview", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { endpoint: "ws://10.42.0.1:8765", checks: [], missing: [], samples: [], browserErrors: [], clientOperations: [], subscriptions: [] };
const operations = new Set();
const channels = new Map();
let vite, browser, page;
try {
  vite = await createServer({ configFile: join(root, "vite.omni.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: true, open: false } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: join(root, ".tools/playwright/chromium-1234/chrome-linux64/chrome"), headless: true, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => report.browserErrors.push(error.message));
  page.on("websocket", socket => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload);
      if (message.op === "advertise") message.channels.forEach(channel => channels.set(channel.id, channel.topic));
    });
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") { operations.add("binary"); return; }
      const message = JSON.parse(payload);
      operations.add(message.op);
      if (message.op === "subscribe") report.subscriptions.push(...message.subscriptions.map(item => channels.get(item.channelId) ?? item.channelId));
    });
  });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.__omniReceived = { cloud: [], image: [], sync: [] };
    window.addEventListener("message", event => {
      if (event.origin !== location.origin || event.data?.type !== "omni-app:state") return;
      window.__omniHostState = event.data;
      for (const key of ["cloud", "image", "sync"]) {
        const stamp = event.data.receivedAt?.[key];
        const stamps = window.__omniReceived[key];
        if (stamp && stamp !== stamps.at(-1)) stamps.push(stamp);
      }
    });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/lab.html?mode=live`);
  const app = page.frameLocator("iframe");
  await app.getByRole("button", { name: "连接预览", exact: true }).click();
  await page.waitForFunction(() => window.__omniHostState?.connection === "connected" && window.__omniHostState?.channels?.length);
  report.checks.push("真实 OMNI Foxglove 握手和话题公告");
  console.log(JSON.stringify({ stage: "connected", state: await page.evaluate(() => window.__omniHostState) }));
  await app.getByRole("button", { name: "进入实时预览", exact: true }).click();
  const frame = page.frames().find(item => item.url().includes("/index.html"));
  await page.waitForFunction(() => window.__omniHostState?.cloudStatus === "live");
  await app.locator("canvas").waitFor();
  const cloudStart = await page.evaluate(() => ({ cloud: window.__omniReceived.cloud.length, sync: window.__omniReceived.sync.length }));
  await page.waitForFunction(start => window.__omniReceived.cloud.length >= start.cloud + 5 && window.__omniReceived.sync.length >= start.sync + 2, cloudStart);
  report.samples.push(await page.evaluate(() => ({ kind: "cloud", state: window.__omniHostState, received: window.__omniReceived })));
  report.checks.push("真实点云连续接收至少 5 帧，绘制 canvas，同步状态独立更新");
  const availableCameras = await page.evaluate(() => window.__omniHostState.availableCameras);
  report.missing = ["front", "left", "right"].filter(camera => !availableCameras.includes(camera)).map(camera => `/omni/camera/${camera}/image/compressed`);
  if (availableCameras.length === 0) {
    await app.getByText("相机画面未开放", { exact: true }).waitFor();
    assert.equal(await app.getByRole("button", { name: "切换相机", exact: true }).count(), 0);
    report.checks.push("相机未开放时显示简短状态并隐藏无效切换操作");
  }
  assert.doesNotMatch(await app.locator("body").innerText(), /WebSocket|schema|topic|点云接收|当前帧|诊断|unknown|消息解析|Worker/);
  await app.locator(".live-capture").screenshot({ path: join(output, "cloud.png") });
  const originalCanvas = await app.locator("canvas").elementHandle();
  await page.getByRole("button", { name: "旋转屏幕", exact: true }).click();
  await frame.waitForFunction(() => innerWidth > innerHeight);
  assert.equal(await originalCanvas.evaluate(element => element === document.querySelector("canvas")), true);
  await app.getByRole("button", { name: "切换主画面", exact: true }).click();
  assert.equal(await originalCanvas.evaluate(element => element === document.querySelector("canvas")), true);
  await app.getByRole("button", { name: "切换主画面", exact: true }).click();
  report.checks.push("真实数据下旋转和切换主画面保留同一个 canvas，App 无调试详情");
  await app.locator(".live-capture").screenshot({ path: join(output, "cloud-landscape.png") });
  for (const camera of availableCameras) {
    while (await page.evaluate(() => window.__omniHostState.camera) !== camera) await app.getByRole("button", { name: "切换相机", exact: true }).click();
    await page.waitForFunction(() => window.__omniHostState?.cloudStatus === "live" && window.__omniHostState?.imageStatus === "live");
    await frame.waitForFunction(() => document.querySelector(".capture-camera-pane img")?.naturalWidth > 0 && document.querySelector("canvas")?.width > 0);
    const before = await page.evaluate(() => Object.fromEntries(Object.entries(window.__omniReceived).map(([key, stamps]) => [key, stamps.length])));
    await page.waitForFunction(start => window.__omniReceived.cloud.length >= start.cloud + 2 && window.__omniReceived.image.length >= start.image + 2 && window.__omniReceived.sync.length >= start.sync + 1, before);
    const sample = await page.evaluate(() => ({ state: window.__omniHostState, received: Object.fromEntries(Object.entries(window.__omniReceived).map(([key, stamps]) => [key, stamps.slice(-20)])) }));
    const image = await frame.locator(".capture-camera-pane img").evaluate(element => ({ width: element.naturalWidth, height: element.naturalHeight, alt: element.alt }));
    assert.doesNotMatch(await app.locator("body").innerText(), /WebSocket|schema|topic|点云接收|当前帧|诊断|unknown|消息解析|Worker/);
    report.samples.push({ camera, ...sample, image });
    await app.locator(".live-capture").screenshot({ path: join(output, `${camera}.png`) });
    report.checks.push(`${camera} 相机图像解码、点云绘制、连续接收及同步状态`);
    console.log(JSON.stringify({ stage: camera, points: sample.state.pointCount, image, sync: sample.state.sync }));
  }
  await app.getByRole("button", { name: "返回设备", exact: true }).click();
  await app.getByRole("button", { name: "设置", exact: true }).click();
  await app.getByRole("button", { name: "断开预览", exact: true }).click();
  await page.waitForFunction(() => window.__omniHostState?.connection === "offline");
  await app.getByRole("button", { name: "保存并连接", exact: true }).click();
  await page.waitForFunction(hasCamera => window.__omniHostState?.cloudStatus === "live" && (!hasCamera || window.__omniHostState?.imageStatus === "live"), availableCameras.length > 0);
  report.checks.push("App 主动断开后重新连接真机并恢复收帧");
  await app.getByRole("button", { name: "断开预览", exact: true }).click();
  assert.deepEqual(report.browserErrors, []);
  assert([...operations].every(operation => ["subscribe", "unsubscribe"].includes(operation)));
  report.result = report.missing.length ? "PARTIAL" : "PASS";
  if (report.missing.length) process.exitCode = 2;
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack || String(error);
  report.lastState = await page?.evaluate(() => window.__omniHostState).catch(() => null);
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.clientOperations = [...operations];
  report.subscriptions = [...new Set(report.subscriptions)];
  await browser?.close();
  await vite?.close();
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, checks: report.checks, missing: report.missing, browserErrors: report.browserErrors, subscriptions: report.subscriptions, error: report.error, lastState: report.lastState, output }, null, 2));
}
