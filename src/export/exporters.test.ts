import { unzipSync } from "fflate";
import { hasMcapPrefix } from "@mcap/core";
import { describe, expect, it } from "vitest";
import { exportPointCloudMcap } from "./mcap";
import { exportThreeDgsDataset, validateColmapDataset } from "./threeDgs";
import { loadMcapPointCloud } from "../domain/mcapImport";
import { DEFAULT_DEVICE_PROFILE, type PointCloudData, type ProjectManifest } from "../domain/types";

const cloud: PointCloudData = {
  id: "export", frameId: "camera_init", stampNs: 8n,
  positions: new Float32Array([1, 2, 3]), colors: new Uint8Array([4, 5, 6]), visible: new Uint8Array([1]),
};
const project: ProjectManifest = {
  formatVersion: 1, id: "p", name: "test", createdAt: "now", updatedAt: "now",
  deviceProfile: DEFAULT_DEVICE_PROFILE, crs: "LOCAL_ENU", sourceFiles: [], edits: [],
};

describe("交付格式", () => {
  it("输出有效 MCAP 前缀", async () => {
    const bytes = await exportPointCloudMcap(cloud);
    expect(hasMcapPrefix(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))).toBe(true);
    const decoded = await loadMcapPointCloud(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect([...decoded.positions]).toEqual([1, 2, 3]);
  });

  it("3DGS 仅接受完整 COLMAP，并包含编辑后点云和验证清单", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    const files = unzipSync(exportThreeDgsDataset(cloud, project, [
      { relativePath: "sparse/0/cameras.txt", data: text("1 PINHOLE 640 512 500 500 320 256\n") },
      { relativePath: "sparse/0/images.txt", data: text("1 1 0 0 0 0 0 0 1 000001.png\n0 0 -1\n") },
      { relativePath: "sparse/0/points3D.txt", data: text("1 1 2 3 4 5 6 0.1 1 0\n") },
      { relativePath: "images/000001.png", data: new Uint8Array([137, 80, 78, 71]) },
    ]));
    expect(Object.keys(files)).toContain("sparse/0/edited_points3D.ply");
    expect(Object.keys(files)).toContain("sparse/0/cameras.txt");
    expect(Object.keys(files)).toContain("point_view/validation.json");
  });

  it("拒绝空 images.txt/points3D.txt，避免伪 3DGS 数据集", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(() => validateColmapDataset([
      { relativePath: "sparse/0/cameras.txt", data: text("1 PINHOLE 640 512 500 500 320 256\n") },
      { relativePath: "sparse/0/images.txt", data: text("") },
      { relativePath: "sparse/0/points3D.txt", data: text("") },
    ])).toThrow("images.txt 没有注册图像和位姿");
  });
});
