import { test, expect, type Page } from '@playwright/test';

async function findSnapPoint(page: Page, x: number, yStart: number, yEnd: number, steps = 16) {
  const snap = page.locator('[data-measure-snap="true"]');
  for (let i = 0; i <= steps; i++) {
    const y = yStart + ((yEnd - yStart) * i) / steps;
    await page.mouse.move(x, y);
    if (await snap.count()) return { x, y };
  }
  throw new Error(`未在 (${x}, ${yStart}..${yEnd}) 找到可吸附点云表面`);
}

test('真实点击悬停吸附、动态测线、视角切换保留、A/B标记与中点距离可视化', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/');
  await page.getByRole('button', { name: '打开示例', exact: true }).click();
  await expect(page.locator('.status-bar')).toContainText('合成示例');

  await page.getByRole('button', { name: '测距', exact: true }).click();
  await page.getByLabel('视角', { exact: true }).selectOption('top');

  const canvas = page.locator('.cloud-view canvas');
  const box = (await canvas.boundingBox())!;
  const centerX = box.x + box.width * 0.5;
  const secondX = box.x + box.width * 0.58;

  // 1. 悬停第一面墙 (y=0) 出现吸附靶标，点击固定 A 点
  const wallA = await findSnapPoint(page, centerX, box.y + box.height * 0.7, box.y + box.height * 0.8);
  await expect(page.locator('[data-measure-snap="true"]')).toBeVisible();
  await page.mouse.click(wallA.x, wallA.y);
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-measure-points', '1');
  const markerA = page.locator('[data-measure-marker="A"]');
  await expect(markerA).toBeVisible();
  const markerABox = (await markerA.boundingBox())!;
  expect(Math.hypot(markerABox.x + markerABox.width / 2 - wallA.x, markerABox.y + markerABox.height / 2 - wallA.y)).toBeLessThan(20);

  // 2. 第一点后悬停第二面墙 (y=6)，显示动态测线与实时距离
  await findSnapPoint(page, secondX, box.y + box.height * 0.2, box.y + box.height * 0.3);
  await expect(page.locator('[data-measure-line="dynamic"][data-snapped="true"]')).toBeVisible();
  await expect(page.locator('[data-measure-midpoint-label="dynamic"]')).toContainText('m');

  // 3. 切换预设视角后，未完成的 A 点测量应保留且继续投影
  await page.getByLabel('视角', { exact: true }).selectOption('iso');
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-measure-points', '1');
  await expect(markerA).toBeVisible();
  await page.getByLabel('视角', { exact: true }).selectOption('top');
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-measure-points', '1');

  // 4. 在俯视图点击第二面墙，完成斜向测距并校验屏幕标记与中点距离
  const wallBConfirm = await findSnapPoint(page, secondX, box.y + box.height * 0.2, box.y + box.height * 0.3);
  await page.mouse.click(wallBConfirm.x, wallBConfirm.y);
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-measure-points', '2');

  const markerB = page.locator('[data-measure-marker="B"]');
  await expect(markerA).toBeVisible();
  await expect(markerB).toBeVisible();
  await expect(page.locator('[data-measure-line="fixed"]')).toBeVisible();

  const distanceAttr = Number(await page.locator('.cloud-view').getAttribute('data-measure-distance'));
  expect(distanceAttr).toBeGreaterThan(5.8);
  expect(distanceAttr).toBeLessThan(7.0);

  const formattedM = `${distanceAttr.toFixed(3)} m`;
  await expect(page.getByLabel('点云测距结果')).toContainText(formattedM);
  const midLabel = page.locator('[data-measure-midpoint-label="fixed"]');
  await expect(midLabel).toContainText(formattedM);

  const aCenter = await markerA.boundingBox().then(b => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }));
  const bCenter = await markerB.boundingBox().then(b => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }));
  const labelBox = (await midLabel.boundingBox())!;
  expect(Math.hypot(labelBox.x + labelBox.width / 2 - (aCenter.x + bCenter.x) / 2, labelBox.y + labelBox.height / 2 - (aCenter.y + bCenter.y) / 2)).toBeLessThan(30);

  await page.screenshot({ path: 'artifacts/cloud-measure.png' });

  // 5. 剖切剔除顶层端点后测线自动失效
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('剖切下限 m').fill('.5');
  await page.getByLabel('剖切上限 m').fill('1.8');
  await page.getByRole('button', { name: '保留高度范围', exact: true }).click();
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-measure-points', '0');
  await expect(page.getByLabel('点云测距结果')).toContainText('请选择第一个点');

  // 6. 未完成第一点按 Esc 取消
  await page.getByRole('button', { name: '恢复全部源点', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复全部源点', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const retryA = await findSnapPoint(page, centerX, box.y + box.height * 0.7, box.y + box.height * 0.8);
  await page.mouse.click(retryA.x, retryA.y);
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-measure-points', '1');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cloud-view')).toHaveAttribute('data-measure-points', '0');

  expect(errors).toEqual([]);
});
