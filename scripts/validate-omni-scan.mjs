import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { preview } from "vite";
import utilities from "playwright-core/lib/utilsBundle";

// 本地夹具验证真实 App 数据/渲染路径；所有控制 HTTP 请求均拦截，不访问真实采集动作。
const require = createRequire(import.meta.url);
const { FoxgloveServer } = require("@foxglove/ws-protocol");
const { parse } = require("@foxglove/rosmsg");
const { MessageWriter } = require("@foxglove/rosmsg2-serialization");
const native = process.argv.includes("--native"), snapshotOnly = process.argv.includes("--snapshot");
const baseline = process.argv.includes("--baseline");
const noImages = process.argv.includes("--no-images"), perfOnly = process.argv.includes("--perf-only");
const staticCloud = process.argv.includes("--static-cloud");
const output = new URL("../artifacts/omni-app/scan-coverage-20261021/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { result: "PARTIAL", native, baseline, checks: [], errors: [], actions: [], frames: [] };
let browser, vite, ws, relay, websocket, interval, send, evaluate, originalConfig;
const sockets = new Set();
const run = promisify(execFile);
const screenshot = async name => {
  const bytes = native
    ? (await run("sudo", ["-n", "waydroid", "shell", "--", "screencap", "-p"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })).stdout
    : Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
  await writeFile(new URL(name, output), bytes);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeSession = "fixture-A", sending = true, region = 0, sequence = 0;
try {
  if (native) {
    relay = net.createServer(socket => {
      const target = net.connect(process.env.OMNI_CDP_SOCKET || "/tmp/omni-coverage-cdp.sock");
      sockets.add(socket); sockets.add(target); socket.pipe(target); target.pipe(socket);
      socket.on("error", () => target.destroy()); target.on("error", () => socket.destroy());
    });
    await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve));
    const port = relay.address().port;
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = pages.find(page => page.url.includes("tauri.localhost"));
    assert.ok(target, "OMNI Scan WebView missing");
    ws = new WebSocket(target.webSocketDebuggerUrl.replace("ws://localhost/", `ws://127.0.0.1:${port}/`));
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let serial = 0;
    const pending = new Map();
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data), callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id); clearTimeout(callback.timer);
        message.error ? callback.reject(Error(JSON.stringify(message.error))) : callback.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") report.errors.push(message.params.exceptionDetails.text);
      else if (message.method === "Fetch.requestPaused") void handleRequest(message.params).catch(requestError);
    };
  } else {
    vite = await preview({ configFile: "vite.omni.config.ts", mode: "android", preview: { host: "127.0.0.1", port: 0, open: false } });
    browser = await chromium.launch({ executablePath: ".tools/playwright/chromium-1234/chrome-linux64/chrome", headless: true,
      args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const cdp = await page.context().newCDPSession(page);
    send = (method, params = {}) => cdp.send(method, params);
    cdp.on("Runtime.exceptionThrown", params => report.errors.push(params.exceptionDetails.text));
    cdp.on("Fetch.requestPaused", params => void handleRequest(params).catch(requestError));
  }
  evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(100); }
    throw Error(`UI timeout: ${expression}`);
  };
  async function handleRequest({ requestId, request }) {
    if (request.method === "POST") report.actions.push(request.url);
    const body = request.url.endsWith("/projects") ? { projects: [] }
      : { reachable: true, state: "running", session: activeSession, components: { mapping: true, camera: true, livox: true },
        previewReady: true, actionsAllowed: false, job: null, storageFreeBytes: 9200000000, accumulatedPoints: 120000 };
    await send("Fetch.fulfillRequest", { requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }],
      body: Buffer.from(JSON.stringify(body)).toString("base64") });
  }
  function requestError(error) {
    // reload 会取消上一页尚未完成的拦截请求，其 ID 随导航失效。
    if (!String(error).includes("Invalid InterceptionId")) report.errors.push(String(error));
  }
  await send("Runtime.enable"); await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/v1/*" }] });
  if (snapshotOnly) {
    const preserved = await evaluate(`(async()=>{const config=localStorage.getItem('omni-preview-connection-v1');const records=localStorage.getItem('point-view-live-records-v1');const profile=localStorage.getItem('omni-scan-profile-v1');return {config,records,profile};})()`);
    await writeFile(new URL("native-before.json", output), JSON.stringify(preserved, null, 2));
    report.checks.push("existing App configuration and project record snapshot saved");
    report.result = "PASS";
  } else {
    const protocol = new FoxgloveServer({ name: "OMNI cumulative scan fixture", capabilities: [] });
    websocket = new utilities.wsServer({ host: "0.0.0.0", port: 0, handleProtocols: value => protocol.handleProtocols(value) });
    await once(websocket, "listening");
    const endpoint = `ws://${native ? "192.168.240.1" : "127.0.0.1"}:${websocket.address().port}`;
    const subscribed = new Set();
    protocol.on("subscribe", id => subscribed.add(id)); protocol.on("unsubscribe", id => subscribed.delete(id));
    protocol.on("error", error => report.errors.push(`fixture: ${error.message}`));
    websocket.on("connection", socket => protocol.handleConnection(socket, "scan validation"));
    const deps = `\n================================================================================\nMSG: std_msgs/Header\nbuiltin_interfaces/Time stamp\nstring frame_id\n================================================================================\nMSG: builtin_interfaces/Time\nint32 sec\nuint32 nanosec\n`;
    const schema = `std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense\n${deps}\n================================================================================\nMSG: sensor_msgs/PointField\nstring name\nuint32 offset\nuint8 datatype\nuint32 count\n`;
    const writer = new MessageWriter(parse(schema, { ros2: true }));
    const cloudId = protocol.addChannel({ topic: "/cloud_registered/tri_precise", encoding: "cdr", schemaName: "sensor_msgs/msg/PointCloud2", schemaEncoding: "ros2msg", schema });
    const imageSchema = `std_msgs/Header header\nstring format\nuint8[] data\n${deps}`;
    const imageWriter = new MessageWriter(parse(imageSchema, { ros2: true }));
    const imageIds = ["front", "left"].map(camera => protocol.addChannel({ topic: `/omni/camera/${camera}/image/compressed`, encoding: "cdr", schemaName: "sensor_msgs/msg/CompressedImage", schemaEncoding: "ros2msg", schema: imageSchema }));
    const image = await readFile(new URL("../build/icon-512x512.png", import.meta.url));
    const datasets = [0, 20, 40].map(x0 => {
      const data = Buffer.alloc(60_000 * 16);
      for (let i = 0; i < 60_000; i++) {
        data.writeFloatLE(x0 + i % 100 * 0.1, i * 16);
        data.writeFloatLE(Math.floor(i / 100) % 100 * 0.1, i * 16 + 4);
        data.writeFloatLE(Math.floor(i / 10000) * 0.1, i * 16 + 8);
        data.writeUInt32LE(0x0062a8dc, i * 16 + 12);
      }
      return data;
    });
    interval = setInterval(() => {
      if (!sending) return;
      const header = { stamp: { sec: ++sequence, nanosec: 0 }, frame_id: "camera_init" };
      if (subscribed.has(cloudId)) protocol.sendMessage(cloudId, BigInt(Date.now()) * 1000000n, writer.writeMessage({ header, height: 1, width: 60000,
        fields: ["x", "y", "z", "rgb"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 })),
        is_bigendian: false, point_step: 16, row_step: datasets[region].length, data: datasets[region], is_dense: true }));
      if (!noImages) for (const id of imageIds) if (subscribed.has(id)) protocol.sendMessage(id, BigInt(Date.now()) * 1000000n, imageWriter.writeMessage({ header, format: "png", data: image }));
    }, 100);
    console.log("fixture ready");
    if (native) {
      await wait(`!!document.querySelector('.live-omni')`);
      originalConfig = await evaluate(`localStorage.getItem('omni-preview-connection-v1')`);
      const before = JSON.parse(await readFile(new URL("native-before.json", output), "utf8"));
      assert.equal(await evaluate(`localStorage.getItem('point-view-live-records-v1')`), before.records);
      assert.equal(await evaluate(`localStorage.getItem('omni-scan-profile-v1')`), before.profile);
      report.checks.push("APK update preserved project records and scan profile");
      await evaluate(`localStorage.setItem('omni-preview-connection-v1',${JSON.stringify(JSON.stringify({ wsUrl: endpoint, pointCloudTopic: "/cloud_registered/tri_precise" }))})`);
      await send("Page.navigate", { url: "http://tauri.localhost/index.html#/capture" });
      await send("Page.reload", { ignoreCache: true });
    } else {
      const origin = vite.resolvedUrls.local[0];
      await send("Page.navigate", { url: `${origin}index.html#/capture` });
      await wait(`!!document.querySelector('.live-omni')`);
      await evaluate(`localStorage.setItem('omni-preview-connection-v1',${JSON.stringify(JSON.stringify({ wsUrl: endpoint, pointCloudTopic: "/cloud_registered/tri_precise" }))});location.reload()`);
    }
    await wait(baseline ? `!!document.querySelector('.capture-camera-pane img')` : `Number(document.querySelector('.point-cloud-canvas')?.dataset.scanPoints)>0`);
    console.log("first cloud ready");
    const cloudState = () => evaluate(`({...document.querySelector('.point-cloud-canvas').dataset})`);
    await sleep(600);
    report.regionA = await cloudState();
    await screenshot(`${native ? "native" : "browser"}-region-A.png`);
    region = 1;
    if (!baseline) {
      await wait(`Number(document.querySelector('.point-cloud-canvas')?.dataset.scanCenter?.split(',')[0])>10`);
      report.regionAB = await cloudState();
      assert(Number(report.regionAB.scanRadius) > Number(report.regionA.scanRadius));
      assert(Number(report.regionAB.scanCenter.split(",")[0]) < 20);
      assert(Number(report.regionAB.scanPoints) <= 100000);
      report.checks.push("A remains visible after B arrives; cumulative bounds span both regions and point budget holds");
    }
    console.log("regions ready");
    await evaluate(`document.querySelector('[aria-label="扫描视角复位"]').click()`);
    await sleep(500);
    await screenshot(`${native ? "native" : "browser"}-region-AB.png`);
    if (staticCloud) { sending = false; await sleep(500); }
    await send("Profiler.enable"); await send("Profiler.start");
    // CDP touch 事件经真实 WebView/OrbitControls，帧时间由渲染线程 rAF 采集。
    const canvasBox = await evaluate(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width*.45,y:r.y+r.height*.48};})()`);
    await evaluate(`window.__scanFrames=[];window.__scanLongTasks=[];window.__scanPointers=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.querySelector('canvas').addEventListener(type,e=>window.__scanPointers.push({type,id:e.pointerId,at:performance.now()}),{passive:true});window.__scanMeasuring=true;new PerformanceObserver(l=>{for(const e of l.getEntries())window.__scanLongTasks.push({at:e.startTime,duration:e.duration})}).observe({entryTypes:['longtask']});let last=performance.now();function frame(t){if(!window.__scanMeasuring)return;window.__scanFrames.push(t-last);last=t;requestAnimationFrame(frame)}requestAnimationFrame(frame)`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...canvasBox, id: 0, radiusX: 1, radiusY: 1 }] });
    report.gestureDispatch = [];
    for (let i = 0; i < 45; i++) {
      const started = Date.now();
      await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: canvasBox.x + Math.sin(i / 12) * 80, y: canvasBox.y + Math.cos(i / 12) * 40, id: 0, radiusX: 1, radiusY: 1 }] });
      report.gestureDispatch.push({ index: i, started, elapsedMs: Date.now() - started });
      await sleep(20);
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    console.log("rotation finished");
    const profile = await send("Profiler.stop");
    await writeFile(new URL(`${native ? "native" : "browser"}-cpu-profile.json`, output), JSON.stringify(profile.profile));
    await evaluate(`window.__scanMeasuring=false`);
    report.performance = await evaluate(`(()=>{const a=window.__scanFrames.slice(3).sort((a,b)=>a-b);return {samples:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1),longTasks:window.__scanLongTasks,pointerEvents:window.__scanPointers,heapBytes:performance.memory?.usedJSHeapSize};})()`);
    assert(report.performance.samples > 20);
    report.checks.push("continuous incoming cloud plus touch rotation measured in actual renderer");
    if (!baseline && !perfOnly) {
      // 双指同向移动和平移后拉开，分别经过 OrbitControls 的平移和缩放路径。
      for (const gesture of ["pan", "pinch"]) {
        const start = [{ x: canvasBox.x - 35, y: canvasBox.y, id: 0 }, { x: canvasBox.x + 35, y: canvasBox.y, id: 1 }];
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: start });
        for (let i = 1; i <= 12; i++) {
          const delta = i * 2;
          await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: start.map((point, index) => ({ ...point,
            x: point.x + (gesture === "pan" ? delta : index === 0 ? -delta : delta) })) });
          await sleep(20);
        }
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      report.checks.push("two-finger pan and pinch touch paths executed while cloud updates continue");
      const token = (await cloudState()).scanToken;
      await evaluate(`document.querySelector('[aria-label="切换相机"]').click()`);
      await sleep(1800);
      assert.equal((await cloudState()).scanToken, token);
      report.checks.push("camera reconnect retains cumulative identity and history");
      await evaluate(`document.querySelector('.preview-pause-button').click()`);
      const paused = await cloudState();
      await sleep(300);
      await evaluate(`document.querySelector('.preview-pause-button').click()`);
      await sleep(1800);
      assert.equal((await cloudState()).scanToken, token);
      assert(Number((await cloudState()).scanRadius) >= Number(paused.scanRadius));
      report.checks.push("pause/resume retains previously received area");
      if (native) {
        await run("sudo", ["-n", "waydroid", "shell", "--", "input", "keyevent", "KEYCODE_HOME"]);
        await wait(`document.hidden===true`);
        await sleep(300);
        await run("sudo", ["-n", "waydroid", "shell", "--", "am", "start", "-W", "-n", "com.guanyao.omniscan.waydroid/.MainActivity"]);
        await wait(`document.hidden===false`);
      } else {
        await send("Page.setWebLifecycleState", { state: "frozen" });
        await sleep(300);
        await send("Page.setWebLifecycleState", { state: "active" });
      }
      await sleep(1200);
      assert.equal((await cloudState()).scanToken, token);
      report.checks.push(native ? "actual Android Home/background and App resume preserve accumulated history" : "page freeze/resume preserves accumulated scan identity");
      activeSession = "fixture-B"; region = 2;
      await wait(`document.querySelector('.point-cloud-canvas')?.dataset.scanToken!==${JSON.stringify(token)}&&Number(document.querySelector('.point-cloud-canvas')?.dataset.scanCenter?.split(',')[0])>40`, 15000);
      report.regionNewSession = await cloudState();
      assert(Number(report.regionNewSession.scanRadius) < Number(report.regionAB.scanRadius));
      report.checks.push("confirmed new scan starts empty even with identical camera_init frame name");
      await evaluate(`document.querySelector('[aria-label="扫描视角复位"]').click()`);
      await sleep(400);
      report.stability = [];
      for (let i = 0; i < 4; i++) {
        await sleep(2000);
        report.stability.push({ points: Number((await cloudState()).scanPoints), heap: await send("Runtime.getHeapUsage") });
      }
      assert(report.stability.every(sample => sample.points > 0 && sample.points <= 100000));
      report.checks.push("continued 60k-point/10Hz input remains within display budget after session switch");
    }
    await screenshot(`${native ? "native" : "browser"}${baseline ? "-baseline" : ""}${noImages ? "-no-images" : ""}.png`);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.actions, []);
    report.functionalResult = "PASS";
    report.performanceTargetMs = 33;
    report.performanceTargetMet = report.performance.p95 <= report.performanceTargetMs;
    report.result = baseline ? "BASELINE_RECORDED" : report.performanceTargetMet ? "PASS" : "PARTIAL";
    if (report.result === "PARTIAL") process.exitCode = 2;
  }
} catch (error) {
  report.error = error.stack || String(error); report.result = "FAIL"; process.exitCode = 1;
  if (send) try {
    report.ui = await evaluate(`document.body.innerText.slice(0,1500)`);
    await screenshot(`${native ? "native" : "browser"}-failure.png`);
  } catch {}
} finally {
  if (originalConfig !== undefined && evaluate) {
    try {
      await evaluate(originalConfig === null ? `localStorage.removeItem('omni-preview-connection-v1')` : `localStorage.setItem('omni-preview-connection-v1',${JSON.stringify(originalConfig)})`);
      // 保留已安装 App；退出本轮预览后不刷新，不主动连回真实设备。
      await evaluate(`location.hash='/scan'`);
    } catch {}
  }
  clearInterval(interval);
  await browser?.close(); ws?.close();
  for (const socket of sockets) socket.destroy(); relay?.close();
  if (websocket) { websocket.clients.forEach(socket => socket.terminate()); await new Promise(resolve => websocket.close(resolve)); }
  await vite?.close();
  await writeFile(new URL(`${snapshotOnly ? "snapshot" : native ? "native" : "browser"}${baseline ? "-baseline" : ""}${noImages ? "-no-images" : ""}${staticCloud ? "-static" : ""}-result.json`, output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
