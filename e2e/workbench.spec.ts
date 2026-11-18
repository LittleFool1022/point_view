import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

function pcdPointCount(path: string): number {
  const header = readFileSync(path).subarray(0, 32_768).toString("ascii");
  const match = /^POINTS\s+(\d+)/m.exec(header);
  if (!match) throw new Error(`PCD 缺少 POINTS：${path}`);
  return Number(match[1]);
}

test("WebGL2 工作台渲染、框选与导出入口可用", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("POINT VIEW")).toBeVisible();
  await expect(page.getByLabel("当前前相机，点击切换到左相机")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator(".camera-view")).toHaveCount(1);
  await expect(page.locator(".camera-view")).toContainText("前相机");
  await page.getByLabel("当前前相机，点击切换到左相机").click();
  await expect(page.locator(".camera-view")).toContainText("左相机");
  await expect(page.locator(".camera-view")).not.toContainText("前相机");
  await expect(page.getByText("当前相机")).toBeVisible();
  await expect(page.getByText("硬同步")).toBeVisible();
  await expect(page.getByLabel("点云颜色模式")).toHaveValue("rgb");
  await expect(page.locator("canvas").first()).toBeVisible();

  const capability = await page.locator("canvas").first().evaluate((canvas) => {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    return { webgl2: Boolean(gl), width: canvas.clientWidth, height: canvas.clientHeight };
  });
  expect(capability.webgl2).toBe(true);
  expect(capability.width).toBeGreaterThan(500);
  expect(capability.height).toBeGreaterThan(300);

  await expect(page.getByText(/FPS/).first()).toBeVisible();
  await expect(page.getByText(/^0 点$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("点云大小")).toBeVisible();
  const decay = page.getByLabel("点云帧保留时间");
  await expect(decay).toHaveValue("5");
  await decay.fill("12");
  await expect(decay).toHaveValue("12");
  await expect(page.locator(".view-controls output")).toHaveCount(0);
  await expect(page.locator(".point-cloud-canvas")).toHaveAttribute("data-reference-guides", "visible");
  await page.getByRole("button", { name: "隐藏参考系" }).click();
  await expect(page.locator(".point-cloud-canvas")).toHaveAttribute("data-reference-guides", "hidden");
  await page.getByRole("button", { name: "显示参考系" }).click();
  await expect(page.locator(".point-cloud-canvas")).toHaveAttribute("data-reference-guides", "visible");

  const points = Array.from({ length: 21 * 21 }, (_, index) => {
    const x = (index % 21 - 10) * 0.2;
    const y = (Math.floor(index / 21) - 10) * 0.2;
    return `${x} ${y} 1.5 80 210 255`;
  });
  const pcd = [
    "VERSION 0.7", "FIELDS x y z r g b", "SIZE 4 4 4 1 1 1", "TYPE F F F U U U",
    "COUNT 1 1 1 1 1 1", "WIDTH 441", "HEIGHT 1", "POINTS 441", "DATA ascii", ...points,
  ].join("\n");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入点云" }).click();
  await (await chooserPromise).setFiles({ name: "selection.pcd", mimeType: "application/octet-stream", buffer: Buffer.from(pcd) });
  await expect(page.getByText("441 点")).toBeVisible();
  await page.getByRole("button", { name: "框选" }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("点云 canvas 无布局尺寸");
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText(/已选 [1-9][0-9]*/)).toBeVisible();
  await expect(page.getByRole("button", { name: "移动" })).toBeEnabled();
  await page.getByRole("button", { name: "移动" }).click();
  await expect(page.locator(".point-cloud-canvas")).toHaveAttribute("data-move-mode", "active");
  const moveBox = await page.locator(".point-cloud-canvas canvas").boundingBox();
  if (!moveBox) throw new Error("点云 canvas 无布局尺寸");
  await page.mouse.move(moveBox.x + moveBox.width * 0.48, moveBox.y + moveBox.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(moveBox.x + moveBox.width * 0.54, moveBox.y + moveBox.height * 0.21, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".point-cloud-canvas")).toHaveAttribute("data-move-drag", "applied");
  await expect(page.getByRole("button", { name: "撤销" })).toBeEnabled();
  await expect(page.locator(".point-cloud-canvas")).toHaveAttribute("data-move-mode", "inactive");
  await expect(page.getByRole("button", { name: "导出 PLY" })).toBeEnabled();

  await page.getByRole("button", { name: "刷新" }).click();
  await expect(page.locator(".action-notice")).toHaveText("点云缓存已清空，等待下一帧");
  await expect(page.getByText(/^0 点$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 PLY" })).toBeDisabled();
  await expect(page.getByText("已选 0")).toBeVisible();
  expect(errors).toEqual([]);
});

test("桌面首屏完整容纳单目切换预览与两横排操作条", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.locator(".camera-view")).toHaveCount(1);
  await expect(page.locator(".camera-view")).toBeInViewport();
  await expect(page.getByLabel("当前前相机，点击切换到左相机")).toBeInViewport();
  await expect(page.getByRole("button", { name: "导入点云" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "导出 3DGS" })).toBeInViewport();
  await expect(page.locator(".map-shell")).toBeInViewport();

  const rows = await page.locator(".action-dock button").evaluateAll((buttons) =>
    [...new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))],
  );
  expect(rows).toHaveLength(2);

  const actionBox = await page.locator(".action-dock").boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.x + actionBox!.width / 2).toBeCloseTo(720, 0);

  const cameraBox = await page.locator(".camera-panel").boundingBox();
  const mapBox = await page.locator(".map-panel").boundingBox();
  expect(cameraBox).not.toBeNull();
  expect(mapBox).not.toBeNull();
  expect(cameraBox!.width).toBeCloseTo(mapBox!.width, 0);
  expect(cameraBox!.height).toBeCloseTo(mapBox!.height, 0);
});

test("导航和操作按钮的名称、状态与实际功能一致", async ({ page }) => {
  await page.goto("/");

  const workspace = page.getByRole("button", { name: "工作台", exact: true });
  const collection = page.getByRole("button", { name: "配置", exact: true });
  const projects = page.getByRole("button", { name: "工程", exact: true });
  await expect(workspace).toHaveClass(/active/);

  await collection.click();
  await expect(collection).toHaveClass(/active/);
  await expect(page.getByText("Foxglove WebSocket")).toBeVisible();

  await projects.click();
  await expect(projects).toHaveClass(/active/);
  await expect(page.getByText("本地工程")).toBeVisible();

  await workspace.click();
  await expect(workspace).toHaveClass(/active/);
  await expect(page.getByText("本地工程")).toHaveCount(0);
  await expect(page.getByText("Foxglove WebSocket")).toHaveCount(0);

  await expect(page.getByRole("button", { name: "录制数据" })).toBeDisabled();
  for (const name of ["导出 PLY", "导出 PCD", "导出 LAS", "MCAP 快照", "导出 3DGS"]) {
    await expect(page.getByRole("button", { name })).toBeDisabled();
  }

  await page.getByRole("button", { name: "保存工程" }).click();
  await expect(page.locator(".action-notice")).toHaveText("当前工程和点云快照已保存");
  await projects.click();
  await expect(page.locator(".project-row")).toHaveCount(1);
});

test("CAD 工作区先预览同源模型，再导出标准三文件成果包", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "CAD", exact: true }).click();
  await expect(page.getByLabel("CAD 与测量")).toBeVisible();
  await expect(page.getByText("覆盖面积")).toBeVisible();
  await expect(page.getByRole("button", { name: "生成预览" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "导出 CAD" })).toBeDisabled();

  const pcd = [
    "VERSION 0.7", "FIELDS x y z r g b", "SIZE 4 4 4 1 1 1", "TYPE F F F U U U",
    "COUNT 1 1 1 1 1 1", "WIDTH 4", "HEIGHT 1", "POINTS 4", "DATA ascii",
    "0 0 0 255 255 255", "2 0 0 255 255 255", "2 1 2 255 255 255", "0 1 2 255 255 255",
  ].join("\n");
  await page.locator(".cad-drawer").getByRole("button", { name: "关闭 CAD 测量" }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入点云" }).click();
  await (await chooserPromise).setFiles({ name: "cad-room.pcd", mimeType: "application/octet-stream", buffer: Buffer.from(pcd) });
  await expect(page.getByText("4 点")).toBeVisible();
  await page.getByRole("button", { name: "CAD", exact: true }).click();
  await expect(page.getByRole("button", { name: "生成预览" })).toBeEnabled();
  await page.getByRole("tab", { name: "复核" }).click();
  await page.getByLabel("标注文字").fill("客厅");
  await page.getByLabel("添加标注").click();
  await page.getByRole("button", { name: "生成预览" }).click();
  await expect(page.getByLabel("CAD 图纸预览画布")).toBeVisible();
  await page.getByText("处理记录").click();
  await expect(page.getByText("EVIDENCE_MAP_DRIVEN", { exact: true })).toBeVisible();
  await expect(page.locator(".cad-metrics > div").filter({ hasText: "实测 / 推断" }).locator("strong")).toContainText("/ 0");
  await page.getByRole("button", { name: "CAD 图层" }).click();
  await page.getByRole("button", { name: "隐藏推断" }).click();
  await expect(page.locator(".cad-layer-list label").filter({ hasText: "INFERRED_WALL" }).getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("button", { name: "关闭 CAD 图层" }).click();
  await page.getByRole("tab", { name: "图纸" }).click();
  await page.getByLabel("CAD 比例").selectOption("1:50");
  await expect(page.getByText("参数已改变 · 当前预览已过期，请重新生成")).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 CAD" })).toBeDisabled();
  await page.getByRole("button", { name: "重新预览" }).click();
  await expect(page.getByRole("button", { name: "导出 CAD" })).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CAD" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("-cad-xy.zip");
  const archive = unzipSync(readFileSync((await download.path())!));
  const names = Object.keys(archive);
  const dxfName = names.find((name) => name.endsWith(".dxf"));
  expect(dxfName).toBeTruthy();
  expect(names.some((name) => name.endsWith(".annotations.json"))).toBe(true);
  expect(names.some((name) => name.endsWith(".manifest.json"))).toBe(true);
  expect(strFromU8(archive[dxfName!]!)).toContain("$INSUNITS\r\n70\r\n4");
});

test("静态 PCD 在 Worker 中评估并导出可追溯质量报告", async ({ page }) => {
  await page.goto("/");
  const points = Array.from({ length: 30 * 30 }, (_, index) => {
    const x = index % 30;
    const y = Math.floor(index / 30);
    return `${x * 0.1} ${y * 0.1} ${Math.sin(x * 0.2) * 0.002} 120 130 140`;
  });
  const pcd = [
    "VERSION 0.7", "FIELDS x y z r g b", "SIZE 4 4 4 1 1 1", "TYPE F F F U U U",
    "COUNT 1 1 1 1 1 1", "WIDTH 900", "HEIGHT 1", "POINTS 900", "DATA ascii", ...points,
  ].join("\n");

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入点云" }).click();
  await (await chooserPromise).setFiles({ name: "quality-good.pcd", mimeType: "application/octet-stream", buffer: Buffer.from(pcd) });
  await expect(page.locator(".action-notice")).toContainText("PCD 质量分析完成", { timeout: 15_000 });

  await page.getByRole("button", { name: "质量", exact: true }).click();
  await expect(page.getByLabel("点云质量评估")).toBeVisible();
  await expect(page.locator(".quality-source")).toContainText("quality-good.pcd");
  await expect(page.locator(".quality-summary > div").filter({ hasText: "几何" }).locator("strong")).not.toHaveText("--");
  await expect(page.locator(".quality-summary > div").filter({ hasText: "配准" }).locator("strong")).toHaveText("--");
  await expect(page.getByText("局部平面粗糙度 P90")).toBeVisible();
  await expect(page.getByText("点到平面配准残差 P90")).toBeVisible();

  await page.getByLabel("质量评估 Profile").selectOption("3dgs-ready");
  await expect(page.locator(".quality-verdict")).toContainText("3DGS 原始图片");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 quality-report.json" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("quality-good-quality-report.json");
  const report = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(report.schemaVersion).toBe("point-view-quality/1.0.0");
  expect(report.profile.id).toBe("3dgs-ready");
  expect(report.metrics.find((metric: { id: string }) => metric.id === "finiteRatio").threshold.pass).toBe(0.999);
  expect(report.metrics.find((metric: { id: string }) => metric.id === "registrationResidual").status).toBe("unavailable");
  expect(report.hardGates.some((gate: { id: string; status: string }) => gate.id === "3dgs-images" && gate.status === "fail")).toBe(true);
});

test("固定侧栏常驻且相机地图可由显式按钮隐藏恢复", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tool-rail")).toBeInViewport();
  await expect(page.locator(".status-stack")).toBeInViewport();
  await expect(page.getByLabel("隐藏相机")).toBeVisible();
  await expect(page.getByLabel("隐藏地图")).toBeVisible();

  await page.getByLabel("隐藏相机").click();
  await expect(page.locator(".camera-panel")).toHaveCount(0);
  await page.getByLabel("显示相机").click();
  await expect(page.locator(".camera-panel")).toBeVisible();

  await page.getByLabel("隐藏地图").click();
  await expect(page.locator(".map-panel")).toHaveCount(0);
  await page.getByLabel("显示地图").click();
  await expect(page.locator(".map-panel")).toBeVisible();
});

test("相机全屏覆盖其他组件且支持按钮和 Esc 退出", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("全屏前相机").click();

  await expect(page.getByLabel("退出全屏")).toBeInViewport();
  await expect(page.getByLabel("隐藏相机")).toBeHidden();
  await expect(page.getByLabel("隐藏地图")).toBeHidden();
  await expect(page.locator(".action-dock")).toBeHidden();
  await expect(page.locator(".camera-view.maximized")).toHaveCSS("position", "fixed");

  await page.getByLabel("退出全屏").click();
  await expect(page.getByLabel("全屏前相机")).toBeVisible();
  await page.getByLabel("全屏前相机").click();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("全屏前相机")).toBeVisible();
});

test("底部三栏随窗口等距收缩且不发生覆盖", async ({ page }) => {
  for (const width of [1800, 1468, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const camera = await page.locator(".camera-panel").boundingBox();
    const actions = await page.locator(".action-dock").boundingBox();
    const map = await page.locator(".map-panel").boundingBox();
    expect(camera).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(map).not.toBeNull();

    const leftGap = actions!.x - (camera!.x + camera!.width);
    const rightGap = map!.x - (actions!.x + actions!.width);
    expect(leftGap).toBeGreaterThanOrEqual(0);
    expect(rightGap).toBeGreaterThanOrEqual(0);
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
    expect(actions!.x + actions!.width / 2).toBeCloseTo(width / 2, 0);
  }
});

test("Android 8GB 对应窄屏布局保持点云和采集操作可见", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/");
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "录制数据" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 3DGS" })).toBeVisible();
});

test("浏览器端按需加载 WASM 并导入真实 LAZ", async ({ page }) => {
  test.skip(!process.env.LAZ_FIXTURE, "未提供 LAZ_FIXTURE");
  test.setTimeout(90_000);
  await page.goto("/");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入点云" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(process.env.LAZ_FIXTURE!);
  await expect(page.getByText("808,042 点")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/已加载 indoor\.laz/)).toBeVisible();
});

test("导入真实 FAST-LIVO2 RGB PCD 并执行桌面 LOD", async ({ page }) => {
  test.skip(!process.env.FAST_LIVO2_PCD, "未提供 FAST_LIVO2_PCD");
  test.setTimeout(120_000);
  const source = process.env.FAST_LIVO2_PCD!;
  const total = pcdPointCount(source);
  await page.goto("/");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入点云" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(source);
  await expect(page.getByText(new RegExp(`${total.toLocaleString("en-US")} 点`))).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(new RegExp(`已加载 ${basename(source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).toBeVisible();
});

test("真实点云持续渲染稳定性", async ({ page }) => {
  const soakSeconds = Number(process.env.SOAK_SECONDS ?? 0);
  test.skip(!process.env.FAST_LIVO2_PCD || soakSeconds <= 0, "未提供 FAST_LIVO2_PCD 与 SOAK_SECONDS");
  test.setTimeout((soakSeconds + 120) * 1_000);
  const source = process.env.FAST_LIVO2_PCD!;
  const totalText = `${pcdPointCount(source).toLocaleString("en-US")} 点`;

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入点云" }).click();
  await (await chooserPromise).setFiles(source);
  await expect(page.getByText(new RegExp(totalText))).toBeVisible({ timeout: 90_000 });

  const deadline = Date.now() + soakSeconds * 1_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(Math.min(10_000, Math.max(1, deadline - Date.now())));
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(page.getByText(new RegExp(totalText))).toBeVisible();
  }
  expect(errors).toEqual([]);
});
