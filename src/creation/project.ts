import { strFromU8, strToU8, unzip, zip } from "fflate";
import { parseCapture, sha256 } from "./capture";
import type { ObjectAsset } from "./types";

const LIMIT = 512 * 1024 * 1024;
const ARRAY_TYPES = { Float32Array, Uint32Array, Uint8Array };

/** 制作工程保存可编辑源数据；GLB 只承担最终模型交付。 */
export async function exportObjectProject(asset: ObjectAsset): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  let total = 0, entryId = 0;
  async function encode(value: unknown): Promise<unknown> {
    if (value === undefined) return undefined;
    if (typeof value === "bigint") return { $bigint: value.toString() };
    if (value instanceof Blob || ArrayBuffer.isView(value)) {
      const size = value instanceof Blob ? value.size : value.byteLength;
      if ((total += size) > LIMIT) throw new Error("当前制作工程上限为 512 MiB，请减少素材后保存。");
      const name = `data/${entryId++}`;
      const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      entries[name] = bytes;
      return { $binary: name, kind: value instanceof Blob ? "Blob" : value.constructor.name, mime: value instanceof Blob ? value.type : undefined };
    }
    if (Array.isArray(value)) return Promise.all(value.map(encode));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) result[key] = await encode(item);
      return result;
    }
    return value;
  }
  const encoded = await encode(asset);
  const hashes: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(entries)) hashes[name] = await sha256(new Blob([bytes]));
  entries["project.json"] = strToU8(JSON.stringify({ format: "point-view-object", version: 1, asset: encoded, hashes }));
  if (entries["project.json"].length > 8 * 1024 * 1024 || total + entries["project.json"].length > LIMIT) throw new Error("制作工程超过容量上限。");
  return new Promise((resolve, reject) => zip(entries, { level: 0 }, (error, data) => error ? reject(error) : data.length > LIMIT ? reject(new Error("制作工程超过 512 MiB 上限。")) : resolve(data)));
}

export async function importObjectProject(file: File): Promise<ObjectAsset> {
  if (file.size > LIMIT) throw new Error("制作工程超过 512 MiB 上限。");
  let expanded = 0, oversized = false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(bytes, {
    filter: entry => {
      expanded += entry.originalSize;
      if (expanded > LIMIT || (entry.name === "project.json" && entry.originalSize > 8 * 1024 * 1024)) oversized = true;
      return !oversized && (entry.name === "project.json" || /^data\/[0-9]+$/.test(entry.name));
    },
  }, (error, data) => error ? reject(error) : resolve(data)));
  if (oversized || !entries["project.json"]) throw new Error("工程数据不完整或解压后超过容量上限。");
  const root = JSON.parse(strFromU8(entries["project.json"]));
  if (root.format !== "point-view-object" || root.version !== 1 || !root.hashes || typeof root.hashes !== "object") throw new Error("不支持的制作工程版本。");
  for (const [name, data] of Object.entries(entries)) {
    if (name !== "project.json" && await sha256(new Blob([data])) !== root.hashes[name]) throw new Error(`工程数据校验失败：${name}`);
  }
  function decode(value: unknown, depth = 0): unknown {
    if (depth > 40) throw new Error("工程结构层级过深。");
    if (Array.isArray(value)) return value.map(item => decode(item, depth + 1));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if ("$bigint" in record) {
      if (typeof record.$bigint !== "string" || !/^[0-9]{1,30}$/.test(record.$bigint)) throw new Error("工程时间戳无效。");
      return BigInt(record.$bigint);
    }
    if ("$binary" in record) {
      if (typeof record.$binary !== "string" || !/^data\/[0-9]+$/.test(record.$binary)) throw new Error("工程数据引用无效。");
      const data = entries[record.$binary];
      if (!data) throw new Error("工程数据缺失。");
      if (record.kind === "Blob") return new Blob([data], { type: typeof record.mime === "string" ? record.mime : "" });
      if (typeof record.kind !== "string" || !Object.hasOwn(ARRAY_TYPES, record.kind)) throw new Error("不支持的工程数组。");
      const Constructor = ARRAY_TYPES[record.kind as keyof typeof ARRAY_TYPES];
      return new Constructor(data.slice().buffer);
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decode(item, depth + 1)]));
  }
  const asset = decode(root.asset) as ObjectAsset;
  const finiteVector = (value: unknown, n: number) => Array.isArray(value) && value.length === n && value.every(v => typeof v === "number" && Number.isFinite(v));
  if (!asset || asset.version !== 1 || typeof asset.id !== "string" || !asset.id || typeof asset.name !== "string"
    || typeof asset.createdAt !== "string" || !Number.isFinite(Date.parse(asset.createdAt))
    || !asset.source || typeof asset.source.id !== "string" || typeof asset.source.name !== "string"
    || !finiteVector(asset.origin, 3) || !(asset.metersPerUnit > 0) || !Number.isFinite(asset.metersPerUnit)
    || !["original", "plaster", "metal", "ceramic"].includes(asset.material)) throw new Error("制作工程资产信息无效。");
  const c = asset.cloud;
  if (!c || !(c.positions instanceof Float32Array) || !(c.colors instanceof Uint8Array) || !(c.visible instanceof Uint8Array)
    || typeof c.stampNs !== "bigint" || typeof c.id !== "string" || typeof c.frameId !== "string"
    || c.positions.length !== c.visible.length * 3 || c.colors.length !== c.positions.length || c.visible.length < 3
    || !c.positions.every(Number.isFinite) || !(asset.sourceIndices instanceof Uint32Array) || asset.sourceIndices.length !== c.visible.length
    || (c.intensities !== undefined && (!(c.intensities instanceof Float32Array) || c.intensities.length !== c.visible.length))) throw new Error("制作工程点云数据无效。");
  if (asset.mesh) {
    const m = asset.mesh;
    if (!(m.positions instanceof Float32Array) || !(m.normals instanceof Float32Array) || !(m.colors instanceof Uint8Array)
      || !(m.indices instanceof Uint32Array) || !m.indices.length || m.indices.length % 3 || m.positions.length % 3
      || m.positions.length !== m.normals.length || m.colors.length !== m.positions.length
      || !m.positions.every(Number.isFinite) || !m.normals.every(Number.isFinite)
      || m.indices.some(i => i >= m.positions.length / 3) || !m.report || !Array.isArray(m.report.warnings)
      || !m.report.warnings.every(v => typeof v === "string")
      || !["bpa", "poisson"].includes(m.report.method)
      || ![m.report.triangles, m.report.vertices, m.report.boundaryEdges, m.report.components].every(v => Number.isInteger(v) && v >= 0)) throw new Error("制作工程网格数据无效。");
  }
  if (asset.capture) {
    const capture = asset.capture;
    capture.manifest = parseCapture(capture.manifest);
    capture.alignment = "unverified";
    capture.association = "project_reference";
    if (!capture.images || capture.manifest.pcd.name !== asset.source.name.split(/[\\/]/).at(-1)) throw new Error("工程图片与点云来源不符。");
    let imageBytes = 0;
    const images: Record<string, Blob> = {};
    for (const view of capture.manifest.views) {
      const image = capture.images[view.image];
      if (!(image instanceof Blob) || image.size > 16 * 1024 * 1024 || (imageBytes += image.size) > 256 * 1024 * 1024
        || await sha256(image) !== view.sha256) throw new Error("工程原图缺失或校验失败。");
      const bitmap = await createImageBitmap(image);
      const matches = bitmap.width === capture.manifest.calibration.width && bitmap.height === capture.manifest.calibration.height;
      bitmap.close();
      if (!matches) throw new Error("工程原图尺寸与标定不符。");
      images[view.image] = image;
    }
    capture.images = images;
  }
  // 工程携带局部点云与来源声明，不能重新证明未携带的整份原始 PCD。
  return asset;
}
