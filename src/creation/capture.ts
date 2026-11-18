import type { CaptureManifest } from "./types";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("附件清单结构无效。");
  return value as Record<string, unknown>;
}
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function vector(value: unknown, n: number): value is number[] {
  return Array.isArray(value) && value.length === n && value.every(v => typeof v === "number" && Number.isFinite(v));
}
export function parseCapture(value: unknown): CaptureManifest {
  const root = object(value), pcd = object(root.pcd), calibration = object(root.calibration);
  if (root.version !== 1 || root.units !== "m" || root.camera !== "front"
    || root.pose_convention !== "T_world_camera_optical_xyzw"
    || !["raw", "pcd_export"].includes(String(root.pose_space))
    || typeof root.frame_id !== "string" || !root.frame_id
    || typeof pcd.name !== "string" || !/^tri_true_color_[^/\\]+\.pcd$/.test(pcd.name) || !hash(pcd.sha256)) throw new Error("附件版本、坐标声明或 PCD 标识无效。");
  if (calibration.model !== "opencv_radtan5" || !vector(calibration.intrinsics, 4)
    || calibration.intrinsics[0]! <= 0 || calibration.intrinsics[1]! <= 0 || !vector(calibration.distortion, 5)
    || ![calibration.width, calibration.height].every(v => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 8192)) throw new Error("图片标定不完整。");
  if (!vector(calibration.T_camera_lidar, 16)) throw new Error("缺少完整相机外参。");
  const t = calibration.T_camera_lidar;
  if ([12, 13, 14].some(i => Math.abs(t[i]!) > 1e-6) || Math.abs(t[15]! - 1) > 1e-6) throw new Error("相机外参最后一行无效。");
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    let dot = 0;
    for (let k = 0; k < 3; k++) dot += t[k * 4 + a]! * t[k * 4 + b]!;
    if (Math.abs(dot - Number(a === b)) > 1e-4) throw new Error("相机外参旋转无效。");
  }
  const det = t[0]! * (t[5]! * t[10]! - t[6]! * t[9]!) - t[1]! * (t[4]! * t[10]! - t[6]! * t[8]!) + t[2]! * (t[4]! * t[9]! - t[5]! * t[8]!);
  if (Math.abs(det - 1) > 1e-4) throw new Error("相机外参不能包含镜像。");
  if (!Array.isArray(root.views) || !root.views.length || root.views.length > 512) throw new Error("附件需包含 1 至 512 张视角图片。");
  const names = new Set<string>();
  const views = root.views.map(raw => {
    const v = object(raw);
    if (typeof v.image !== "string" || !/^images\/front_[0-9]+\.(jpg|jpeg|png)$/.test(v.image)
      || names.has(v.image) || !hash(v.sha256) || typeof v.stamp_ns !== "string" || !/^[1-9][0-9]*$/.test(v.stamp_ns)
      || !vector(v.position, 3) || !vector(v.quaternion_xyzw, 4)
      || Math.abs(v.quaternion_xyzw.reduce((sum, x) => sum + x * x, 0) - 1) > 1e-3) throw new Error("视角路径、时间戳或位姿无效。");
    names.add(v.image);
    return { ...v, image: v.image, sha256: v.sha256, stamp_ns: v.stamp_ns, position: [...v.position], quaternion_xyzw: [...v.quaternion_xyzw] };
  });
  return { ...root, version: 1, units: "m", camera: "front", frame_id: root.frame_id,
    pose_convention: "T_world_camera_optical_xyzw", pose_space: root.pose_space as CaptureManifest["pose_space"],
    pcd: { name: pcd.name, sha256: pcd.sha256 }, views,
    calibration: { model: "opencv_radtan5", width: calibration.width as number, height: calibration.height as number,
      intrinsics: [...calibration.intrinsics], distortion: [...calibration.distortion], T_camera_lidar: [...t] } };
}
export async function sha256(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), b => b.toString(16).padStart(2, "0")).join("");
}

