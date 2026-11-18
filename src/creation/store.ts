import { createStore, get, set, setMany, keys } from "idb-keyval";
import type { ObjectAsset } from "./types";
import type { EditOperation, PointCloudData } from "../domain/types";
// 独立资产库，不升级或覆盖现有工程数据库。
const store = createStore("point-view-objects", "objects");
const drafts = createStore("point-view-object-drafts", "drafts");
export interface StudioDraft {
  id: string;
  updatedAt: string;
  sourceName: string;
  sourceEdits?: EditOperation[];
  cloud: PointCloudData;
  selection: number[];
  asset?: ObjectAsset;
}
// 串行写入，避免较早的草稿覆盖后续编辑；失败后允许下一次重试。
let draftWrite: Promise<void> = Promise.resolve();
const cloudKeys = new WeakMap<PointCloudData, string>();
type StoredDraft = Omit<StudioDraft, "cloud"> & { cloudKey: string };
export function saveDraft(draft: StudioDraft) {
  draftWrite = draftWrite.catch(() => {}).then(async () => {
    const existing = cloudKeys.get(draft.cloud);
    const cloudKey = existing ?? `source:${crypto.randomUUID()}`;
    const { cloud, ...state } = draft;
    const entries: [IDBValidKey, unknown][] = [
      [`draft:${draft.id}`, { ...state, cloudKey }],
      [`summary:${draft.id}`, { id: draft.id, sourceName: draft.asset?.name ?? draft.sourceName, updatedAt: draft.updatedAt }],
    ];
    // 完整场景只写一次；修改作品名称时不反复复制整个扫描。
    if (!existing) entries.push([cloudKey, cloud]);
    await setMany(entries, drafts);
    cloudKeys.set(cloud, cloudKey);
  });
  return draftWrite;
}
export async function loadDraft(id: string): Promise<StudioDraft | undefined> {
  const state = await get<StoredDraft>(`draft:${id}`, drafts);
  if (!state) return undefined;
  const cloud = await get<PointCloudData>(state.cloudKey, drafts);
  if (!cloud) throw new Error("草稿的扫描数据缺失。");
  cloudKeys.set(cloud, state.cloudKey);
  const { cloudKey: _, ...rest } = state;
  return { ...rest, cloud };
}
export async function listDrafts() {
  const result: Array<Pick<StudioDraft, "id" | "sourceName" | "updatedAt">> = [];
  for (const key of await keys<string>(drafts)) {
    if (!key.startsWith("summary:")) continue;
    const summary = await get<(typeof result)[number]>(key, drafts);
    if (summary) result.push(summary);
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export const saveObject = (asset: ObjectAsset) => set(asset.id, asset, store);
export const loadObject = (id: string) => get<ObjectAsset>(id, store);
export async function listObjects(): Promise<Array<Pick<ObjectAsset, "id" | "name" | "createdAt" | "thumbnail">>> {
  const result = [];
  for (const key of await keys<string>(store)) {
    const asset = await get<ObjectAsset>(key, store);
    if (asset) result.push({ id: asset.id, name: asset.name, createdAt: asset.createdAt, thumbnail: asset.thumbnail });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
