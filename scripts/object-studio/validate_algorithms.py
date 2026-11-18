"""定向算法验收：合成边界样本 + Stanford 原始扫描（仅验证用，不随产品分发）。"""
import importlib.util
import json
import sys
from pathlib import Path
import numpy as np
import open3d as o3d

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("reconstruct", ROOT / "electron/object-studio/reconstruct.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
OUT = ROOT / "artifacts/object-studio-validation/algorithms"
OUT.mkdir(parents=True, exist_ok=True)

# Fibonacci 采样避免经纬网在极点极度过密；非等轴形体用于方向、尺寸往返验证。
i = np.arange(6000)
z = 1 - 2 * (i + .5) / len(i)
angle = i * np.pi * (3 - np.sqrt(5))
r = np.sqrt(1 - z*z)
ellipsoid = np.stack([.6*r*np.cos(angle), .4*r*np.sin(angle), .8*z], axis=1)
x, y = np.meshgrid(np.linspace(-.5, .5, 50), np.linspace(-.4, .4, 40))
plane = np.stack([x.ravel(), y.ravel(), np.zeros(x.size)], axis=1)
angles, heights = np.meshgrid(np.linspace(0,2*np.pi,36,endpoint=False), np.linspace(-.7,.7,90))
rod = np.stack([.025*np.cos(angles.ravel()), .025*np.sin(angles.ravel()), heights.ravel()], axis=1)
cases = {"ellipsoid": ellipsoid, "single-side": plane, "thin-rod": rod,
         "nonuniform": np.concatenate([ellipsoid[ellipsoid[:,0] > 0], ellipsoid[ellipsoid[:,0] <= 0][::5]]),
         "background": np.concatenate([ellipsoid, plane + [0,0,-.9]]),
         "invalid": np.array([[np.nan,0,0],[0,np.inf,0],[0,0,0]])}
bunny_path = ROOT / ".tools/fixtures/bunny/data/bun000.ply"
if bunny_path.exists():
    raw = np.asarray(o3d.io.read_point_cloud(str(bunny_path)).points).copy()
    raw = raw[:, [0,2,1]]; raw[:,1] *= -1
    raw -= (raw.max(axis=0)+raw.min(axis=0))/2
    cases["stanford-raw-bun000"] = raw
results = []
for name, points in cases.items():
    for method in ("bpa", "poisson"):
        folder = OUT / f"{name}-{method}"; folder.mkdir(exist_ok=True)
        points.astype("<f4").tofile(folder / "input.positions")
        colors = np.tile(np.array([176,106,68],dtype=np.uint8), (len(points),1))
        colors.tofile(folder / "input.colors")
        try:
            module.reconstruct(folder, method, "preview")
            report = json.loads((folder / "report.json").read_text())
            vertices = np.fromfile(folder / "positions.bin", dtype="<f4").reshape(-1,3)
            normals = np.fromfile(folder / "normals.bin", dtype="<f4").reshape(-1,3)
            faces = np.fromfile(folder / "indices.bin", dtype="<u4").reshape(-1,3)
            assert np.isfinite(vertices).all() and np.isfinite(normals).all()
            assert len(faces) > 0 and faces.max() < len(vertices)
            assert np.all(np.linalg.norm(np.cross(vertices[faces[:,1]]-vertices[faces[:,0]], vertices[faces[:,2]]-vertices[faces[:,0]]), axis=1) > 0)
            if name == "single-side":
                assert np.abs(vertices[:,2]).max() < report["spacing"] * 3, "生成了过远背面"
                assert report["boundaryEdges"] > 0, "单面样本不应被当作完整闭合物体"
            if name == "invalid": raise AssertionError("无效输入未被拒绝")
            results.append({"sample": name, "status": "PASS", **report, "bounds": [vertices.min(axis=0).tolist(), vertices.max(axis=0).tolist()]})
        except ValueError as error:
            if name != "invalid": raise
            results.append({"sample": name, "method": method, "status": "EXPECTED_REJECTION", "reason": str(error)})
(OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
# 给真实桌面链路导入用的已知非等轴、带颜色合成扫描。
points = ellipsoid
colors = np.tile([176,106,68], (len(points),1)).astype(np.uint8)
header = f"VERSION .7\nFIELDS x y z r g b\nSIZE 4 4 4 1 1 1\nTYPE F F F U U U\nCOUNT 1 1 1 1 1 1\nWIDTH {len(points)}\nHEIGHT 1\nPOINTS {len(points)}\nDATA binary\n"
body = np.empty(len(points), dtype=[('xyz','<f4',(3,)),('rgb','u1',(3,))]); body['xyz']=points; body['rgb']=colors
(OUT.parent / "ellipsoid.pcd").write_bytes(header.encode()+body.tobytes())
print("ALGORITHM_CASES", len(results), "PASSED")
