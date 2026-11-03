import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()], base: "./",
  resolve: { alias: { "@point-view/lazperf-loader": fileURLToPath(new URL("../node_modules/@loaders.gl/las/dist/lazperf-loader.js", import.meta.url)) } },
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  build: { target: "es2022", chunkSizeWarningLimit: 1000 },
  worker: { format: "es" }
});
