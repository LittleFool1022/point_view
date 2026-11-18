import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/handheld/main.tsx"],
  outfile: "handheld-inline.js",
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "inline",
  metafile: true,
});

for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.some(item => item.external)) throw new Error("单文件演示不允许依赖外部资源");
}
const js = result.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const css = result.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!js || !css) throw new Error("缺少打包后的脚本或样式");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f7f8">
<meta name="description" content="OMNI Scan 手机 App 离线交互演示。所有设备与扫描状态均为模拟，无需联网。">
<title>OMNI Scan · 手机 App 离线演示</title>
<style id="omni-inline-style">${css.replace(/<\/style/gi, "<\\/style")}</style>
</head>
<body>
<div id="root"></div>
<noscript>请使用开启 JavaScript 的浏览器打开此手机 App 演示。</noscript>
<script id="omni-inline-runtime">${js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
const destination = path.join(root, "release", "OMNI-Scan-手机App演示.html");
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, html, "utf8");
console.log(`单文件 HTML：${destination}`);
console.log(`文件大小：${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB`);
console.log("React、Three.js、界面脚本与 CSS 已内嵌，无外部模块依赖。");
