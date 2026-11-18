import { MAX_SOURCE_BYTES, type OpenedInput } from "./domain/source";
export async function openFile(kind: "cloud" | "project" | "frames"): Promise<OpenedInput | undefined> {
  if (window.surveyDesktop) return window.surveyDesktop.open(kind);
  return new Promise<OpenedInput | undefined>((resolve, reject) => {
    const input = document.createElement("input"); input.type = "file";
    input.accept = kind === "project" ? ".pvplan" : kind === "frames" ? ".pvframes" : ".pcd,.ply,.las,.laz";
    input.hidden = true; document.body.append(input);
    input.onchange = () => { try { const file = input.files?.[0]; if (file && file.size > MAX_SOURCE_BYTES) throw Error("当前文件容量上限为 2 GiB。"); resolve(file ? { name: file.name, file } : undefined); } catch (e) { reject(e); } finally { input.remove(); } };
    input.addEventListener("cancel", () => { input.remove(); resolve(undefined); }, { once: true }); input.click();
  });
}
export async function saveFile(name: string, bytes: Uint8Array) {
  if (window.surveyDesktop) return window.surveyDesktop.save(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
}
