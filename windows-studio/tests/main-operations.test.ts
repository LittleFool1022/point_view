import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs, { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { OperationManager, atomicWriteFile } = require("../electron/main-operations.cjs");

describe("主进程操作互斥与取消", () => {
  it("等待保存对话框时已占位，第二个任务同步被拒绝", async () => {
    const operations = new OperationManager();
    let closeDialog!:()=>void;const dialog=new Promise<void>(resolve=>{closeDialog=resolve;});
    const save = async () => {
      const controller = operations.start();
      try { await dialog; }
      finally { operations.finish(controller); }
    };
    const first = save();
    await expect(save()).rejects.toThrow("请先完成或取消当前任务");
    closeDialog();
    await first;
    const next = operations.start();
    operations.finish(next);
  });

  it("旧任务清理不释放新任务，取消作用于当前拥有者", () => {
    const operations = new OperationManager();
    const first = operations.start();
    operations.finish(first);
    const second = operations.start();
    operations.finish(first);
    expect(() => operations.start()).toThrow("请先完成或取消当前任务");
    operations.cancel();
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
    operations.finish(second);
  });
});

describe("通用成果原子保存", () => {
  it("替换失败保留旧文件并清理临时文件", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "survey-main-save-"));
    const target = path.join(directory, "export.pdf");
    const previous = Buffer.from("previous export");
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    try {
      await writeFile(target, previous);
      await expect(atomicWriteFile(target, Buffer.from("new export"))).rejects.toThrow("rename failed");
      expect(await readFile(target)).toEqual(previous);
      expect(await readdir(directory)).toEqual(["export.pdf"]);
    } finally {
      rename.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
