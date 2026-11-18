import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";

export interface OpenedFile { name: string; data: ArrayBuffer }
export interface DirectoryFile { relativePath: string; data: Uint8Array }

const POINT_CLOUD_EXTENSIONS = [".pcd", ".ply", ".las", ".laz", ".mcap"];

export function pointCloudImportLimit(): number {
  return Capacitor.isNativePlatform() ? 1_000_000 : 4_000_000;
}

export async function openPointCloudFile(): Promise<OpenedFile | undefined> {
  if (window.pointViewDesktop) {
    return window.pointViewDesktop.openFile([
      { name: "点云", extensions: ["pcd", "ply", "las", "laz"] },
      { name: "记录", extensions: ["mcap"] },
    ]);
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    // Android 的 DocumentsUI 不认识 PCD MIME，按扩展名过滤会让文件直接消失。
    input.accept = Capacitor.isNativePlatform() ? "*/*" : POINT_CLOUD_EXTENSIONS.join(",");
    input.style.display = "none";
    document.body.append(input);
    const finish = () => input.remove();
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { finish(); resolve(undefined); return; }
      if (!POINT_CLOUD_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension))) {
        finish(); reject(new Error(`不支持该文件格式：${file.name}`)); return;
      }
      try {
        const data = await file.arrayBuffer();
        finish(); resolve({ name: file.name, data });
      } catch (error) {
        finish(); reject(error);
      }
    };
    input.addEventListener("cancel", () => { finish(); resolve(undefined); }, { once: true });
    input.click();
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) output += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(output);
}

export async function saveBinaryFile(name: string, bytes: Uint8Array, mime = "application/octet-stream"): Promise<boolean> {
  if (window.pointViewDesktop) {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return window.pointViewDesktop.saveFile(name, data);
  }
  if (Capacitor.isNativePlatform()) {
    await Filesystem.writeFile({ path: `PointView/${name}`, data: bytesToBase64(bytes), directory: Directory.Documents, recursive: true });
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return true;
}

export async function saveTextFile(name: string, text: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    await Filesystem.writeFile({ path: `PointView/${name}`, data: text, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
    return true;
  }
  return saveBinaryFile(name, new TextEncoder().encode(text), "application/json");
}

export async function openColmapDirectory(): Promise<DirectoryFile[] | undefined> {
  if (window.pointViewDesktop) {
    const files = await window.pointViewDesktop.openColmapDirectory();
    return files?.map((file) => ({ relativePath: file.relativePath, data: new Uint8Array(file.data) }));
  }
  if (Capacitor.isNativePlatform()) throw new Error("完整 3DGS 数据集打包请在 Windows 桌面端执行");
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.webkitdirectory = true;
    input.onchange = async () => {
      const selected = [...(input.files ?? [])];
      resolve(await Promise.all(selected.map(async (file) => ({ relativePath: file.webkitRelativePath || file.name, data: new Uint8Array(await file.arrayBuffer()) }))));
    };
    input.click();
  });
}
