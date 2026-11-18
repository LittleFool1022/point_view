import type { EditOperation, PointCloudData } from "../domain/types";

export interface CaptureManifest {
  version: 1;
  units: "m";
  camera: "front";
  frame_id: string;
  pose_convention: "T_world_camera_optical_xyzw";
  pose_space: "raw" | "pcd_export";
  pcd: { name: string; sha256: string };
  calibration: { model: "opencv_radtan5"; width: number; height: number; intrinsics: number[]; distortion: number[]; T_camera_lidar: number[] };
  views: { image: string; sha256: string; stamp_ns: string; position: number[]; quaternion_xyzw: number[]; [key: string]: unknown }[];
  [key: string]: unknown;
}
export interface CaptureAttachment {
  manifest: CaptureManifest;
  images: Record<string, Blob>;
  /** 文件关联校验不能替代相机投影与遮挡核验。 */
  alignment: "unverified";
  association: "pcd_verified" | "project_reference";
}

export type SurfaceMethod = "bpa" | "poisson";
export type MaterialPreset = "original" | "plaster" | "metal" | "ceramic";
export interface SurfaceMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  report: {
    method: SurfaceMethod;
    inputPoints: number;
    usedPoints: number;
    vertices: number;
    triangles: number;
    boundaryEdges: number;
    components: number;
    removedUnsupported: number;
    spacing: number;
    seconds: number;
    warnings: string[];
  };
}
export interface ObjectAsset {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  source: { id: string; name: string; frameId: string; sampled: boolean; pointCount: number; stampNs: string };
  origin: [number, number, number];
  sourceIndices: Uint32Array;
  cloud: PointCloudData;
  mesh?: SurfaceMesh;
  material: MaterialPreset;
  metersPerUnit: number;
  thumbnail?: string;
  capture?: CaptureAttachment;
  /** 保留提取前的编辑，避免未来投影忽略点云已发生的变换。 */
  sourceEdits?: EditOperation[];
}
export interface ReconstructionInput {
  positions: ArrayBuffer;
  colors: ArrayBuffer;
  hasColor: boolean;
  method: SurfaceMethod;
  detail: "preview" | "fine";
}
export interface ReconstructionOutput {
  positions: ArrayBuffer;
  normals: ArrayBuffer;
  colors: ArrayBuffer;
  indices: ArrayBuffer;
  report: SurfaceMesh["report"];
}
