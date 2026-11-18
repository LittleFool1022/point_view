interface TauriRuntime {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
}

const nativeRuntime = () => (window as Window & { __TAURI__?: TauriRuntime }).__TAURI__;

/** 小型演示文本的双端适配。设备连接和大文件传输不经此接口。 */
export async function exportDemoText(name: string, content: string, type: string): Promise<string> {
  const native = nativeRuntime();
  if (native) {
    const destination = await native.core.invoke<string>("save_demo_text", { name, content });
    return `已保存到应用私有目录：${destination}`;
  }
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  return "已发起浏览器下载";
}
