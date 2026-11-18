import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import playwrightUtilities from "playwright-core/lib/utilsBundle";
const require = createRequire(import.meta.url);
const { FoxgloveServer } = require("@foxglove/ws-protocol");
const { parse } = require("@foxglove/rosmsg");
const { MessageWriter } = require("@foxglove/rosmsg2-serialization");

// 全部成功链路使用本机独立协议夹具；唯一真机请求只订阅现有预览，绝不启停设备。
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "artifacts/omni-app/real-preview-check");
await mkdir(output, { recursive: true });
const report = { checks: [], browserErrors: [], clientOperations: [], hostObservation: null };
// 复用当前锁定 Playwright 包已导出的服务实现，避免为一次验证另装 ws。
const WebSocketServer = playwrightUtilities.wsServer;
const protocol = new FoxgloveServer({ name: "OMNI local validation fixture", capabilities: [] });
const websocket = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: value => protocol.handleProtocols(value) });
await once(websocket, "listening");
const endpoint = `ws://127.0.0.1:${websocket.address().port}`;
const active = new Set();
const operations = new Set();
let sending = true;
protocol.on("subscribe", id => active.add(id));
protocol.on("unsubscribe", id => active.delete(id));
protocol.on("error", error => report.browserErrors.push(`fixture: ${error.message}`));
websocket.on("connection", socket => {
  socket.on("message", (data, binary) => {
    operations.add(binary ? "binary" : JSON.parse(data.toString()).op);
  });
  protocol.handleConnection(socket, "browser validation");
});
const dependencies = `
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
`;
const cloudSchema = `std_msgs/Header header
uint32 height
uint32 width
sensor_msgs/PointField[] fields
bool is_bigendian
uint32 point_step
uint32 row_step
uint8[] data
bool is_dense
${dependencies}
================================================================================
MSG: sensor_msgs/PointField
string name
uint32 offset
uint8 datatype
uint32 count
`;
const imageSchema = `std_msgs/Header header\nstring format\nuint8[] data\n${dependencies}`;
const channels = [];
const add = (topic, schemaName, schema, message) => {
  const id = protocol.addChannel({ topic, encoding: "cdr", schemaName, schemaEncoding: "ros2msg", schema });
  channels.push({ id, writer: new MessageWriter(parse(schema, { ros2: true })), message });
};
const data = Buffer.alloc(576 * 16);
for (let i = 0; i < 576; i++) {
  data.writeFloatLE((i % 24) / 4, i * 16);
  data.writeFloatLE(Math.floor(i / 24) / 4, i * 16 + 4);
  data.writeFloatLE(Math.sin(i / 24) * 0.6, i * 16 + 8);
  data.writeUInt32LE(0x0062a8dc, i * 16 + 12);
}
const header = { stamp: { sec: 123, nanosec: 456 }, frame_id: "camera_init" };
add("/cloud_registered/tri_precise", "sensor_msgs/msg/PointCloud2", cloudSchema, {
  header, height: 1, width: 576, is_bigendian: false, point_step: 16, row_step: data.length, data, is_dense: true,
  fields: ["x", "y", "z", "rgb"].map((name, index) => ({ name, offset: index * 4, datatype: 7, count: 1 })),
});
const png = await readFile(join(root, "build/icon-512x512.png"));
for (const camera of ["front", "left", "right"]) {
  add(`/omni/camera/${camera}/image/compressed`, "sensor_msgs/msg/CompressedImage", imageSchema, { header, format: "png", data: png });
}
add("/omni/sync/status", "std_msgs/msg/String", "string data", { data: "locked" });
const interval = setInterval(() => {
  if (!sending) return;
  for (const { id, writer, message } of channels) {
    if (active.has(id)) protocol.sendMessage(id, BigInt(Date.now()) * 1_000_000n, writer.writeMessage(message));
  }
}, 200);
let vite, browser, page;
try {
  vite = await createServer({ configFile: join(root, "vite.omni.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: true, open: false } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: join(root, ".tools/playwright/chromium-1234/chrome-linux64/chrome"), headless: true, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => report.browserErrors.push(error.message));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.addEventListener("message", event => {
      if (event.origin === location.origin && event.data?.type === "omni-app:state") window.__omniTestState = event.data;
    });
  });
  await page.goto(`${origin}/lab.html?mode=live`);
  const app = page.frameLocator("iframe");
  await app.getByRole("heading", { name: /扫描工作台|我的 OMNI/ }).waitFor();
  assert.equal(await app.locator(".omni-demo-marker").count(), 0);
  await page.getByText("开发连接配置", { exact: true }).click();
  await page.getByLabel("WebSocket", { exact: true }).fill(endpoint);
  await page.getByRole("button", { name: "应用并连接", exact: true }).click();
  await page.waitForFunction(() => window.__omniTestState?.pointCount === 576 && window.__omniTestState?.imageStatus === "live");
  report.checks.push("Foxglove CDR point cloud + compressed image + sync received through real adapter");
  await app.getByRole("button", { name: /开始扫描|进入实时预览/ }).click();
  await app.locator("canvas").waitFor();
  const frame = page.frames().find(item => item.url().includes("/index.html"));
  await frame.waitForFunction(() => document.querySelector(".capture-camera-pane img")?.naturalWidth > 0);
  const assertCleanUi = async () => assert.doesNotMatch(await app.locator("body").innerText(), /WebSocket|schema|topic|点云接收|当前帧|诊断|unknown|消息解析|Worker/);
  await assertCleanUi();
  report.checks.push("App contains no protocol fields, debug counters or raw errors");
  const originalCanvas = await app.locator("canvas").elementHandle();
  await page.getByRole("button", { name: "旋转屏幕", exact: true }).click();
  await frame.waitForFunction(() => innerWidth > innerHeight);
  assert.equal(await originalCanvas.evaluate(element => element === document.querySelector("canvas")), true);
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await app.getByRole("button", { name: "切换主画面", exact: true }).click();
  assert.equal(await originalCanvas.evaluate(element => element === document.querySelector("canvas")), true);
  report.checks.push("Rotation and main-view swap preserve the WebGL canvas");
  await app.getByRole("button", { name: "切换相机", exact: true }).click();
  await page.waitForFunction(() => window.__omniTestState?.channels?.length === 5 && window.__omniTestState?.imageStatus === "live");
  await frame.waitForFunction(() => document.querySelector(".capture-camera-pane img")?.alt.includes("左相机"));
  report.checks.push("Camera switch resubscribes to left camera and receives a new image");
  sending = false;
  await page.waitForFunction(() => window.__omniTestState?.cloudStatus === "stale" && window.__omniTestState?.imageStatus === "stale");
  await assertCleanUi();
  report.checks.push("Open socket with stalled messages shows stale point cloud and image");
  websocket.clients.forEach(socket => socket.close());
  await page.waitForFunction(() => window.__omniTestState?.connection === "error");
  await app.getByText("请确认已连接 OMNI 网络，且设备预览已开启", { exact: true }).waitFor();
  await assertCleanUi();
  sending = true;
  await app.getByRole("button", { name: "连接预览", exact: true }).click();
  await page.waitForFunction(() => window.__omniTestState?.connection === "connected" && window.__omniTestState?.cloudStatus === "live");
  report.checks.push("Socket closure displays a friendly error; explicit reconnect restores live frames");
  await page.screenshot({ path: join(output, "live-preview-lab.png") });
  await app.getByRole("button", { name: /返回设备|返回扫描工作台/ }).click();
  await app.getByRole("button", { name: /设置|演示设置/ }).click();
  await app.getByRole("button", { name: "断开预览", exact: true }).click();
  await assertCleanUi();
  // 已存在的 OMNI 服务可能由并行研发启动；只记录观察，不假设它必须在线或离线。
  await app.getByLabel("设备连接地址", { exact: true }).fill("ws://10.42.0.1:8765");
  await app.getByRole("button", { name: "保存并连接", exact: true }).click();
  await page.waitForFunction(() => ["error", "connected"].includes(window.__omniTestState?.connection), undefined, { timeout: 10000 });
  report.hostObservation = await page.evaluate(() => ({ connection: window.__omniTestState.connection, cloudStatus: window.__omniTestState.cloudStatus, imageStatus: window.__omniTestState.imageStatus, detail: window.__omniTestState.detail }));
  await assertCleanUi();
  await app.getByRole("button", { name: "断开预览", exact: true }).click();
  await page.getByRole("combobox", { name: /数据来源/ }).selectOption("demo");
  await app.getByText("模拟数据", { exact: true }).waitFor();
  await app.getByRole("heading", { name: "扫描工作台" }).waitFor();
  report.checks.push("Explicit demo mode remains isolated and visibly marked");
  assert.deepEqual(report.browserErrors, []);
  assert([...operations].every(operation => ["subscribe", "unsubscribe"].includes(operation)));
  report.clientOperations = [...operations];
  report.result = "PASS";
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack || String(error);
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearInterval(interval);
  await browser?.close();
  websocket.clients.forEach(socket => socket.terminate());
  await new Promise(resolve => websocket.close(resolve));
  await vite?.close();
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
