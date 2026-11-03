import type { PointCloudData } from "./types";

const textDecoder = new TextDecoder("ascii");

/** 解析未压缩 LAS 1.0-1.3 的常用点格式；LAZ 必须由桌面转换工具解压。 */
export function parseLas(buffer: ArrayBuffer, id: string = crypto.randomUUID()): PointCloudData {
  const bytes = new Uint8Array(buffer);
  if (textDecoder.decode(bytes.subarray(0, 4)) !== "LASF") throw new Error("不是有效的 LAS 文件");
  const view = new DataView(buffer);
  const pointOffset = view.getUint32(96, true);
  const formatByte = view.getUint8(104);
  if ((formatByte & 0x80) !== 0) throw new Error("检测到 LAZ 压缩数据，请在 Windows 工作站解压为 LAS 后导入");
  const format = formatByte & 0x3f;
  if (format > 3) throw new Error(`暂不支持 LAS point format ${format}，请转换为 format 2/3`);
  const stride = view.getUint16(105, true);
  const count = view.getUint32(107, true);
  const required = pointOffset + count * stride;
  if (required > bytes.byteLength) throw new Error("LAS 点记录被截断或文件使用了未声明的压缩");
  const scale = [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)];
  const offset = [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)];
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const intensities = new Float32Array(count);
  const rgbOffset = format === 2 ? 20 : format === 3 ? 28 : -1;
  for (let i = 0; i < count; i++) {
    const src = pointOffset + i * stride;
    const dst = i * 3;
    positions[dst] = view.getInt32(src, true) * scale[0]! + offset[0]!;
    positions[dst + 1] = view.getInt32(src + 4, true) * scale[1]! + offset[1]!;
    positions[dst + 2] = view.getInt32(src + 8, true) * scale[2]! + offset[2]!;
    intensities[i] = view.getUint16(src + 12, true);
    if (rgbOffset >= 0 && rgbOffset + 6 <= stride) {
      colors[dst] = Math.round(view.getUint16(src + rgbOffset, true) / 257);
      colors[dst + 1] = Math.round(view.getUint16(src + rgbOffset + 2, true) / 257);
      colors[dst + 2] = Math.round(view.getUint16(src + rgbOffset + 4, true) / 257);
    } else colors.set([69, 214, 255], dst);
  }
  return { id, frameId: "camera_init", stampNs: 0n, positions, colors, intensities, visible: new Uint8Array(count).fill(1) };
}

/** LAZ 按需加载 laz-perf WASM，避免普通点云场景承担解码器体积。 */
export async function parseLasOrLaz(buffer: ArrayBuffer, id: string = crypto.randomUUID()): Promise<PointCloudData> {
  const formatByte = new DataView(buffer).getUint8(104);
  if ((formatByte & 0x80) === 0) return parseLas(buffer, id);
  const { decodeLazMesh } = await import("./lazLoader");
  const mesh = await decodeLazMesh(buffer);
  const sourcePositions = mesh.attributes.POSITION?.value;
  if (!(sourcePositions instanceof Float32Array) && !(sourcePositions instanceof Float64Array)) throw new Error("LAZ 解码结果缺少 POSITION");
  const positions = sourcePositions instanceof Float32Array ? sourcePositions : Float32Array.from(sourcePositions);
  const sourceColors = mesh.attributes.COLOR_0?.value;
  const count = positions.length / 3;
  const colors = new Uint8Array(count * 3);
  if (sourceColors instanceof Uint8Array) {
    for (let i = 0; i < count; i++) colors.set(sourceColors.subarray(i * 4, i * 4 + 3), i * 3);
  } else {
    for (let i = 0; i < count; i++) colors.set([69, 214, 255], i * 3);
  }
  const sourceIntensity = mesh.attributes.intensity?.value;
  const intensities = sourceIntensity ? Float32Array.from(sourceIntensity as ArrayLike<number>) : undefined;
  return { id, frameId: "camera_init", stampNs: 0n, positions, colors, intensities, visible: new Uint8Array(count).fill(1) };
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string) {
  target.set(new TextEncoder().encode(value.slice(0, length)), offset);
}

export function exportLas(cloud: PointCloudData): Uint8Array {
  const indices = Array.from(cloud.visible.keys()).filter((index) => cloud.visible[index]);
  if (!indices.length) throw new Error("没有可导出的可见点");
  const scale = 0.001;
  const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
  for (const point of indices) for (let axis = 0; axis < 3; axis++) {
    const value = cloud.positions[point * 3 + axis]!;
    mins[axis] = Math.min(mins[axis]!, value); maxs[axis] = Math.max(maxs[axis]!, value);
  }
  const headerSize = 227, recordSize = 26;
  const output = new Uint8Array(headerSize + indices.length * recordSize);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, 4, "LASF");
  view.setUint16(24, 1, true); view.setUint16(25, 2, true);
  writeAscii(output, 26, 32, "POINT VIEW"); writeAscii(output, 58, 32, "Point View WebGL2");
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  view.setUint16(90, Math.floor((now.getTime() - start.getTime()) / 86_400_000), true);
  view.setUint16(92, now.getFullYear(), true);
  view.setUint16(94, headerSize, true); view.setUint32(96, headerSize, true);
  view.setUint32(100, 0, true); view.setUint8(104, 2); view.setUint16(105, recordSize, true);
  view.setUint32(107, indices.length, true); view.setUint32(111, indices.length, true);
  for (let axis = 0; axis < 3; axis++) view.setFloat64(131 + axis * 8, scale, true);
  for (let axis = 0; axis < 3; axis++) view.setFloat64(155 + axis * 8, mins[axis]!, true);
  view.setFloat64(179, maxs[0]!, true); view.setFloat64(187, mins[0]!, true);
  view.setFloat64(195, maxs[1]!, true); view.setFloat64(203, mins[1]!, true);
  view.setFloat64(211, maxs[2]!, true); view.setFloat64(219, mins[2]!, true);
  indices.forEach((point, row) => {
    const dst = headerSize + row * recordSize;
    for (let axis = 0; axis < 3; axis++) view.setInt32(dst + axis * 4, Math.round((cloud.positions[point * 3 + axis]! - mins[axis]!) / scale), true);
    const intensity = cloud.intensities?.[point] ?? 0;
    view.setUint16(dst + 12, intensity <= 1 ? Math.round(intensity * 65535) : Math.min(65535, Math.round(intensity)), true);
    for (let channel = 0; channel < 3; channel++) view.setUint16(dst + 20 + channel * 2, cloud.colors[point * 3 + channel]! * 257, true);
  });
  return output;
}
