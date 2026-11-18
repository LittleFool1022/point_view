import { del, get, set, values, type UseStore } from "idb-keyval";
import type { PointCloudData, ProjectManifest } from "../domain/types";

const DATABASE_NAME = "point-view";
const STORE_NAMES = ["projects", "clouds"] as const;
let databasePromise: Promise<IDBDatabase> | undefined;

/**
 * idb-keyval 的 createStore 无法给同一个数据库补建第二个 object store。
 * 这里统一完成数据库升级，兼容已经只创建 projects 或 clouds 的旧版本。
 */
function openProjectDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const initial = indexedDB.open(DATABASE_NAME);
    initial.onupgradeneeded = () => {
      for (const name of STORE_NAMES) {
        if (!initial.result.objectStoreNames.contains(name)) initial.result.createObjectStore(name);
      }
    };
    initial.onerror = () => reject(initial.error);
    initial.onsuccess = () => {
      const current = initial.result;
      const missing = STORE_NAMES.filter((name) => !current.objectStoreNames.contains(name));
      if (missing.length === 0) {
        current.onversionchange = () => current.close();
        resolve(current);
        return;
      }

      const nextVersion = current.version + 1;
      current.close();
      const upgrade = indexedDB.open(DATABASE_NAME, nextVersion);
      upgrade.onupgradeneeded = () => {
        for (const name of STORE_NAMES) {
          if (!upgrade.result.objectStoreNames.contains(name)) upgrade.result.createObjectStore(name);
        }
      };
      upgrade.onerror = () => reject(upgrade.error);
      upgrade.onsuccess = () => {
        upgrade.result.onversionchange = () => upgrade.result.close();
        resolve(upgrade.result);
      };
    };
  });
  databasePromise.catch(() => { databasePromise = undefined; });
  return databasePromise;
}

function useStore(storeName: typeof STORE_NAMES[number]): UseStore {
  return async (mode, callback) => {
    const database = await openProjectDatabase();
    return callback(database.transaction(storeName, mode).objectStore(storeName));
  };
}

const projectStore = useStore("projects");
const cloudStore = useStore("clouds");

export async function saveProject(manifest: ProjectManifest): Promise<void> {
  await set(manifest.id, { ...manifest, updatedAt: new Date().toISOString() }, projectStore);
}

export async function saveProjectCloud(projectId: string, cloud: PointCloudData): Promise<void> {
  await set(projectId, cloud, cloudStore);
}

export async function loadProjectCloud(projectId: string): Promise<PointCloudData | undefined> {
  return get<PointCloudData>(projectId, cloudStore);
}

export async function loadProject(id: string): Promise<ProjectManifest | undefined> {
  return get<ProjectManifest>(id, projectStore);
}

export async function listProjects(): Promise<ProjectManifest[]> {
  const projects = await values<ProjectManifest>(projectStore);
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteProject(id: string): Promise<void> {
  await Promise.all([del(id, projectStore), del(id, cloudStore)]);
}
