import { defineConfig } from "@playwright/test";
const externalTests=["keyframe-pages.spec.ts","paired-review.spec.ts","paired-tri.spec.ts","semantic.spec.ts","stack-closure.spec.ts"];
export default defineConfig({
  testDir: "./tests", testMatch: "*.spec.ts", timeout: 60000, workers: 1,
  projects:[{name:"chromium",testIgnore:externalTests},{name:"external",testMatch:externalTests}],
  outputDir: "./artifacts/ui", use: { baseURL: "http://127.0.0.1:4186", viewport: { width: 1600, height: 1000 }, headless: true, screenshot: "only-on-failure" },
  webServer: { command: "npm run preview", url: "http://127.0.0.1:4186", reuseExistingServer: false, timeout: 30000 }
});
