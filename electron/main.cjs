const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
require("./object-studio/runtime.cjs").registerObjectStudio({ ipcMain, app });

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#181714",
    icon: path.join(__dirname, "..", "build", "icon-512x512.png"),
    title: "Point View",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

ipcMain.handle("point-view:open", async (_event, filters) => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
  if (result.canceled || result.filePaths.length === 0) return undefined;
  const filePath = result.filePaths[0];
  const data = await fs.readFile(filePath);
  return { name: path.basename(filePath), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});

ipcMain.handle("point-view:save", async (_event, name, data) => {
  const result = await dialog.showSaveDialog({ defaultPath: name });
  if (result.canceled || !result.filePath) return false;
  await fs.writeFile(result.filePath, Buffer.from(data));
  return true;
});

async function readDirectoryFiles(root, current = root) {
  const output = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await readDirectoryFiles(root, absolute));
    else if (/\.(txt|bin|png|jpe?g)$/i.test(entry.name)) {
      const data = await fs.readFile(absolute);
      output.push({ relativePath: path.relative(root, absolute).split(path.sep).join("/"), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
    }
  }
  return output;
}

ipcMain.handle("point-view:open-colmap", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "选择 FAST-LIVO2 Log/Colmap 目录" });
  if (result.canceled || result.filePaths.length === 0) return undefined;
  return readDirectoryFiles(result.filePaths[0]);
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
