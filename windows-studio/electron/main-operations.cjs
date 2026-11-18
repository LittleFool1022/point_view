const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

class OperationManager {
  constructor() { this.current = undefined; }
  start() {
    if (this.current) throw Error("请先完成或取消当前任务。");
    const controller = new AbortController();
    this.current = controller;
    return controller;
  }
  finish(controller) {
    if (this.current === controller) this.current = undefined;
  }
  cancel() { this.current?.abort(); }
}

async function atomicWriteFile(file, data) {
  const temporary = `${file}.${randomUUID()}.part`;
  let handle, created = false, renamed = false;
  try {
    handle = await fs.open(temporary, "wx");
    created = true;
    await handle.writeFile(data);
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    renamed = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created && !renamed) await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { OperationManager, atomicWriteFile };
