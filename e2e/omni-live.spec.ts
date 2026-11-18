import { expect, test } from "@playwright/test";

test("omni 实机单路切换画面与硬同步状态", async ({ page }) => {
  test.skip(process.env.OMNI_LIVE !== "1", "仅在明确启用 omni 实机联调时运行");
  test.setTimeout(45_000);

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.getByLabel("点云帧保留时间")).toHaveValue("5");
  await expect(page.locator(".view-controls output")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "隐藏参考系" })).toBeVisible();
  await page.getByLabel("当前前相机，点击切换到左相机").click();
  const connectStartedAt = Date.now();
  await page.getByRole("button", { name: "连接" }).click();

  await expect(page.getByText("设备在线")).toBeVisible({ timeout: 10_000 });
  console.log(`device_online_ms=${Date.now() - connectStartedAt}`);
  await expect(page.getByText("1/1")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("locked")).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => {
    const text = await page.locator(".cloud-hud span").nth(1).textContent();
    return Number((text ?? "0").replace(/[^0-9]/g, ""));
  }, { timeout: 8_000 }).toBeGreaterThan(5_000);

  for (const [current, next, label] of [["左相机", "右相机", "左相机实时画面"], ["右相机", "前相机", "右相机实时画面"], ["前相机", "左相机", "前相机实时画面"]]) {
    const image = page.getByAltText(label);
    await expect(image).toBeVisible({ timeout: 20_000 });
    expect(await image.evaluate((element: HTMLImageElement) => ({
      width: element.naturalWidth,
      height: element.naturalHeight,
      src: element.src,
    }))).toMatchObject({ width: 1280, height: 960 });
    await page.getByLabel(`当前${current}，点击切换到${next}`).click();
  }
  expect(pageErrors).toEqual([]);
});
