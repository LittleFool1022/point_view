import type { PointCloudData } from "./types";

export interface RosPointField {
  name: string;
  offset: number;
  datatype: number;
  count: number;
}

export interface RosPointCloud2 {
  header?: { frame_id?: string; stamp?: { sec?: number; nanosec?: number; nsec?: number } };
  height: number;
  width: number;
  fields: RosPointField[];
  is_bigendian: boolean;
  point_step: number;
  row_step: number;
  data: Uint8Array | number[];
  is_dense?: boolean;
}

const readers: Record<number, (view: DataView, offset: number, littleEndian: boolean) => number> = {
  1: (v, o) => v.getInt8(o),
  2: (v, o) => v.getUint8(o),
  3: (v, o, le) => v.getInt16(o, le),
  4: (v, o, le) => v.getUint16(o, le),
  5: (v, o, le) => v.getInt32(o, le),
  6: (v, o, le) => v.getUint32(o, le),
  7: (v, o, le) => v.getFloat32(o, le),
  8: (v, o, le) => v.getFloat64(o, le),
};

function readField(view: DataView, base: number, field: RosPointField | undefined, le: boolean): number {
  if (!field || !readers[field.datatype]) return Number.NaN;
  return readers[field.datatype]!(view, base + field.offset, le);
}

function decodePackedRgb(view: DataView, offset: number, datatype: number, le: boolean): [number, number, number] {
  let packed: number;
  if (datatype === 7) {
    packed = view.getUint32(offset, le);
  } else {
    packed = Math.trunc(readers[datatype]?.(view, offset, le) ?? 0) >>> 0;
  }
  return [(packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff];
}

/** 将 ROS PointCloud2 的交错字节布局收敛为渲染友好的紧凑数组。 */
export function decodePointCloud2(message: RosPointCloud2, id: string = crypto.randomUUID()): PointCloudData {
  const byName = new Map(message.fields.map((field) => [field.name.toLowerCase(), field]));
  const x = byName.get("x");
  const y = byName.get("y");
  const z = byName.get("z");
  if (!x || !y || !z) throw new Error("PointCloud2 缺少 x/y/z 字段");

  const bytes = message.data instanceof Uint8Array ? message.data : Uint8Array.from(message.data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = !message.is_bigendian;
  const expected = Math.min(message.width * Math.max(message.height, 1), Math.floor(bytes.byteLength / message.point_step));
  const positions = new Float32Array(expected * 3);
  const colors = new Uint8Array(expected * 3);
  const intensities = byName.has("intensity") ? new Float32Array(expected) : undefined;
  const packed = byName.get("rgb") ?? byName.get("rgba");
  const rf = byName.get("r");
  const gf = byName.get("g");
  const bf = byName.get("b");
  let write = 0;

  for (let i = 0; i < expected; i++) {
    const row = Math.floor(i / message.width);
    const col = i % message.width;
    const base = row * message.row_step + col * message.point_step;
    const px = readField(view, base, x, le);
    const py = readField(view, base, y, le);
    const pz = readField(view, base, z, le);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;

    const dst = write * 3;
    positions[dst] = px;
    positions[dst + 1] = py;
    positions[dst + 2] = pz;
    const color = packed
      ? decodePackedRgb(view, base + packed.offset, packed.datatype, le)
      : rf && gf && bf
        ? [readField(view, base, rf, le), readField(view, base, gf, le), readField(view, base, bf, le)]
        : [69, 214, 255];
    colors[dst] = Math.max(0, Math.min(255, color[0] ?? 0));
    colors[dst + 1] = Math.max(0, Math.min(255, color[1] ?? 0));
    colors[dst + 2] = Math.max(0, Math.min(255, color[2] ?? 0));
    if (intensities) intensities[write] = readField(view, base, byName.get("intensity"), le);
    write++;
  }

  const stamp = message.header?.stamp;
  const stampNs = BigInt(stamp?.sec ?? 0) * 1_000_000_000n + BigInt(stamp?.nanosec ?? stamp?.nsec ?? 0);
  return {
    id,
    frameId: message.header?.frame_id || "camera_init",
    attributes: {
      hasColor: Boolean(packed || (rf && gf && bf)),
      hasIntensity: byName.has("intensity"),
      frameIdDeclared: Boolean(message.header?.frame_id?.trim()),
      timestampDeclared: Boolean(stamp),
    },
    stampNs,
    positions: positions.slice(0, write * 3),
    colors: colors.slice(0, write * 3),
    intensities: intensities?.slice(0, write),
    visible: new Uint8Array(write).fill(1),
  };
}
