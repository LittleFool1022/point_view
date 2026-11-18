import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  server: {
    // 原生构建缓存不参与前端热更新，避免耗尽系统文件监听数量。
    watch: { ignored: ["**/.android-gradle/**", "**/.tools/**", "**/android/**", "**/artifacts/**", "**/release/**", "**/.agents/**"] },
  },
  resolve: {
    alias: {
      "@point-view/lazperf-loader": fileURLToPath(new URL("./node_modules/@loaders.gl/las/dist/lazperf-loader.js", import.meta.url)),
    },
  },
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        handheld: fileURLToPath(new URL("./handheld.html", import.meta.url)),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("node_modules/leaflet")) return "map";
          if (id.includes("node_modules/@foxglove") || id.includes("node_modules/@mcap")) return "robotics";
          if (id.includes("node_modules/react")) return "react";
        },
      },
    },
  },
});
