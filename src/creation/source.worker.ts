import { parsePcd } from "../domain/pcd";
import { applyEdit } from "../domain/edits";
import type { EditOperation } from "../domain/types";

self.onmessage = async (event: MessageEvent<{ blob: Blob; id: string; edits: EditOperation[]; sourceIndices?: Uint32Array }>) => {
  try {
    const { blob, id, edits, sourceIndices } = event.data;
    let cloud = parsePcd(await blob.arrayBuffer(), id);
    // 已有编辑只作用于被明确编辑的源点，不向未显示的相邻点推断修改。
    for (const edit of edits) cloud = applyEdit(cloud, { ...edit, indices: edit.indices.map(i => sourceIndices?.[i] ?? i) });
    const transfers: Transferable[] = [cloud.positions.buffer, cloud.colors.buffer, cloud.visible.buffer];
    if (cloud.intensities) transfers.push(cloud.intensities.buffer);
    self.postMessage({ cloud }, { transfer: transfers });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
