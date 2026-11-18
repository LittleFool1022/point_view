import type { ObjectAsset } from "./types";

/** 原貌附件保留来源点号、空间原点与真实存在的属性，避免把占位色当采集颜色。 */
export function exportObjectPly(asset: ObjectAsset): Uint8Array {
  const color = Boolean(asset.cloud.attributes?.hasColor);
  const intensity = Boolean(asset.cloud.attributes?.hasIntensity && asset.cloud.intensities);
  const count = asset.cloud.visible.length;
  const metadata = JSON.stringify({ source: asset.source, originZUp: asset.origin, metersPerUnit: asset.metersPerUnit });
  const header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\ncomment point_view ${metadata}\nelement vertex ${count}\nproperty float x\nproperty float y\nproperty float z\nproperty uint source_index\n${color ? "property uchar red\nproperty uchar green\nproperty uchar blue\n" : ""}${intensity ? "property float intensity\n" : ""}end_header\n`);
  const stride = 16 + (color ? 3 : 0) + (intensity ? 4 : 0);
  const output = new Uint8Array(header.length + count * stride); output.set(header);
  const view = new DataView(output.buffer);
  for (let i = 0; i < count; i++) {
    let offset = header.length + i * stride;
    for (let a = 0; a < 3; a++) view.setFloat32(offset + a * 4, asset.cloud.positions[i * 3 + a]!, true);
    view.setUint32(offset + 12, asset.sourceIndices[i]!, true); offset += 16;
    if (color) { output.set(asset.cloud.colors.subarray(i * 3, i * 3 + 3), offset); offset += 3; }
    if (intensity) view.setFloat32(offset, asset.cloud.intensities![i]!, true);
  }
  return output;
}
