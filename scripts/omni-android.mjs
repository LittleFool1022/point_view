import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const sdk = process.env.ANDROID_HOME || join(root, ".tools/android-sdk");
const java = process.env.JAVA_HOME || "/usr/lib/jvm/java-21-openjdk-amd64";
const ndkRoot = join(sdk, "ndk");
const ndks = existsSync(ndkRoot) ? readdirSync(ndkRoot).filter(name => existsSync(join(ndkRoot, name, "source.properties"))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
const ndk = process.env.NDK_HOME || (ndks.length ? join(ndkRoot, ndks.at(-1)) : "");
const cli = join(root, "omni/node_modules/.bin/tauri");
const mode = process.argv[2] || "doctor";
const commands = {
  init: ["android", "init", "--ci", "--skip-targets-install"],
  dev: ["android", "dev"],
  build: ["android", "build", "--debug", "--apk", "--target", "aarch64"],
  emulator: ["android", "build", "--debug", "--apk", "--target", "x86_64"],
};
if (mode !== "doctor" && !commands[mode]) throw new Error(`未知命令：${mode}`);

const rust = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
const targets = rust.stdout?.trim().split(/\s+/) || [];
const target = mode === "emulator" ? "x86_64-linux-android" : "aarch64-linux-android";
const checks = [
  ["Tauri CLI", existsSync(cli), cli],
  ["JDK", existsSync(join(java, "bin/java")), java],
  ["Android SDK / adb", existsSync(join(sdk, "platform-tools/adb")), sdk],
  ["Android NDK", !!ndk && existsSync(join(ndk, "source.properties")), ndk || "未安装；需 NDK_HOME"],
  ["Rust Android target", targets.includes(target), target],
];
for (const [label, ok, detail] of checks) console.log(`${ok ? "OK" : "MISSING"}  ${label}: ${detail}`);
console.log(`Android Emulator: ${existsSync(join(sdk, "emulator/emulator")) ? "已安装，AVD 需另行配置" : "未安装，浏览器调试不依赖它"}`);
if (checks.some(([, ok]) => !ok)) {
  console.error("原生工具链尚不完整。浏览器入口仍可使用 npm run dev:omni；本脚本不会安装 SDK、NDK 或 Rust target。");
  process.exit(1);
}
if (mode === "doctor") process.exit(0);
if (mode !== "init" && !existsSync(join(root, "omni/src-tauri/gen/android/gradlew"))) {
  console.error("尚未生成 Android 工程，请先执行 npm --prefix omni run android:init。");
  process.exit(1);
}
// 工程生成后补入 Debug source set；遇到已有自定义文件时停止，不覆盖用户配置。
function prepareDebugNetwork() {
  prepareNetworkOverlay("debug");
  prepareNetworkOverlay("main");
}
function prepareNetworkOverlay(sourceSet) {
  const source = join(root, `omni/android/${sourceSet}`);
  const destination = join(root, `omni/src-tauri/gen/android/app/src/${sourceSet}`);
  const files = ["AndroidManifest.xml", "res/xml/omni_network_security_config.xml"];
  for (const file of files) {
    const targetFile = join(destination, file);
    if (existsSync(targetFile) && readFileSync(targetFile, "utf8") !== readFileSync(join(source, file), "utf8")) {
      throw new Error(`Android Debug 配置已自定义，请先合并 OMNI 网络配置：${targetFile}`);
    }
  }
  for (const file of files) {
    const targetFile = join(destination, file);
    if (existsSync(targetFile)) continue;
    mkdirSync(dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, readFileSync(join(source, file)), { flag: "wx" });
  }
}
if (mode !== "init") prepareDebugNetwork();
// 仅作用于本次子进程，不修改 shell 配置或系统默认 Java。
const result = spawnSync(cli, [...commands[mode], ...process.argv.slice(3)], {
  cwd: join(root, "omni"), stdio: "inherit",
  env: { ...process.env, JAVA_HOME: java, ANDROID_HOME: sdk, NDK_HOME: ndk,
    PATH: `${join(java, "bin")}:${dirname(cli)}:${process.env.PATH || ""}` },
});
if (result.status === 0 && mode === "init") prepareDebugNetwork();
process.exit(result.status ?? 1);
