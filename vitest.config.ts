import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@point-view/lazperf-loader": fileURLToPath(new URL("./node_modules/@loaders.gl/las/dist/lazperf-loader.js", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
