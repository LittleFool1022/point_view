"""组装 AppImage 的可移动 Python 运行时，不修改开发环境和系统 Python。"""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parents[2]
base = ROOT / '.tools/portable-python/cpython-3.10.19-linux-x86_64-gnu'
packages = ROOT / '.tools/object-runtime/lib/python3.10/site-packages'
target = ROOT / '.tools/appimage-object-runtime'
if not (base / 'bin/python3.10').exists():
    raise SystemExit('请先执行 uv python install 3.10.19 --install-dir .tools/portable-python --no-bin')
if target.exists():
    raise SystemExit('运行时目标已存在，请先核对后使用已有产物，避免静默覆盖。')
shutil.copytree(base, target, symlinks=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))

def ignore(directory, names):
    excluded = [name for name in names if name == '__pycache__' or name.endswith('.pyc')]
    # 当前重建算法使用 CPU；Open3D 官方模块缺少 cuda 子目录时有 CPU 回退路径。
    if Path(directory) == packages / 'open3d' and 'cuda' in names:
        excluded.append('cuda')
    return excluded

shutil.copytree(packages, target / 'lib/python3.10/site-packages', dirs_exist_ok=True, symlinks=True, ignore=ignore)
(target / 'runtime-manifest.json').write_text(json.dumps({
    'python': '3.10.19', 'open3d': '0.19.0', 'numpy': '1.26.4', 'scipy': '1.15.3',
    'source': 'uv python-build-standalone + project isolated site-packages',
    'excluded': ['open3d/cuda', '__pycache__', '*.pyc'],
    'backend': 'cpu', 'scope': 'Linux x86_64 AppImage',
}, indent=2))
print(target)
