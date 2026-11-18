"""本地物体重建；stdout 仅输出阶段 JSON，网格使用小端二进制传递。"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree


def progress(stage):
    print(json.dumps({"stage": stage}, ensure_ascii=False), flush=True)


def reconstruct(folder, method, detail):
    started = time.monotonic()
    progress("检查点与采样间距")
    points = np.fromfile(folder / "input.positions", dtype="<f4").reshape(-1, 3).astype(np.float64)
    colors = np.fromfile(folder / "input.colors", dtype=np.uint8).reshape(-1, 3) / 255.0
    input_count = len(points)
    valid = np.isfinite(points).all(axis=1)
    points, colors = points[valid], colors[valid]
    if len(points) < 30:
        raise ValueError("有效点不足 30 个，请扩大物体选区。")
    points, unique = np.unique(points, axis=0, return_index=True)
    colors = colors[unique]
    cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(points))
    cloud.colors = o3d.utility.Vector3dVector(colors)
    span = np.linalg.norm(np.ptp(points, axis=0))
    if span < 1e-8:
        raise ValueError("选区没有可重建的空间范围。")
    distances = cKDTree(points).query(points[::max(1, len(points) // 20000)], k=2)[0][:, 1]
    spacing = float(np.median(distances[distances > 0]))
    warnings = []
    budget = 180000 if detail == "fine" else 60000
    voxel = max(spacing * 0.5, span / 2000)
    while len(cloud.points) > budget:
        cloud = cloud.voxel_down_sample(voxel)
        voxel *= 1.4
    used = np.asarray(cloud.points)
    local_dist = cKDTree(used).query(used[::max(1, len(used) // 20000)], k=2)[0][:, 1]
    spacing = float(np.median(local_dist[local_dist > 0]))
    if len(used) < 30:
        raise ValueError("去除重复点后不足 30 个有效点。")
    progress("估计表面朝向")
    cloud.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=spacing * 5, max_nn=40))
    # 共面数据的四面体剖分可能失败；保留一致的平面方向，不伪造厚度。
    try:
        cloud.orient_normals_consistent_tangent_plane(min(30, len(used) - 1))
    except RuntimeError:
        _, _, axes = np.linalg.svd(used - used.mean(axis=0), full_matrices=False)
        normal = axes[-1]
        normals = np.asarray(cloud.normals)
        normals[normals @ normal < 0] *= -1
        warnings.append("局部朝向存在歧义，请旋转检查薄面与边缘。")
    normals = np.asarray(cloud.normals)
    # 封闭扫描整体翻面可由质心方向纠正；不对每个点各自翻转。
    if np.median(np.sum(normals * (used - used.mean(axis=0)), axis=1)) < 0:
        cloud.normals = o3d.utility.Vector3dVector(-normals)
    progress("连接物体表面")
    if method == "bpa":
        mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
            cloud, o3d.utility.DoubleVector([spacing * 1.5, spacing * 2.5, spacing * 4]))
    elif method == "poisson":
        mesh, _ = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            cloud, depth=8 if detail == "fine" else 7, scale=1.05, linear_fit=True, n_threads=4)
        warnings.append("连续表面由算法推断，请对照扫描点检查缺口附近。")
    else:
        raise ValueError("不支持的表面生成方式。")
    progress("检查观测支持与多余连接")
    mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_duplicated_vertices()
    vertices, faces = np.asarray(mesh.vertices), np.asarray(mesh.triangles)
    if len(faces) == 0:
        raise ValueError("未形成有效表面。请减少背景，或尝试另一种生成方式。")
    tree = cKDTree(used)
    distances = tree.query(vertices, k=1)[0]
    centers = vertices[faces].mean(axis=1)
    center_distance = tree.query(centers, k=1)[0]
    edge_length = np.max(np.stack([np.linalg.norm(vertices[faces[:, a]] - vertices[faces[:, b]], axis=1) for a, b in [(0, 1), (1, 2), (2, 0)]]), axis=0)
    unsupported = (distances[faces].max(axis=1) > spacing * 3) | (center_distance > spacing * 2.5) | (edge_length > spacing * 8)
    removed = int(unsupported.sum())
    mesh.remove_triangles_by_mask(unsupported)
    mesh.remove_unreferenced_vertices()
    if len(mesh.triangles) > 240000:
        mesh = mesh.simplify_quadric_decimation(240000)
    mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_unreferenced_vertices()
    # GLB 最终使用 float32；转换后极小三角形可能塌缩，按交付精度再检查一次。
    mesh.vertices = o3d.utility.Vector3dVector(np.asarray(mesh.vertices, dtype=np.float32).astype(np.float64))
    mesh.remove_duplicated_vertices()
    rounded = np.asarray(mesh.vertices)
    rounded_faces = np.asarray(mesh.triangles)
    area = np.linalg.norm(np.cross(rounded[rounded_faces[:, 1]] - rounded[rounded_faces[:, 0]], rounded[rounded_faces[:, 2]] - rounded[rounded_faces[:, 0]]), axis=1)
    mesh.remove_triangles_by_mask(area <= span * span * 1e-12)
    mesh.remove_unreferenced_vertices()
    if len(mesh.triangles) == 0:
        raise ValueError("表面缺少足够扫描支持，已保留原貌，请补充采集或调整选区。")
    mesh.compute_vertex_normals()
    progress("转移原色与整理模型")
    # 颜色来自最近的有效观测点；保持 RGB 字节约定，由前端统一转为线性颜色。
    original_tree = cKDTree(points)
    nearest = original_tree.query(np.asarray(mesh.vertices), k=1)[1]
    vertex_colors = np.round(colors[nearest] * 255).clip(0, 255).astype(np.uint8)
    faces = np.asarray(mesh.triangles)
    edges = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    _, cluster_counts, _ = mesh.cluster_connected_triangles()
    report = dict(method=method, inputPoints=input_count, usedPoints=len(used), vertices=len(mesh.vertices),
                  triangles=len(faces), boundaryEdges=int((counts == 1).sum()), components=len(cluster_counts),
                  removedUnsupported=removed, spacing=spacing, seconds=round(time.monotonic() - started, 3), warnings=warnings)
    np.asarray(mesh.vertices, dtype="<f4").tofile(folder / "positions.bin")
    np.asarray(mesh.vertex_normals, dtype="<f4").tofile(folder / "normals.bin")
    vertex_colors.tofile(folder / "colors.bin")
    np.asarray(mesh.triangles, dtype="<u4").tofile(folder / "indices.bin")
    (folder / "report.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    progress("模型已生成")


if __name__ == "__main__":
    try:
        reconstruct(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
