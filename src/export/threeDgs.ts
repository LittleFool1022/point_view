import { strToU8, zipSync } from "fflate";
import { exportPly } from "../domain/ply";
import type { PointCloudData, ProjectManifest } from "../domain/types";
import type { DirectoryFile } from "../platform/files";

export interface ColmapValidation {
  cameraCount: number;
  imageCount: number;
  pointCount: number;
  files: Map<string, Uint8Array>;
}

const cleanPath = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
const dataLines = (bytes: Uint8Array) => new TextDecoder().decode(bytes).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));

/** 严格拒绝空占位 COLMAP，避免生成“目录看似完整、实际无法训练”的交付物。 */
export function validateColmapDataset(input: DirectoryFile[]): ColmapValidation {
  const files = new Map(input.map((file) => [cleanPath(file.relativePath), file.data]));
  const find = (suffix: string) => [...files.entries()].find(([path]) => path.endsWith(suffix));
  const cameras = find("sparse/0/cameras.txt");
  const images = find("sparse/0/images.txt");
  const points = find("sparse/0/points3D.txt");
  if (!cameras || !images || !points) throw new Error("COLMAP 必须包含 sparse/0/cameras.txt、images.txt、points3D.txt");
  const cameraCount = dataLines(cameras[1]).length;
  const pointCount = dataLines(points[1]).length;
  const imageRows = dataLines(images[1]).filter((line) => {
    const columns = line.split(/\s+/);
    return columns.length >= 10 && /^\d+$/.test(columns[0]!) && /\.(png|jpe?g)$/i.test(columns[9]!);
  });
  if (cameraCount === 0) throw new Error("cameras.txt 没有相机记录");
  if (imageRows.length === 0) throw new Error("images.txt 没有注册图像和位姿");
  if (pointCount === 0) throw new Error("points3D.txt 没有稀疏三维点");
  const availableImages = new Set([...files.keys()].filter((path) => /(^|\/)images\/.*\.(png|jpe?g)$/i.test(path)).map((path) => path.split("/").pop()!));
  const missing = imageRows.map((row) => row.split(/\s+/)[9]!).filter((name) => !availableImages.has(name));
  if (missing.length) throw new Error(`缺少 ${missing.length} 张注册图像，首个缺失: ${missing[0]}`);
  return { cameraCount, imageCount: imageRows.length, pointCount, files };
}

export function exportThreeDgsDataset(cloud: PointCloudData, project: ProjectManifest, input: DirectoryFile[]): Uint8Array {
  const validated = validateColmapDataset(input);
  const archive: Record<string, Uint8Array> = {};
  for (const [sourcePath, data] of validated.files) {
    const sparseAt = sourcePath.indexOf("sparse/0/");
    const imagesAt = sourcePath.indexOf("images/");
    if (sparseAt >= 0) archive[sourcePath.slice(sparseAt)] = data;
    else if (imagesAt >= 0) archive[sourcePath.slice(imagesAt)] = data;
  }
  archive["sparse/0/edited_points3D.ply"] = exportPly(cloud);
  archive["point_view/project.json"] = strToU8(JSON.stringify(project, null, 2));
  archive["point_view/validation.json"] = strToU8(JSON.stringify({
    cameraCount: validated.cameraCount,
    imageCount: validated.imageCount,
    colmapPointCount: validated.pointCount,
    editedPointCount: cloud.visible.reduce((sum, value) => sum + value, 0),
    coordinateFrame: cloud.frameId,
  }, null, 2));
  return zipSync(archive, { level: 0 });
}
