import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { openCadEndpoints, type CadConnectionEntity } from "../../src/cad/connections";
import type { CadLineEntity, DrawingWarning } from "../../src/cad/model";
import { decodeProject } from "../src/domain/project";
import { gappedRoomPcd } from "./fixtures/gappedRoom";

async function downloaded(page: Page, name: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  return readFile((await (await pending).path())!);
}

test("两个开放端点可人工连接，撤销重做、标注、重样式、交付与工程恢复保持同一图元", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入测量成果", exact: true }).click();
  await (await chooser).setFiles({ name: "gapped.pcd", mimeType: "application/octet-stream", buffer: Buffer.from(gappedRoomPcd()) });
  await expect(page.locator(".status-bar")).toContainText("已导入 gapped.pcd");
  await page.getByRole("button", { name: "智能出图", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("工程图已生成", { timeout: 30000 });
  await expect(page.locator(".connection-summary")).toHaveText("2 处缺口 · 0 连线");
  const initialBytes = await downloaded(page, "保存工程");
  const initialProject = await decodeProject(initialBytes.slice().buffer as ArrayBuffer);
  if (!initialProject.drawing) throw Error("测试工程缺少图纸");
  const drawing = initialProject.drawing;
  const endpoints = openCadEndpoints(drawing);
  expect(endpoints).toHaveLength(2);
  const canvas = page.getByLabel("CAD 图纸预览画布", { exact: true }), box = (await canvas.boundingBox())!;
  const center = JSON.parse((await canvas.getAttribute("data-drawing-center"))!), scale = Number(await canvas.getAttribute("data-drawing-scale"));
  const screen = (point: number[]) => ({ x: box.x + box.width / 2 + (point[0]! - center[0]) * scale, y: box.y + box.height / 2 - (point[1]! - center[1]) * scale });
  const first = screen(endpoints[0]!.point), second = screen(endpoints[1]!.point);
  await page.getByRole("button", { name: "连接端点", exact: true }).click();
  await page.mouse.click(first.x + 3, first.y - 2);
  await expect(page.locator(".cad-preview-shell")).toHaveAttribute("data-connection-step", "1");
  await page.mouse.click(second.x - 2, second.y + 3);
  await expect(page.locator(".connection-summary")).toHaveText("0 处缺口 · 1 连线");
  await expect(page.locator(".warnings-box")).toContainText("0 个未连接端点");
  await expect(page.locator(".warnings-box")).toContainText("1 条人工连接墙线");
  await page.screenshot({ path: "artifacts/manual-cad-connection.png" });

  const savedBytes = await downloaded(page, "保存工程");
  const savedProject = await decodeProject(savedBytes.slice().buffer as ArrayBuffer);
  if (!savedProject.drawing) throw Error("保存工程缺少图纸");
  const manual = savedProject.drawing.entities.find((entity): entity is CadLineEntity => entity.metadata?.operation === "manual-endpoint-connection");
  if (!manual) throw Error("人工连线未保存");
  expect(manual).toMatchObject({ type: "line", source: "manual", confidence: "confirmed", layer: "INFERRED_WALL", start: endpoints[0]!.point, end: endpoints[1]!.point });

  await page.getByText("尺寸与工程标注", { exact: true }).click();
  await page.getByLabel("标注内容", { exact: true }).fill("连线复核");
  await page.getByRole("button", { name: "在图纸放置标注", exact: true }).click();
  await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
  await expect(page.locator(".connection-summary")).toHaveText("0 处缺口 · 1 连线");
  await page.getByText("出图设置", { exact: true }).click();
  await page.getByLabel("图幅", { exact: true }).selectOption("A2");
  const delivery = unzipSync(await downloaded(page, "导出三视图成果包"));
  const annotations = JSON.parse(strFromU8(Object.entries(delivery).find(([name]) => name.endsWith(".annotations.json"))![1])) as { entities: typeof savedProject.drawing.entities };
  expect(annotations.entities.find(entity => entity.id === manual.id)).toMatchObject({ source: "manual", geometry: { start_mm: endpoints[0]!.point, end_mm: endpoints[1]!.point } });
  expect(strFromU8(delivery["survey-drawing/multiview.dxf"])).toContain(manual.id);
  expect(strFromU8(delivery["survey-drawing/multiview.svg"])).toContain(`data-entity-id="${manual.id}"`);
  const review = JSON.parse(strFromU8(delivery["survey-drawing/review.json"])) as { warnings: DrawingWarning[] };
  expect(review.warnings.find(warning => warning.code === "WALL_LINES_REVIEW")?.message).toContain("0 个未连接端点");
  expect(review.warnings.some(warning => warning.code === "MANUAL_WALL_CONNECTION")).toBe(true);

  await page.getByRole("button", { name: "撤销 CAD 编辑", exact: true }).click();
  await page.getByRole("button", { name: "撤销 CAD 编辑", exact: true }).click();
  await expect(page.locator(".connection-summary")).toHaveText("2 处缺口 · 0 连线");
  await page.getByRole("button", { name: "重做 CAD 编辑", exact: true }).click();
  await page.getByRole("button", { name: "重做 CAD 编辑", exact: true }).click();
  await expect(page.locator(".connection-summary")).toHaveText("0 处缺口 · 1 连线");
  const restored = await downloaded(page, "保存工程");
  const reopen = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "打开工程", exact: true }).click();
  await (await reopen).setFiles({ name: "connected.pvplan", mimeType: "application/octet-stream", buffer: restored });
  await expect(page.locator(".status-bar")).toContainText("测量工程已恢复");
  await expect(page.locator(".connection-summary")).toHaveText("0 处缺口 · 1 连线");
  expect(errors).toEqual([]);
});

function cornerRoomPcd(): ArrayBuffer {
  const rows: string[] = [];
  const add = (x: number, y: number, z: number) => rows.push(`${x} ${y} ${z}`);
  for (let t = 0; t <= 8; t += .05) for (let z = 0; z <= 3; z += .1) { if (t >= 1) add(t, 0, z); add(t, 6, z); }
  for (let t = 0; t <= 6; t += .05) for (let z = 0; z <= 3; z += .1) { if (t >= 1) add(0, t, z); add(8, t, z); }
  const pcd = `VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\nPOINTS ${rows.length}\nDATA ascii\n${rows.join("\n")}\n`;
  return new TextEncoder().encode(pcd).buffer as ArrayBuffer;
}

test("墙角端点连线支持 Space 切换外折90°、内折90°、直连、弧线并持久化", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入测量成果", exact: true }).click();
  await (await chooser).setFiles({ name: "corner.pcd", mimeType: "application/octet-stream", buffer: Buffer.from(cornerRoomPcd()) });
  await expect(page.locator(".status-bar")).toContainText("已导入 corner.pcd");
  await page.getByRole("button", { name: "智能出图", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("工程图已生成", { timeout: 30000 });
  await expect(page.locator(".connection-summary")).toHaveText("2 处缺口 · 0 连线");

  const initialBytes = await downloaded(page, "保存工程");
  const initialProject = await decodeProject(initialBytes.slice().buffer as ArrayBuffer);
  const endpoints = openCadEndpoints(initialProject.drawing!);
  expect(endpoints).toHaveLength(2);
  const canvas = page.getByLabel("CAD 图纸预览画布", { exact: true }), box = (await canvas.boundingBox())!;
  const center = JSON.parse((await canvas.getAttribute("data-drawing-center"))!), scale = Number(await canvas.getAttribute("data-drawing-scale"));
  const screen = (point: number[]) => ({ x: box.x + box.width / 2 + (point[0]! - center[0]) * scale, y: box.y + box.height / 2 - (point[1]! - center[1]) * scale });
  const first = screen(endpoints[0]!.point), second = screen(endpoints[1]!.point);

  await page.getByRole("button", { name: "连接端点", exact: true }).click();
  await page.mouse.click(first.x, first.y);
  await page.mouse.move(second.x, second.y);
  const shell = page.locator(".cad-preview-shell");
  await expect(shell).toHaveAttribute("data-connection-style", "outer90");
  await expect(page.locator(".cad-dimension-hint")).toContainText("自动(外折 90°)");

  // Space 依次循环：内折 90° -> 直连 -> 弧线 -> 外折 90°
  await page.keyboard.press("Space");
  await expect(shell).toHaveAttribute("data-connection-style", "inner90");
  await expect(page.locator(".cad-dimension-hint")).toContainText("内折 90°");

  await page.keyboard.press("Space");
  await expect(shell).toHaveAttribute("data-connection-style", "direct");
  await expect(page.locator(".cad-dimension-hint")).toContainText("直连");

  await page.keyboard.press("Space");
  await expect(shell).toHaveAttribute("data-connection-style", "arc");
  await expect(page.locator(".cad-dimension-hint")).toContainText("弧线");

  await page.keyboard.press("Space");
  await expect(shell).toHaveAttribute("data-connection-style", "outer90");

  // 以弧线落盘后验证保存与撤销后改用外折 90°
  await page.keyboard.press("Space"); // inner90
  await page.keyboard.press("Space"); // direct
  await page.keyboard.press("Space"); // arc
  await page.mouse.click(second.x, second.y);
  await expect(page.locator(".connection-summary")).toHaveText("0 处缺口 · 1 连线");
  const arcSaved = await decodeProject((await downloaded(page, "保存工程")).slice().buffer as ArrayBuffer);
  const arcEntity = arcSaved.drawing!.entities.find(e => e.metadata?.operation === "manual-endpoint-connection") as CadConnectionEntity;
  expect(arcEntity.type).toBe("arc");

  await page.getByRole("button", { name: "撤销 CAD 编辑", exact: true }).click();
  await expect(page.locator(".connection-summary")).toHaveText("2 处缺口 · 0 连线");

  await page.mouse.click(first.x, first.y);
  await page.mouse.move(second.x, second.y);
  await expect(shell).toHaveAttribute("data-connection-style", "outer90");
  await page.mouse.click(second.x, second.y);
  await expect(page.locator(".connection-summary")).toHaveText("0 处缺口 · 1 连线");
  const outerSaved = await decodeProject((await downloaded(page, "保存工程")).slice().buffer as ArrayBuffer);
  const outerEntity = outerSaved.drawing!.entities.find(e => e.metadata?.operation === "manual-endpoint-connection") as CadConnectionEntity;
  expect(outerEntity.type).toBe("polyline");
  if (outerEntity.type === "polyline") expect(outerEntity.points).toHaveLength(3);

  expect(errors).toEqual([]);
});
