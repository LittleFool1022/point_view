const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

function registerObjectStudio({ ipcMain, app }) {
  const tasks = new Map();
  const python = process.env.POINT_VIEW_OBJECT_PYTHON || path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), ".tools", "object-runtime", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  ipcMain.handle("point-view:object-capability", async () => {
    try { await fs.access(python); return { available: true }; }
    catch { return { available: false, reason: "本机尚未配置表面生成组件。可先选取、收藏和导出原始物体；按项目说明配置本地运行时后即可生成表面。" }; }
  });
  ipcMain.handle("point-view:object-cancel", (event) => {
    const task = tasks.get(event.sender.id);
    if (task) { task.cancelled = true; task.child?.kill("SIGKILL"); }
  });
  ipcMain.handle("point-view:object-reconstruct", async (event, input) => {
    const owner = event.sender.id;
    if (tasks.has(owner)) throw new Error("请先等待或取消当前表面生成任务。");
    if (!(input?.positions instanceof ArrayBuffer) || !(input?.colors instanceof ArrayBuffer)
      || input.positions.byteLength % 12 || input.positions.byteLength < 360
      || input.positions.byteLength > 2_000_000 * 12 || input.colors.byteLength !== input.positions.byteLength / 4
      || !["bpa", "poisson"].includes(input.method) || !["preview", "fine"].includes(input.detail)) {
      throw new Error("物体数据无效，或超过单物体 200 万点限制。请缩小选区。");
    }
    const task = { child: undefined, cancelled: false };
    tasks.set(owner, task);
    let folder;
    const cancel = () => { task.cancelled = true; task.child?.kill("SIGKILL"); };
    event.sender.once("destroyed", cancel);
    try {
      await fs.access(python);
      folder = await fs.mkdtemp(path.join(os.tmpdir(), "point-view-object-"));
      await fs.writeFile(path.join(folder, "input.positions"), Buffer.from(input.positions));
      await fs.writeFile(path.join(folder, "input.colors"), Buffer.from(input.colors));
      if (task.cancelled) throw new Error("已取消生成，原始物体仍然保留。");
      await new Promise((resolve, reject) => {
        let message = "", pending = "", stderr = "";
        const script = app.isPackaged
          ? path.join(process.resourcesPath, "app.asar.unpacked", "electron", "object-studio", "reconstruct.py")
          : path.join(__dirname, "reconstruct.py");
        // 管道中的中文进度统一为 UTF-8，避免 Windows 系统代码页导致乱码或编码异常。
        const child = spawn(python, ["-I", "-X", "utf8", script, folder, input.method, input.detail], {
          stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
          env: { ...process.env, OMP_NUM_THREADS: "4", OPENBLAS_NUM_THREADS: "4" },
        });
        task.child = child;
        const timer = setTimeout(() => { message = "生成时间超过 180 秒，请缩小选区或使用快速预览。"; child.kill("SIGKILL"); }, 180000);
        child.stdout.on("data", chunk => {
          pending += chunk.toString();
          const lines = pending.split("\n"); pending = lines.pop();
          for (const line of lines) {
            try {
              const value = JSON.parse(line);
              if (value.error) message = value.error;
              if (value.stage && !event.sender.isDestroyed()) event.sender.send("point-view:object-progress", String(value.stage));
            } catch { /* Open3D 的诊断输出不作为进度展示。 */ }
          }
        });
        child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", code => {
          clearTimeout(timer);
          if (task.cancelled) reject(new Error("已取消生成，原始物体仍然保留。"));
          else if (code !== 0) reject(new Error(message || `表面生成失败：${stderr.slice(-500)}`));
          else resolve();
        });
      });
      if (task.cancelled) throw new Error("已取消生成，原始物体仍然保留。");
      const output = {};
      for (const name of ["positions", "normals", "colors", "indices"]) {
        const data = await fs.readFile(path.join(folder, `${name}.bin`));
        output[name] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      }
      output.report = JSON.parse(await fs.readFile(path.join(folder, "report.json"), "utf8"));
      return output;
    } finally {
      event.sender.removeListener("destroyed", cancel);
      tasks.delete(owner);
      if (folder) await fs.rm(folder, { recursive: true, force: true });
    }
  });
  app.on("before-quit", () => { for (const task of tasks.values()) { task.cancelled = true; task.child?.kill("SIGKILL"); } });
}
module.exports = { registerObjectStudio };
