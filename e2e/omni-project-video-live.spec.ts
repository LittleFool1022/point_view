import { expect, test } from "@playwright/test";

test("真实 OMNI 项目行进视频播放、暂停、拖动与源帧间断提示", async ({ page }) => {
  test.skip(process.env.OMNI_LIVE !== "1", "仅在明确启用 omni 实机联调时运行");
  test.setTimeout(120_000);
  const session = process.env.OMNI_VIDEO_SESSION!;
  await page.setViewportSize({ width: 430, height: 932 });
  const errors: string[] = [];
  const ranges: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.url().includes(`/${session}/video`) && response.status() === 206) {
      ranges.push(response.headers()["content-range"] || "");
    }
  });

  await page.goto(`http://127.0.0.1:5174/?readonly=1#/records`);
  const project = await page.evaluate(async id => {
    const response = await fetch(`/omni-control/api/v1/projects`);
    const body = await response.json();
    return body.projects.find((item: { id: string }) => item.id === id);
  }, session);
  const targetCard = page.locator(".project-card").filter({ hasText: `${(project.points / 10000).toFixed(1)} 万点` });
  await expect(targetCard).toBeVisible({ timeout: 15_000 });
  await targetCard.click();
  await page.getByRole("button", { name: "通道行进视频", exact: true }).click();
  const video = page.getByLabel("通道行进视频画面");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "播放视频", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.15);
  await page.getByRole("button", { name: "暂停视频", exact: true }).click();
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await page.getByLabel("视频进度").fill("30");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(29);
  await expect.poll(() => ranges.length).toBeGreaterThan(0);
  await page.screenshot({ path: process.env.OMNI_VIDEO_SCREENSHOT!, fullPage: true });

  await page.route("**/omni-control/api/v1/projects", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, projects: [{ ...project,
      videoState: "partial", video: { ...project.video, sourceGaps: [{ startS: 1, durationS: 0.5 }] } }] }),
  }));
  await page.reload();
  await targetCard.click();
  await expect(page.getByRole("button", { name: "行进视频（有源帧间断）" })).toBeVisible();
  await page.getByRole("button", { name: "行进视频（有源帧间断）" }).click();
  await expect(page.getByText("源帧存在间断，未通过质量校验")).toBeVisible();
  await expect(page.getByLabel("通道行进视频画面")).toBeVisible();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ session, viewport: page.viewportSize(), playPauseSeek: "passed", rangeResponses: ranges,
    partialLabel: "passed", pageErrors: errors, pointCloudTransport: "real_preview", partialData: "explicit_test_override" }));
});
