import type { PointCloudData } from "../../../src/domain/types";
import { sourceSize, MAX_SOURCE_BYTES, PREVIEW_POINTS, type SourceInput } from "../domain/source";
import { decodeSource, type SourceUnit } from "./analysis";

export interface DecodedSource { cloud: PointCloudData; preview: PointCloudData; bounds: { min: [number, number, number]; max: [number, number, number] } }
export type RangeReader = (offset: number, size: number) => Promise<ArrayBuffer>;
export async function readCloud(source: SourceInput, units: SourceUnit, read: RangeReader, progress: (stage: string) => void): Promise<DecodedSource> {
  const size = sourceSize(source);
  if (!size || size > MAX_SOURCE_BYTES) throw Error("源文件为空或超过 2 GiB 文件容量。");
  const head = new Uint8Array(await read(0, Math.min(32768, size)));
  // 逐行定位 DATA 的换行字节；载荷中的 0x0A/0x0D/空格均属于首点数据。
  let headerLength = 0, binary = false, lineStart = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== 10) continue;
    const line = new TextDecoder().decode(head.subarray(lineStart, i)).trim();
    lineStart = i + 1;
    const dataLine = /^DATA[\t ]+(\S+)[\t ]*$/i.exec(line);
    if (dataLine) { headerLength = lineStart; binary = dataLine[1]!.toLowerCase() === 'binary'; break; }
  }
  let cloud: PointCloudData;
  if (/\.pcd$/i.test(source.name) && binary) {
    const rows = new Map<string, string[]>();
    for (const line of new TextDecoder().decode(head.subarray(0, headerLength)).split(/\r?\n/)) {
      const row = line.trim().split(/\s+/); if (row[0] && !row[0].startsWith("#")) rows.set(row[0].toUpperCase(), row.slice(1));
    }
    const fields = rows.get("FIELDS") ?? [], widths = (rows.get("SIZE") ?? []).map(Number), types = rows.get("TYPE") ?? [], counts = (rows.get("COUNT") ?? fields.map(() => "1")).map(Number);
    const count = Number(rows.get("POINTS")?.[0]);
    if (!Number.isSafeInteger(count) || count < 1 || count > 50_000_000) throw Error("当前 binary PCD 支持不超过 5000 万点；实际验收基准为 2000 万点。");
    if (fields.length !== widths.length || fields.length !== types.length || fields.length !== counts.length || !widths.every(w => [1, 2, 4, 8].includes(w)) || !counts.every(c => Number.isSafeInteger(c) && c > 0)) throw Error("PCD 字段声明无效。");
    const offsets: number[] = []; let stride = 0;
    for (let i = 0; i < fields.length; i++) { offsets.push(stride); stride += widths[i]! * counts[i]!; }
    if (!stride || headerLength + count * stride > size) throw Error("PCD binary 载荷不完整。");
    const xyz = ["x", "y", "z"].map(f => fields.indexOf(f));
    if (xyz.some(i => i < 0 || counts[i] !== 1 || !["F", "I", "U"].includes(types[i]!))) throw Error("PCD 缺少有效 x/y/z。");
    const rgb = Math.max(fields.indexOf("rgb"), fields.indexOf("rgba")), separate = ["r", "g", "b"].map(f => fields.indexOf(f));
    if (rgb >= 0 && widths[rgb] !== 4) throw Error("PCD packed RGB 必须是 4 字节。");
    const positions = new Float32Array(count * 3), colors = new Uint8Array(count * 3), visible = new Uint8Array(count).fill(1), scale = units === "mm" ? .001 : 1;
    const perChunk = Math.max(1, Math.floor((8 * 1024 ** 2) / stride));
    const scalar = (view: DataView, base: number, field: number) => {
      const o = base + offsets[field]!, w = widths[field]!, t = types[field];
      if (t === "F") return w === 8 ? view.getFloat64(o, true) : w === 4 ? view.getFloat32(o, true) : NaN;
      if (t === "I") return w === 1 ? view.getInt8(o) : w === 2 ? view.getInt16(o, true) : w === 4 ? view.getInt32(o, true) : NaN;
      return w === 1 ? view.getUint8(o) : w === 2 ? view.getUint16(o, true) : w === 4 ? view.getUint32(o, true) : NaN;
    };
    for (let start = 0; start < count; start += perChunk) {
      const n = Math.min(perChunk, count - start), block = await read(headerLength + start * stride, n * stride), view = new DataView(block);
      if (block.byteLength !== n * stride) throw Error("PCD 分块数据不完整。");
      for (let j = 0; j < n; j++) {
        const target = (start + j) * 3, base = j * stride;
        for (let axis = 0; axis < 3; axis++) { const value = scalar(view, base, xyz[axis]!) * scale; if (!Number.isFinite(value)) throw Error(`第 ${start + j + 1} 点坐标无效。`); positions[target + axis] = value; }
        if (rgb >= 0) { const packed = view.getUint32(base + offsets[rgb]!, true); colors[target] = (packed >>> 16) & 255; colors[target + 1] = (packed >>> 8) & 255; colors[target + 2] = packed & 255; }
        else if (separate.every(i => i >= 0)) for (let k = 0; k < 3; k++) colors[target + k] = scalar(view, base, separate[k]!);
        else colors.set([69, 214, 255], target);
      }
      progress(`读取完整点云 ${Math.floor((start + n) / count * 100)}%`);
    }
    cloud = { id: crypto.randomUUID(), frameId: "source", stampNs: 0n, sourcePointCount: count, positions, colors, visible, attributes: { hasColor: rgb >= 0 || separate.every(i => i >= 0), hasIntensity: false } };
  } else {
    if (size > 256 * 1024 ** 2) throw Error("本阶段大文件采用 binary PCD 流式读取；其他格式请先转换为 binary PCD。");
    // 兼容原有小文件格式；不进入大文件的整文件路径。
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < size; offset += 8 * 1024 ** 2) chunks.push(new Uint8Array(await read(offset, Math.min(8 * 1024 ** 2, size - offset))));
    const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
    cloud = await decodeSource(source.name, bytes.buffer, units);
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < cloud.positions.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis]!, cloud.positions[i]!); max[axis] = Math.max(max[axis]!, cloud.positions[i]!); }
  return { cloud, preview: makePreview(cloud), bounds: { min, max } };
}
export function makePreview(cloud: PointCloudData): PointCloudData {
  const count = Math.min(PREVIEW_POINTS, cloud.visible.length), positions = new Float32Array(count * 3), colors = new Uint8Array(count * 3), indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) { const index = count === 1 ? 0 : Math.floor(i * (cloud.visible.length - 1) / (count - 1)); positions.set(cloud.positions.subarray(index * 3, index * 3 + 3), i * 3); colors.set(cloud.colors.subarray(index * 3, index * 3 + 3), i * 3); indices[i] = index; }
  return { ...cloud, positions, colors, visible: new Uint8Array(count).fill(1), sourcePointCount: cloud.visible.length, sourcePointIndices: indices, intensities: undefined };
}
