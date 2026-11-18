import { describe, expect, test } from "vitest";
import { checkIpcContract, checkSourceContent, runGuardrails } from "../scripts/check-guardrails.mjs";

describe("工程硬约束门禁", () => {
  test("当前仓库全部源码通过架构与契约校验", () => {
    const result = runGuardrails();
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedFiles).toBeGreaterThan(50);
  });

  test("拦截领域层与管线层越界依赖 UI / Three / Electron", () => {
    const domainHits = checkSourceContent("src/domain/bad.ts", 'import { useState } from "react";\nimport * as THREE from "three";\n');
    expect(domainHits.map(v => v.rule)).toEqual(["domain-purity", "domain-purity"]);

    const pipelineHits = checkSourceContent("src/pipeline/bad.ts", 'import { CloudView } from "../CloudView";\n');
    expect(pipelineHits.map(v => v.rule)).toContain("pipeline-purity");
  });

  test("拦截预览采样 PREVIEW_POINTS 泄漏到全量处理模块", () => {
    const hits = checkSourceContent("src/pipeline/wallLines.ts", 'import { PREVIEW_POINTS } from "../domain/source";\nconst n = PREVIEW_POINTS;\n');
    expect(hits.some(v => v.rule === "preview-index-isolation")).toBe(true);
  });

  test("拦截渲染层直接访问 Node/Electron 与调试逃逸语句", () => {
    const hits = checkSourceContent(
      "src/bad.tsx",
      'import fs from "node:fs";\n// @ts-ignore\nconst x = 1;\ndebugger;\nconsole.log(x);\n'
    );
    expect(hits.map(v => v.rule)).toEqual([
      "no-ts-suppression",
      "renderer-no-node-or-electron",
      "no-debugger",
      "clean-console"
    ]);
  });

  test("拦截聚焦测试 .only 遗留", () => {
    const hits = checkSourceContent("tests/sample.test.ts", 'test.only("x", () => {});\n');
    expect(hits.map(v => v.rule)).toEqual(["no-focused-tests"]);
  });

  test("拦截 Electron preload / env.d.ts / main IPC 三端漂移与缺 assertOwner", () => {
    const hits = checkIpcContract({
      mainCode: `
        const { ipcMain } = require("electron");
        ipcMain.handle("survey:ping", async () => "ok");
        function createWindow() {
          return new BrowserWindow({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
        }
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", () => {});
      `,
      preloadCode: `
        const { contextBridge, ipcRenderer } = require("electron");
        contextBridge.exposeInMainWorld("surveyDesktop", {
          ping: () => ipcRenderer.invoke("survey:ping"),
          extraMethod: () => ipcRenderer.invoke("survey:missing-in-main")
        });
      `,
      envDtsCode: `
        interface Window {
          surveyDesktop?: {
            ping(): Promise<string>;
            staleTyped(): Promise<void>;
          };
        }
      `
    });
    expect(hits.map(v => v.rule).sort()).toEqual([
      "bridge-type-parity",
      "bridge-type-parity",
      "ipc-assert-owner",
      "ipc-contract-parity"
    ]);
  });
});
