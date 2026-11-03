import type { PointCloudData } from "./types";

interface PcdHeader {
  fields: string[];
  size: number[];
  type: string[];
  count: number[];
  points: number;
  data: "ascii" | "binary" | "binary_compressed";
  dataOffset: number;
}

export interface PcdParseOptions {
  maxPoints?: number;
}

interface CompressedCapture {
  field: number;
  start: number;
  end: number;
  pointStride: number;
  valueSize: number;
  selectedCursor: number;
  bytes: Uint8Array;
}

function parseHeader(bytes: Uint8Array): PcdHeader {
  const probe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 32_768)));
  const match = /(^|\n)DATA\s+(ascii|binary|binary_compressed)\s*\r?\n/i.exec(probe);
  if (!match || match.index === undefined) throw new Error("不是有效的 PCD：缺少 DATA 行");
  const end = match.index + match[0].length;
  const text = probe.slice(0, end);
  const rows = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const [key, ...values] = clean.split(/\s+/);
    rows.set(key!.toUpperCase(), values);
  }
  const fields = rows.get("FIELDS") ?? rows.get("FIELD") ?? [];
  const size = (rows.get("SIZE") ?? []).map(Number);
  const type = rows.get("TYPE") ?? [];
  const count = (rows.get("COUNT") ?? fields.map(() => "1")).map(Number);
  const points = Number(rows.get("POINTS")?.[0] ?? Number(rows.get("WIDTH")?.[0] ?? 0) * Number(rows.get("HEIGHT")?.[0] ?? 1));
  return { fields, size, type, count, points, data: match[2]!.toLowerCase() as PcdHeader["data"], dataOffset: new TextEncoder().encode(text).length };
}

function packedColor(value: number): [number, number, number] {
  const packed = value >>> 0;
  return [(packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255];
}

function selectedPointIndices(pointCount: number, maxPoints?: number): Uint32Array {
  const limit = maxPoints === undefined || !Number.isFinite(maxPoints)
    ? pointCount
    : Math.max(1, Math.floor(maxPoints));
  const selectedCount = Math.min(pointCount, limit);
  const selected = new Uint32Array(selectedCount);
  if (selectedCount === pointCount) {
    for (let i = 0; i < selectedCount; i++) selected[i] = i;
  } else if (selectedCount === 1) {
    selected[0] = 0;
  } else {
    // 均匀保留首尾，避免移动端只加载轨迹开头的一小段。
    for (let i = 0; i < selectedCount; i++) {
      selected[i] = Math.floor((i * (pointCount - 1)) / (selectedCount - 1));
    }
  }
  return selected;
}

function readScalar(view: DataView, offset: number, size: number, type: string): number {
  if (type === "F") return size === 8 ? view.getFloat64(offset, true) : view.getFloat32(offset, true);
  if (type === "I") return size === 1 ? view.getInt8(offset) : size === 2 ? view.getInt16(offset, true) : view.getInt32(offset, true);
  return size === 1 ? view.getUint8(offset) : size === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
}

function captureCompressedFields(
  buffer: ArrayBuffer,
  header: PcdHeader,
  selected: Uint32Array,
  requiredFields: number[],
): Map<number, Uint8Array> {
  if (header.dataOffset + 8 > buffer.byteLength) throw new Error("PCD binary_compressed 缺少尺寸字段");
  const sizesView = new DataView(buffer, header.dataOffset, 8);
  const compressedSize = sizesView.getUint32(0, true);
  const uncompressedSize = sizesView.getUint32(4, true);
  const payloadOffset = header.dataOffset + 8;
  if (payloadOffset + compressedSize > buffer.byteLength) throw new Error("PCD binary_compressed 数据不完整");
  const compressed = new Uint8Array(buffer, payloadOffset, compressedSize);

  const required = new Set(requiredFields.filter((field) => field >= 0));
  const captures: CompressedCapture[] = [];
  let fieldStart = 0;
  for (let field = 0; field < header.fields.length; field++) {
    const valueSize = header.size[field] ?? 4;
    const pointStride = valueSize * (header.count[field] ?? 1);
    const fieldEnd = fieldStart + header.points * pointStride;
    if (required.has(field)) {
      captures.push({
        field,
        start: fieldStart,
        end: fieldEnd,
        pointStride,
        valueSize,
        selectedCursor: 0,
        bytes: new Uint8Array(selected.length * valueSize),
      });
    }
    fieldStart = fieldEnd;
  }
  if (fieldStart !== uncompressedSize) {
    throw new Error(`PCD 解压尺寸与字段定义不一致：${uncompressedSize} != ${fieldStart}`);
  }

  // LZF 最大回溯距离为 8192 字节，只保留环形历史窗口；不在手机上展开整份点云。
  const history = new Uint8Array(8192);
  let input = 0;
  let output = 0;
  let activeCapture = 0;
  const emit = (value: number) => {
    history[output & 8191] = value;
    while (activeCapture < captures.length && output >= captures[activeCapture]!.end) activeCapture++;
    const capture = captures[activeCapture];
    if (capture && output >= capture.start && capture.selectedCursor < selected.length) {
      const expectedStart = capture.start + selected[capture.selectedCursor]! * capture.pointStride;
      if (output >= expectedStart && output < expectedStart + capture.valueSize) {
        capture.bytes[capture.selectedCursor * capture.valueSize + output - expectedStart] = value;
        if (output + 1 === expectedStart + capture.valueSize) capture.selectedCursor++;
      }
    }
    output++;
  };

  while (input < compressed.length) {
    const control = compressed[input++]!;
    if (control < 32) {
      const length = control + 1;
      if (input + length > compressed.length) throw new Error("PCD LZF literal 越界");
      for (let i = 0; i < length; i++) emit(compressed[input++]!);
      continue;
    }
    let length = control >> 5;
    let reference = output - ((control & 0x1f) << 8) - 1;
    if (length === 7) {
      if (input >= compressed.length) throw new Error("PCD LZF 长度字段缺失");
      length += compressed[input++]!;
    }
    if (input >= compressed.length) throw new Error("PCD LZF 回溯字段缺失");
    reference -= compressed[input++]!;
    length += 2;
    if (reference < 0 || output - reference > history.length) throw new Error("PCD LZF 回溯距离非法");
    for (let i = 0; i < length; i++) {
      const value = history[reference & 8191]!;
      emit(value);
      reference++;
    }
  }
  if (output !== uncompressedSize) throw new Error(`PCD LZF 解压尺寸错误：${output} != ${uncompressedSize}`);
  for (const capture of captures) {
    if (capture.selectedCursor !== selected.length) throw new Error(`PCD 字段 ${header.fields[capture.field]} 采样不完整`);
  }
  return new Map(captures.map((capture) => [capture.field, capture.bytes]));
}

export function parsePcd(
  buffer: ArrayBuffer,
  id: string = crypto.randomUUID(),
  options: PcdParseOptions = {},
): PointCloudData {
  const bytes = new Uint8Array(buffer);
  const header = parseHeader(bytes);
  if (!Number.isSafeInteger(header.points) || header.points <= 0) throw new Error("PCD POINTS 必须是正整数");
  const selected = selectedPointIndices(header.points, options.maxPoints);
  const positions = new Float32Array(selected.length * 3);
  const colors = new Uint8Array(selected.length * 3);
  const intensityField = header.fields.indexOf("intensity");
  const intensities = intensityField >= 0 ? new Float32Array(selected.length) : undefined;
  const xIndex = header.fields.indexOf("x");
  const yIndex = header.fields.indexOf("y");
  const zIndex = header.fields.indexOf("z");
  if (xIndex < 0 || yIndex < 0 || zIndex < 0) throw new Error("PCD 缺少 x/y/z 字段");
  const rgbIndex = Math.max(header.fields.indexOf("rgb"), header.fields.indexOf("rgba"));
  const rIndex = header.fields.indexOf("r");
  const gIndex = header.fields.indexOf("g");
  const bIndex = header.fields.indexOf("b");

  const scalarOffsets: number[] = [];
  const byteOffsets: number[] = [];
  let scalarStride = 0;
  let byteStride = 0;
  for (let field = 0; field < header.fields.length; field++) {
    scalarOffsets.push(scalarStride);
    byteOffsets.push(byteStride);
    scalarStride += header.count[field] ?? 1;
    byteStride += (header.size[field] ?? 4) * (header.count[field] ?? 1);
  }

  if (header.data === "ascii") {
    const rows = new TextDecoder().decode(bytes.subarray(header.dataOffset)).trim().split(/\s+/).map(Number);
    for (let target = 0; target < selected.length; target++) {
      const src = selected[target]! * scalarStride;
      const dst = target * 3;
      positions[dst] = rows[src + scalarOffsets[xIndex]!]!;
      positions[dst + 1] = rows[src + scalarOffsets[yIndex]!]!;
      positions[dst + 2] = rows[src + scalarOffsets[zIndex]!]!;
      const color = rgbIndex >= 0
        ? packedColor(rows[src + scalarOffsets[rgbIndex]!]!)
        : [rows[src + scalarOffsets[rIndex]!] ?? 69, rows[src + scalarOffsets[gIndex]!] ?? 214, rows[src + scalarOffsets[bIndex]!] ?? 255] as [number, number, number];
      colors.set(color, dst);
      if (intensities) intensities[target] = rows[src + scalarOffsets[intensityField]!]!;
    }
  } else if (header.data === "binary") {
    if (header.dataOffset + header.points * byteStride > buffer.byteLength) throw new Error("PCD binary 数据不完整");
    const view = new DataView(buffer, header.dataOffset);
    const read = (field: number, point: number) => {
      const offset = point * byteStride + byteOffsets[field]!;
      const size = header.size[field] ?? 4;
      const type = header.type[field] ?? "F";
      return readScalar(view, offset, size, type);
    };
    for (let target = 0; target < selected.length; target++) {
      const source = selected[target]!;
      const dst = target * 3;
      positions[dst] = read(xIndex, source);
      positions[dst + 1] = read(yIndex, source);
      positions[dst + 2] = read(zIndex, source);
      let color: [number, number, number] = [69, 214, 255];
      if (rgbIndex >= 0) {
        const offset = header.dataOffset + source * byteStride + byteOffsets[rgbIndex]!;
        const packed = new DataView(buffer).getUint32(offset, true);
        color = packedColor(packed);
      } else if (rIndex >= 0 && gIndex >= 0 && bIndex >= 0) {
        color = [read(rIndex, source), read(gIndex, source), read(bIndex, source)];
      }
      colors.set(color, dst);
      if (intensities) intensities[target] = read(intensityField, source);
    }
  } else {
    const requiredFields = [xIndex, yIndex, zIndex, rgbIndex, rIndex, gIndex, bIndex, intensityField];
    const captured = captureCompressedFields(buffer, header, selected, requiredFields);
    const views = new Map([...captured].map(([field, data]) => [field, new DataView(data.buffer, data.byteOffset, data.byteLength)]));
    const read = (field: number, point: number) => {
      const size = header.size[field] ?? 4;
      return readScalar(views.get(field)!, point * size, size, header.type[field] ?? "F");
    };
    for (let target = 0; target < selected.length; target++) {
      const dst = target * 3;
      positions[dst] = read(xIndex, target);
      positions[dst + 1] = read(yIndex, target);
      positions[dst + 2] = read(zIndex, target);
      let color: [number, number, number] = [69, 214, 255];
      if (rgbIndex >= 0) {
        color = packedColor(views.get(rgbIndex)!.getUint32(target * (header.size[rgbIndex] ?? 4), true));
      } else if (rIndex >= 0 && gIndex >= 0 && bIndex >= 0) {
        color = [read(rIndex, target), read(gIndex, target), read(bIndex, target)];
      }
      colors.set(color, dst);
      if (intensities) intensities[target] = read(intensityField, target);
    }
  }

  return {
    id,
    frameId: "camera_init",
    stampNs: 0n,
    sourcePointCount: header.points,
    sourcePointIndices: selected.length < header.points ? selected : undefined,
    attributes: {
      hasColor: rgbIndex >= 0 || (rIndex >= 0 && gIndex >= 0 && bIndex >= 0),
      hasIntensity: intensityField >= 0,
      frameIdDeclared: false,
      timestampDeclared: false,
    },
    positions,
    colors,
    intensities,
    visible: new Uint8Array(selected.length).fill(1),
  };
}

export function exportPcd(cloud: PointCloudData): Uint8Array {
  const indices = Array.from(cloud.visible.keys()).filter((index) => cloud.visible[index]);
  const header = `# .PCD v0.7 - Point View\nVERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH ${indices.length}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${indices.length}\nDATA binary\n`;
  const headerBytes = new TextEncoder().encode(header);
  const body = new Uint8Array(indices.length * 16);
  const view = new DataView(body.buffer);
  indices.forEach((point, row) => {
    const source = point * 3;
    const offset = row * 16;
    view.setFloat32(offset, cloud.positions[source]!, true);
    view.setFloat32(offset + 4, cloud.positions[source + 1]!, true);
    view.setFloat32(offset + 8, cloud.positions[source + 2]!, true);
    view.setUint32(offset + 12, (cloud.colors[source]! << 16) | (cloud.colors[source + 1]! << 8) | cloud.colors[source + 2]!, true);
  });
  const output = new Uint8Array(headerBytes.length + body.length);
  output.set(headerBytes);
  output.set(body, headerBytes.length);
  return output;
}
