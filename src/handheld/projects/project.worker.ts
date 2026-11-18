import { parsePcd } from "../../domain/pcd";

self.onmessage = async (event: MessageEvent<{ blob: Blob; id: string; expectedSha?: string; maxPoints?: number | null }>) => {
  try {
    const { blob, id, expectedSha, maxPoints = 1_000_000 } = event.data;
    if (blob.size > 512 * 1024 * 1024) throw new Error("文件过大，请在电脑中打开");
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    if (expectedSha && expectedSha !== sha256) throw new Error("文件校验失败，请重新下载");
    // 本机成果默认显示 100 万点；null 表示用户选择全量，原始文件始终完整缓存。
    const cloud = parsePcd(buffer, id, { maxPoints: maxPoints ?? undefined });
    for (let i = 0; i < cloud.visible.length; i++) {
      if (![cloud.positions[i * 3], cloud.positions[i * 3 + 1], cloud.positions[i * 3 + 2]].every(Number.isFinite)) cloud.visible[i] = 0;
    }
    const transfer = [cloud.positions.buffer, cloud.colors.buffer, cloud.visible.buffer];
    if (cloud.intensities) transfer.push(cloud.intensities.buffer);
    if (cloud.sourcePointIndices) transfer.push(cloud.sourcePointIndices.buffer);
    self.postMessage({ cloud, sha256 }, { transfer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "点云读取失败" });
  }
};
