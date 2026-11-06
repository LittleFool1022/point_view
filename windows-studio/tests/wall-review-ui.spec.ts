import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { encodeProject } from "../src/domain/project";
import { artifactWall, reviewFixture, reviewFixtureOptions, reviewFixtureSegments } from "../src/domain/reviewFixtures";
import { buildingFromSegments, sourceStamp } from "../src/domain/buildingOps";
import type { BuildingModel } from "../src/domain/building";

/**
 * 未闭合清单驱动的墙体与房间复核（Issue #32 验收）：合成房间（东墙 0.6 m 缺口 + 室外一处伪影）走完整界面流程。
 * 导入合成点云 → 生成建筑候选（未闭合、无房间）→ 清单定位 → 画布补墙 → 房间出现并计数更新
 * → 保存重开处置仍在 → 确认洞口后清单减少 → 撤销一次处置回滚；另一条路径走删伪影与重新拟合阻断。
 * 点云由 scripts/wall-review-fixture.ts 生成（tests/wall-review-ui.test.ts 校验同一份点的拟合结果），
 * 用例不写死墙段编号、计数或坐标：缺口与伪影都按几何关系从界面清单里取。
 */
const FIXTURE = "artifacts/wall-review/review-room-gap.pcd";
type Point = [number, number];

const fixtureSource = () => ({ name: "review-room-gap.pcd", bytes: new ArrayBuffer(1), units: "m" as const, synthetic: true });
/** 点云生成的候选模型（6 段墙、0 房间）：点云由 tests/wall-review-ui.test.ts 校验为同一份几何。 */
const fittedModel = () => buildingFromSegments(fixtureSource(), reviewFixtureOptions, reviewFixtureSegments());
const projectOf = async (building?: BuildingModel) => Array.from(await encodeProject({ source: fixtureSource(), building, annotations: [], settings: {}, projection: "xy" }));

async function openProject(page: Page, data: number[], name = "复核工程.pvplan") {
  await page.goto("/");
  // 与人工选择本地工程文件相同：走系统文件选择器，不在产品代码里增加自动化后门。
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "打开工程", exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(data) });
  // 等模型与复核面板恢复，再进入平面编辑。
  await page.locator(".extensions-menu summary").click();
  await page.getByRole("button", { name: "建筑模型", exact: true }).click();
  await expect(page.getByRole("region", { name: "墙体与房间复核" })).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".work-toolbar")).toContainText("墙");
  await page.getByRole("button", { name: "平面编辑", exact: true }).click();
}

test("合成点云导入 → 生成候选 → 清单驱动补墙 → 房间出现并计数更新（界面主路径）", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/");
  // 打开示例让“导入测量成果”可用，随后整份替换为复核夹具点云。
  await page.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("合成示例");
  const chooser = page.waitForEvent("filechooser");
  page.once("dialog", d => d.accept().catch(() => {}));
  await page.getByRole("button", { name: "导入测量成果", exact: true }).click();
  await (await chooser).setFiles(FIXTURE);
  await expect(page.locator(".status-bar")).toContainText("review-room-gap.pcd", { timeout: 30000 });
  await page.locator(".extensions-menu summary").click();
  await page.getByRole("button", { name: "建筑模型", exact: true }).click();
  await page.getByRole("button", { name: "从点云生成建筑候选", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("已生成", { timeout: 30000 });
  await page.getByRole("button", { name: "平面编辑", exact: true }).click();
  const panel = page.getByRole("region", { name: "墙体与房间复核" });
  await expect(page.locator(".work-toolbar")).toContainText("6 墙");
  await expect(page.locator(".work-toolbar")).toContainText("0 房间");
  await expect(panel.locator('[data-kind="wall-gap"]')).toHaveCount(2);
  await page.screenshot({ path: "artifacts/wall-review/01-list.png" });
  // 清单点选 → 画布定位 → 补墙 → 房间出现。
  const first = panel.locator('[data-kind="wall-gap"]').first();
  await first.locator(".review-issue").click();
  await expect(page.locator('[data-view="focus"]')).toBeVisible();
  await page.screenshot({ path: "artifacts/wall-review/02-locate.png" });
  const start = await pointOf(first), end = await pointOf(panel.locator('[data-kind="wall-gap"]').nth(1));
  await panel.getByRole("button", { name: "补墙", exact: true }).click();
  await clickPlan(page, start);
  await expect(page.locator('[data-snap="start"]')).toBeVisible();
  await clickPlan(page, end);
  await expect(panel.locator("[data-progress]")).toContainText("房间 1");
  await expect(page.locator(".work-toolbar")).toContainText("1 房间");
  await expect(panel.locator('[data-action="add-wall"]')).toHaveCount(1);
  await expect(panel.locator("[data-progress]")).toContainText("剩余 0");
  await page.screenshot({ path: "artifacts/wall-review/03-patched.png" });
  // 人工墙段存在时重新拟合：界面在拟合前阻断并列出失效项，不静默丢处置记录。
  await page.getByRole("button", { name: "从点云生成建筑候选", exact: true }).click();
  await expect(page.locator(".status-bar")).toContainText("已阻断重新拟合");
  await expect(panel.locator('[data-action="add-wall"]')).toHaveCount(1);
  await page.screenshot({ path: "artifacts/wall-review/08-refit-blocked.png" });
  expect(errors).toEqual([]);
});

/** 清单里某一项的位置（从本项文字里读，不猜坐标）。 */
async function pointOf(item: ReturnType<Page["locator"]>): Promise<Point> {
  const text = (await item.locator(".review-issue small").textContent())!;
  const m = text.match(/位置 (-?[\d.]+), (-?[\d.]+) m/)!;
  return [Number(m[1]), Number(m[2])];
}
/** 画布坐标换算：按当前 viewBox 把模型坐标换成页面坐标，点击与预览共用同一路径。 */
async function planPoint(page: Page, p: Point): Promise<Point> {
  const svg = page.locator('svg[aria-label="建筑模型平面编辑"]');
  const box = (await svg.getAttribute("viewBox"))!.split(" ").map(Number), rect = (await svg.boundingBox())!;
  const scale = Math.min(rect.width / box[2]!, rect.height / box[3]!), ox = rect.x + (rect.width - box[2]! * scale) / 2, oy = rect.y + (rect.height - box[3]! * scale) / 2;
  return [ox + (p[0] - box[0]!) * scale, oy + (-p[1] - box[1]!) * scale];
}
async function clickPlan(page: Page, p: Point) { await page.mouse.click(...await planPoint(page, p)); }
async function movePlan(page: Page, p: Point) { await page.mouse.move(...await planPoint(page, p)); }
const count = async (locator: ReturnType<Page["locator"]>, pattern: RegExp) => Number((await locator.textContent())!.match(pattern)![1]);

test("复核者从未闭合清单出发逐项处置：补墙成房、撤销重做、保存重开与点云不可用提示", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  // 起点：与点云生成的候选同一份模型（6 墙、0 房间；缺口两端与伪影各报一条）。
  await openProject(page, await projectOf(fittedModel()));
  const panel = page.getByRole("region", { name: "墙体与房间复核" });
  await expect(panel).toBeVisible();
  await expect(page.locator(".work-toolbar")).toContainText("6 墙");
  await expect(page.locator(".work-toolbar")).toContainText("0 房间");
  await expect(panel.locator('[data-kind="wall-gap"]')).toHaveCount(2);
  await page.screenshot({ path: "artifacts/wall-review/01-list.png" });

  // 1) 清单点击一项：画布定位（幅面缩到缺口附近）并高亮该缺口，出现处置入口。
  const first = panel.locator('[data-kind="wall-gap"]').first();
  await first.locator(".review-issue").click();
  await expect(page.locator('[data-view="focus"]')).toBeVisible();
  await expect(panel.getByRole("group", { name: "处置入口" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "连接两端", exact: true })).toBeEnabled();
  const gapStart = await pointOf(first);
  await page.screenshot({ path: "artifacts/wall-review/02-locate.png" });
  const gapEnd = await pointOf(panel.locator('[data-kind="wall-gap"]').nth(1));

  // 2) 补墙：画布两点连线（带吸附预览）→ 房间出现、计数更新、处置记录出现。
  await panel.getByRole("button", { name: "补墙", exact: true }).click();
  await expect(page.locator(".review-pick")).toContainText("在画布上点两点");
  await clickPlan(page, gapStart);
  await expect(page.locator('[data-snap="start"]')).toBeVisible();
  await movePlan(page, gapEnd);
  await expect(page.locator('[data-snap="preview"]')).toHaveCount(1);
  await clickPlan(page, gapEnd);
  await expect(panel.locator("[data-progress]")).toContainText("房间 1");
  await expect(page.locator(".work-toolbar")).toContainText("1 房间");
  await expect(panel.locator('[data-action="add-wall"]')).toHaveCount(1);
  await page.screenshot({ path: "artifacts/wall-review/03-patched.png" });

  // 3) 撤销一次处置：补墙连同其处置记录回滚，房间与剩余数回到处置前；重做恢复。
  await page.getByRole("button", { name: "撤销模型编辑", exact: true }).click();
  await expect(panel.locator("[data-progress]")).toContainText("房间 0");
  await expect(panel.locator("[data-progress]")).toContainText("剩余 2");
  await expect(panel.locator('[data-action="add-wall"]')).toHaveCount(0);
  await page.screenshot({ path: "artifacts/wall-review/06-undone.png" });
  await page.getByRole("button", { name: "重做模型编辑", exact: true }).click();
  await expect(panel.locator("[data-progress]")).toContainText("房间 1");
  await expect(panel.locator('[data-action="add-wall"]')).toHaveCount(1);

  // 4) 保存 → 重开：处置记录、人工墙段与房间都恢复。
  const save = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存工程", exact: true }).click();
  const saved = await save;
  await openProject(page, Array.from(await readFile((await saved.path())!)), saved.suggestedFilename());
  const reopened = page.getByRole("region", { name: "墙体与房间复核" });
  await expect(reopened.locator("[data-progress]")).toContainText("房间 1");
  await expect(page.locator(".work-toolbar")).toContainText("1 房间");
  await expect(reopened.locator('[data-action="add-wall"]')).toHaveCount(1);
  // 本用例的工程包使用不可读点云：重开后模型、记录与房间不变，对照停用并明示。
  // 补墙后缺口由墙网几何消解，清单为空（全部处置完毕），处置记录仍在。
  await expect(reopened.locator("[data-progress]")).toContainText("剩余 0");
  await expect(reopened.locator("[data-progress]")).toContainText("已处置 0");
  await expect(page.locator("[data-cloud='missing']")).toBeVisible();
  await expect(page.getByRole("button", { name: "从点云生成建筑候选", exact: true })).toBeDisabled();
  await page.screenshot({ path: "artifacts/wall-review/04-reopened.png" });

  expect(errors).toEqual([]);
});

test("确认洞口：不计入未闭合、记录保留、不据此成房，撤销可回滚", async ({ page }) => {
  await openProject(page, await projectOf(fittedModel()));
  const panel = page.getByRole("region", { name: "墙体与房间复核" });
  const before = await count(panel.locator("[data-progress]"), /剩余 (\d+)/);
  await panel.locator('li[data-state="open"] .review-issue').first().click();
  await panel.getByRole("button", { name: "确认洞口", exact: true }).click();
  // 同一条缝两端各报一条，确认其中一条后已确认项不再计入未闭合。
  await expect(panel.locator("[data-progress]")).toContainText("已处置 1");
  expect(await count(panel.locator("[data-progress]"), /剩余 (\d+)/)).toBeLessThan(before);
  await expect(panel.locator('[data-action="resolved-opening"]')).toHaveCount(1);
  await expect(panel.locator("[data-progress]")).toContainText("房间 0");
  await expect(panel.locator("[data-state='resolved-opening']")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/wall-review/05-opening.png" });
  // 撤销：已确认洞口回滚成未处置。
  await page.getByRole("button", { name: "撤销模型编辑", exact: true }).click();
  await expect(panel.locator('[data-action="resolved-opening"]')).toHaveCount(0);
  await expect(panel.locator("[data-progress]")).toContainText(`剩余 ${before}`);
  await page.screenshot({ path: "artifacts/wall-review/09-undo-opening.png" });
});

test("删伪影：孤立墙段软删除留痕、清单收缩与撤销恢复", async ({ page }) => {
  const base = fittedModel();
  await openProject(page, await projectOf(base));
  const panel = page.getByRole("region", { name: "墙体与房间复核" });
  // 先经界面完成一次“连接两端”（留一条人工处置记录），再走删伪影。
  await panel.locator('li[data-state="open"] .review-issue').first().click();
  await panel.getByRole("button", { name: "连接两端", exact: true }).click();
  await expect(panel.locator('[data-action="connect"]')).toHaveCount(1);
  const remaining = await count(panel.locator("[data-progress]"), /剩余 (\d+)/);
  // 点选室外孤立墙段（不在房间环上、也不属于任何未闭合项的那段）：点其中段。
  const ghost = artifactWall(base)!;
  await clickPlan(page, [(ghost.axisM[0][0] + ghost.axisM[1][0]) / 2, (ghost.axisM[0][1] + ghost.axisM[1][1]) / 2]);
  const wallActions = panel.getByRole("group", { name: "选中墙段处置" });
  await expect(wallActions).toBeVisible();
  await panel.getByLabel("删除原因").fill("孤立墙面证据，判为伪影");
  await wallActions.getByRole("button", { name: "删除所选墙段（留痕）" }).click();
  await expect(panel.locator('[data-action="remove-wall"]')).toHaveCount(1);
  // 删掉孤立墙段后，与之相关的未闭合项按留痕折叠，清单收缩。
  await expect(panel.locator("[data-progress]")).not.toContainText(`剩余 ${remaining}`);
  await page.screenshot({ path: "artifacts/wall-review/07-artifact.png" });
  // 撤销删伪影：墙段回到墙网，清单恢复。
  await page.getByRole("button", { name: "撤销模型编辑", exact: true }).click();
  await expect(panel.locator("[data-progress]")).toContainText(`剩余 ${remaining}`);
  // 点云对照不可用时重新拟合入口停用并说明（不静默按有点云处理）。
  await expect(page.getByRole("button", { name: "从点云生成建筑候选", exact: true })).toBeDisabled();
  await expect(page.locator("[data-cloud='missing']")).toBeVisible();
  await page.screenshot({ path: "artifacts/wall-review/08-cloud-missing.png" });
});

test("点云不可用时保留模型与复核记录，点云恢复后重开恢复对照", async ({ page }) => {
  const raw = await readFile(FIXTURE), available = { ...fixtureSource(), bytes: new Uint8Array(raw).buffer };
  const model = buildingFromSegments(available, reviewFixtureOptions, reviewFixtureSegments());
  // 同一模型分别放入“点云可读”和“点云不可读”的工程包，模拟源件恢复前后，不迁移模型。
  const missing = { ...available, bytes: new ArrayBuffer(1) };
  const unavailableModel = { ...model, sourceStamp: sourceStamp(missing) };
  const missingArchive = await encodeProject({ source: missing, building: unavailableModel, annotations: [], settings: {}, projection: "xy" });
  const restoredArchive = await encodeProject({ source: available, building: model, annotations: [], settings: {}, projection: "xy" });
  await openProject(page, Array.from(missingArchive), "点云缺失.pvplan");
  const panel = page.getByRole("region", { name: "墙体与房间复核" });
  await expect(panel.locator("[data-progress]")).toContainText("房间 0");
  await expect(page.locator("[data-cloud='missing']")).toContainText("点云对照不可用");
  await expect(page.getByRole("button", { name: "从点云生成建筑候选", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "点云对照", exact: true })).toBeDisabled();
  await page.screenshot({ path: "artifacts/wall-review/10-cloud-missing.png" });

  // 源件恢复后，用同一份模型重新打开，不需迁移；点云对照与依赖点云操作恢复。
  await openProject(page, Array.from(restoredArchive), "点云恢复.pvplan");
  await expect(page.locator("[data-cloud='missing']")).toHaveCount(0);
  await expect(page.locator(".file-name")).toContainText("review-room-gap.pcd");
  await expect(page.getByRole("button", { name: "从点云生成建筑候选", exact: true })).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: "点云对照", exact: true })).toBeEnabled();
  await expect(page.getByRole("region", { name: "墙体与房间复核" }).locator("[data-progress]")).toContainText("房间 0");
  await page.screenshot({ path: "artifacts/wall-review/11-cloud-restored.png" });
});
