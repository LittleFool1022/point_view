const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { SourceStore } = require("./source-store.cjs");
const { installCloseGuard } = require("./close-guard.cjs");
const { listDeviceProjects, receiveDeviceProject } = require("./device-receiver.cjs");
const {renderSheetPdf}=require("./pdf.cjs");
const store = new SourceStore();
let operation;
let window;
// 独立应用数据目录与 IPC；不加载旧制作台或任何 Python 重建依赖。
app.setName("Point View Survey Studio");
function assertOwner(event) {
  if (!window || event.sender.id !== window.webContents.id) throw new Error("无效的应用窗口");
}
ipcMain.handle("survey:device-projects", async (event, origin) => {
  assertOwner(event);
  if (operation) throw Error("请先完成或取消当前任务。");
  operation = new AbortController();
  try { return await listDeviceProjects(origin, { signal: operation.signal }); }
  finally { operation = undefined; }
});
ipcMain.handle("survey:device-receive", async (event, origin, session) => {
  assertOwner(event);
  if (operation) throw Error("请先完成或取消当前任务。");
  operation = new AbortController();
  try {
    return await receiveDeviceProject(origin, session, { directory: path.join(app.getPath("userData"), "received"), store,
      signal: operation.signal, progress: (done, total) => event.sender.send("survey:progress", `接收完整点云 ${Math.floor(done / total * 100)}%`) });
  } finally { operation = undefined; }
});
ipcMain.handle("survey:keyframe-page", async (event, token, id) => { assertOwner(event); return store.readPage(token, id); });
ipcMain.handle("survey:update-keyframe-page", async (event, token, id, review) => { assertOwner(event); return store.updatePage(token, id, review); });
ipcMain.handle("survey:add-keyframe-page", async (event, token, review) => { assertOwner(event); return store.addPage(token, review); });
ipcMain.handle("survey:keyframe-index", async (event, token) => { assertOwner(event); return store.reviewIndex(token); });
ipcMain.handle("survey:semantic-assets", async event => {
  assertOwner(event);
  const root=path.join(__dirname,"../dist/ai-evaluation");
  const load=async name=>{const data=await fs.readFile(path.join(root,name));return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);};
  const runtimeName=(await fs.readdir(path.join(__dirname,"../dist/assets"))).find(name=>/^ort-wasm-simd-threaded-[A-Za-z0-9_-]+\.wasm$/.test(name));
  if(!runtimeName)throw Error("本地识别运行库缺失。");
  const runtime=await fs.readFile(path.join(__dirname,"../dist/assets",runtimeName));
  const [model,metadata]=await Promise.all([load("segformer-b0-ade.onnx"),fs.readFile(path.join(root,"engine.json"),"utf8").then(JSON.parse)]);
  return {model,wasm:runtime.buffer.slice(runtime.byteOffset,runtime.byteOffset+runtime.byteLength),metadata};
});
ipcMain.handle("survey:open", async (event, kind) => {
  assertOwner(event);
  const extensions = kind === "project" ? ["pvplan"] : kind === "frames" ? ["pvframes"] : ["pcd", "ply", "las", "laz"];
  const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: kind === "project" ? "测量工程" : "测量点云", extensions }] });
  if (result.canceled || !result.filePaths[0]) return undefined;
  const file = result.filePaths[0];
  if (operation) throw Error("请先完成或取消当前文件任务。");
  operation = new AbortController();
  const progress = (done, total) => event.sender.send("survey:progress", `校验源文件 ${Math.floor(done / total * 100)}%`);
  try {
    if (kind === "frames") {
      if ((await fs.stat(file)).size > 16 * 1024 ** 2) throw Error("关键帧附件超过 16 MiB，请按会话拆分。");
      const data = await fs.readFile(file);
      return { name: path.basename(file), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }
    if (kind === "project") {
      const native = await store.openProject(file, { signal: operation.signal, progress });
      if (native) return native;
      if ((await fs.stat(file)).size > 256 * 1024 * 1024) throw Error("旧版 ZIP 工程超过兼容容量，请使用原始点云重新建立流式工程。");
      const data = await fs.readFile(file);
      return { name: path.basename(file), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }
    return { name: path.basename(file), native: await store.register(file, { signal: operation.signal, progress }) };
  } finally { operation = undefined; }
});
ipcMain.handle("survey:read", (event, token, offset, size) => { assertOwner(event); return store.read(token, offset, size); });
ipcMain.handle("survey:release", (event, token) => { assertOwner(event); return store.release(token); });
ipcMain.handle("survey:cancel", event => { assertOwner(event); operation?.abort(); });
ipcMain.handle("survey:save-project", async (event, token, state) => {
  assertOwner(event);
  if (operation) throw Error("请先完成或取消当前文件任务。");
  const result = await dialog.showSaveDialog(window, { defaultPath: "测量工程.pvplan", filters: [{ name: "测量工程", extensions: ["pvplan"] }] });
  if (result.canceled || !result.filePath) return { saved: false };
  operation = new AbortController();
  try { return await store.saveProject(token, result.filePath, state, { signal: operation.signal, progress: (done, total) => event.sender.send("survey:progress", `保存原始点云 ${Math.floor(done / total * 100)}%`) }); }
  finally { operation = undefined; }
});
ipcMain.handle("survey:render-pdf",async(event,document)=>{
  assertOwner(event);
  if(operation)throw Error("请先完成或取消当前任务。");
  operation=new AbortController();
  try {const bytes=await renderSheetPdf(document);if(operation.signal.aborted)throw Error("已取消 PDF 生成。");return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}
  finally{operation=undefined;}
});
ipcMain.handle("survey:save", async (event, name, data) => {
  assertOwner(event);
  if (typeof name !== "string" || name !== path.basename(name) || /[\\/:*?"<>|]/.test(name) || !(data instanceof ArrayBuffer)) throw new Error("无效的保存请求");
  const result = await dialog.showSaveDialog(window, { defaultPath: name });
  if (result.canceled || !result.filePath) return false;
  await fs.writeFile(result.filePath, Buffer.from(data));
  return true;
});
function createWindow() {
  window = new BrowserWindow({ width: 1600, height: 1000, minWidth: 1100, minHeight: 720, backgroundColor: "#f4f5f6", title: "观曜 · 测量成果工作台", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  installCloseGuard(window, dialog, () => operation?.abort());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.loadFile(path.join(__dirname, "../dist/index.html"));
}
app.whenReady().then(() => { createWindow(); app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on("window-all-closed", () => { operation?.abort(); void store.close().finally(() => app.quit()); });
