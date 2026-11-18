import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL("./omni", import.meta.url)),
  base: "./",
  plugins: [react()],
  server: {
    host: process.env.TAURI_DEV_HOST || "127.0.0.1",
    port: 5174, strictPort: true,
    proxy: {
      // 浏览器可能启用系统代理；开发态统一经 Vite 直连 OMNI，安卓包仍使用设备原始地址。
      "/omni-preview": {
        target: "ws://10.42.0.1:8765",
        ws: true,
        rewrite: () => "/",
      },
      "/omni-control": {
        target: "http://10.42.0.1:8766",
        rewrite: path => path.replace(/^\/omni-control/, ""),
      },
    },
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
    watch: { ignored: ["**/src-tauri/**", "**/.tools/**", "**/.android-gradle/**", "**/android/**", "**/artifacts/**", "**/release/**"] },
  },
  build: {
    target: "es2020", sourcemap: true,
    outDir: mode === "android" ? "dist-app" : "dist-browser",
    emptyOutDir: true,
    rollupOptions: {
      input: mode === "android" ? fileURLToPath(new URL("./omni/index.html", import.meta.url)) : {
        app: fileURLToPath(new URL("./omni/index.html", import.meta.url)),
        lab: fileURLToPath(new URL("./omni/lab.html", import.meta.url)),
      },
    },
  },
}));
