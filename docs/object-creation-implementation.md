# 物体创作台实施与验收

本轮目标：在现有工作台增加可操作的物体选取、表面重建、材质预览、作品保存、GLB 导出，并执行 Blender 导入验证。沿用现有石墨银色界面；不迁移桌面框架。

## 实施切片

1. 冻结源快照；框选遍历完整可用点，提供添加、减去、撤销、轴向范围过滤。PCD 超限导入时从保留的原始文件快照在 Worker 中重读并映射已有编辑；不可恢复全量时明确标识采样来源。
2. 对象记录保存局部坐标、源索引、空间原点、来源与创建时间。独立任务运行 Open3D BPA / Poisson、法线估计、观测支持裁剪、网格清理、颜色转移与几何检查。算法依赖安装到项目隔离环境；重建可取消，失败保留对象。
3. 左侧真实对象预览，右侧渐进操作。基础原色、石膏、金属、陶瓷，无贴图时不要求 UV。持久化作品和缩略图；导出 GLB 时明确单位、Z/Y 坐标转换，纯色材质副本去除顶点色。
4. 最小单测覆盖选取与几何契约；定向浏览器／桌面交互验证；固定 Blender 实际导入，核对网格、尺寸、方向、颜色与材质。

## 边界

不自动补造未扫描的结构，不宣称自动语义识别或工程级精度。重建采用本地独立运行时；安装包内运行时分发与本机开发环境分别说明。若需系统级安装或无法安全验证，先报告具体阻碍。

## 验收记录

首版实施与定向验收结果如下；未覆盖部分见结果边界。

## 2026-09-07 实施结果

已实现以下首版能力：

- `src/creation/ObjectStudio.tsx`：顶部「创作」入口；左侧真实物体与右侧悬浮任务面板；添加、减去、撤销、X/Y/Z 范围过滤；原貌对照；单位核对；收藏与恢复；GLB/原貌 PLY 保存。CAD 保留原悬浮窗，与创作按任务切换。
- `src/creation/objects.ts`、`source.worker.ts`：独立对象、源点索引、局部原点、完整源快照恢复、编辑索引重放。源回传转移 ArrayBuffer，减少完整点云复制。实时源通过引用不可变快照冻结创作输入。
- `electron/object-studio/reconstruct.py`：有效点检查、去重、有限点数体素处理、法线估计与朝向、BPA/Poisson、观测支持和跨接面检查、float32 交付精度下的退化面清理、颜色转移、边界/分片报告。
- `electron/object-studio/runtime.cjs`：本地任务进程、阶段反馈、取消、180 秒上限、临时文件回收。单物体生成输入上限 200 万点；快速/精细处理预算分别 6 万/18 万点，原始对象不随算法采样覆盖。需要重建的输入与用于收藏的原貌分开保存。
- `src/creation/materials.ts`：GLB 导出、米制尺度、Z-up → Y-up 根变换；原色按 sRGB 字节解码为线性值，纯色材质不导出顶点色；来源和重建参数记录到 extras。
- `src/creation/ply.ts`：原貌附件保留来源点号、空间原点、单位声明；只有真实存在 RGB/强度时才写这些属性。文件本身没有面。

### 当前本机运行

```bash
cd /mnt/zk/point_view
npm run electron:dev
```

本机已配置 `.tools/object-runtime`（Python 3.10.12 / Open3D 0.19.0 / NumPy 1.26.4 / SciPy 1.15.3），不需要为日常创作安装 Blender。全新检出可执行 `bash scripts/object-studio/setup-runtime.sh` 配置项目隔离环境；不会全局安装 Python 包。当前完整开发运行时展开约 1.6 GiB，未作分发裁剪。

浏览器可选取、收藏与查看物体，表面重建当前只在桌面应用运行。桌面端可通过 `POINT_VIEW_OBJECT_PYTHON` 指定其他兼容解释器。打包配置已将 Python 脚本设为 `asarUnpack`，外部 Python 进程从真实解包路径读取脚本；本轮未将算法运行时捆入 AppImage，也没有更新原有 AppImage。安装包内运行时分发、跨平台依赖和安装包启动属于后续单独验收。

### 验证证据

所有记录位于 `artifacts/object-studio-validation/`：

| 检查 | 结果与证据 |
| --- | --- |
| TypeScript + Vite 生产构建 | `build-final.log`，成功 |
| 数据与格式单测 | `unit.log` 8 项通过；增加原貌附件检查后定向运行 `unit-ply.log` 1 项通过，共 9 项唯一检查 |
| 7 类输入 × 2 种算法 | `algorithms/results.json`：12 项网格契约通过，2 项无效输入按预期拒绝 |
| 真实桌面完整流程 | `desktop-result.json`：框选、撤销、生成、四材质预览/导出、收藏与恢复、退出和 CAD；无 pageerror / console.error |
| 取消、跨启动恢复、GPU 预算独立选取 | `followup-result.json`：7 项检查通过；包含完整框选 600001 点、减选和范围过滤 |
| PCD 超限恢复 | `source-result.json`：主界面 4000000 点 → 创作台完整恢复 4000001 点并全部框选 → 退出恢复原显示预算；无 pageerror。源 Worker 改用缓冲区转移后复核记录为 `source-transfer.log` |
| 原生实际入口 | `native-entry.json`：直接启动项目主入口，运行时自动定位成功，无测试解释器覆盖 |
| 最终窄屏布局 | `layout-final.json`、`mobile-studio-final.png`：390 像素下导航、标题、模型预览区域分离 |
| Blender 基础往返 | `blender-results.json`：Blender 4.5.3 LTS 实际导入四种材质和毫米版本，共 5 个 GLB；检查三角面、有效法线、世界轴尺寸、枢轴、颜色层、金属度与粗糙度；生成 `.blend` 及 `blender-metal-render.png` |
| 真实扫描端到端 | `real-scan-result.json`、`blender-real-result.json`：原始扫描 40256 点 → 40219 顶点 / 78774 面 → UI 导出 → Blender 实际导入与 `.blend` 保存 |

Blender 的对象「局部轴尺寸」与世界坐标包围尺寸不同；验收计算 `matrix_world @ vertex.co` 后的世界尺寸。合成物体实测约 1.199791 × 0.799838 × 1.599734 米，毫米版本为其 1/1000。导出文件保留了正确的世界朝向，不用局部包围盒替代世界坐标验证。

### 样本与问题修正

真实样本采用 [Stanford Computer Graphics Laboratory 的原始 bun000 扫描](https://graphics.stanford.edu/data/3Dscanrep/)，没有用现成完整网格抽点冒充原始扫描。数据只用于本地研究验收，不随应用分发。其单视角重建仍有 17 片分离表面、2808 条开放边；当前 UI 如实提示，不能因此宣称扫描完整或可打印。

首轮算法检查发现部分面转为 float32 后塌缩，已在交付精度下二次清理，再运行受影响算法用例。桌面自动化首轮恢复作品后过早修改单位，毫米文件未落盘；已修正等待条件，独立复核实际文件与 Blender 毫米导入。移动布局曾被双行导航覆盖，已修正为 112px 顶部偏移，并为标题与底部工具预留画布空间。

本机 Blender 启动会在已有 `/tmp/fuse/` 挂载点的 `stat` 调用中阻塞。证据为 `blender-startup.log`。验收使用 `blender-mount-guard.c` 编译的局部预加载库，仅让这个路径返回 ENOENT，不改变挂载配置，不干预 GLB 或 Blender 数据；绕过后才完成实际导入。该辅助库不属于产品运行路径。Blender 官方下载校验见 `blender-checksum.txt`。

### 结果边界

- 算法 PASS 表示本组数据检查满足约定，不代表任意家具、玻璃、镜面或遮挡物体都能准确重建。BPA 为首版默认，Poisson 可在高级选项中切换；没有自动语义分割或无限制补面。
- 原始 PCD 不含相机视角、真实材质或可确认的采集时间时，不补造这些信息。原色按 sRGB 字节解释，未知相机色彩编码需另行标定。
- 已检查 Blender 4.5.3 LTS 的几何与基础材质参数；不同灯光、渲染器和色彩管理下不承诺逐像素相同。`.blend` 是本轮验收生成物，产品主出口为 GLB。
- 未实测真实百万点单物体的重建峰值内存、不同设备耗时或新手用户研究。当前算法时间是记录中的样本结果，不作为通用速度承诺。


## 2026-09-07 AppImage 更新交付

本次重新打包已补齐运行时分发，替代上文“尚未捆入 AppImage”的阶段性状态。

- 成品：`release/Point View-0.1.6.AppImage`，406469974 字节（约 388 MiB）。
- SHA256：`e241bd6cc4d16d778a4f41582b5db85117039124e6eebbc88a7318c6322dc840`；同目录 `.sha256` 校验通过。
- 旧包：`release/backups/before-object-studio-20260907-154604/Point View-0.1.6.AppImage`。
- 内置可移动 Python 3.10.19、Open3D 0.19.0 CPU、NumPy 1.26.4、SciPy 1.15.3；解释器和依赖均从包内加载，不依赖开发目录或 `/usr/bin/python3`。运行时展开约 880 MiB，不包含 CUDA 模块或 Blender。
- 实际新 AppImage 以 `APPIMAGE_EXTRACT_AND_RUN=1` 启动，`isPackaged=true`，没有设置 `POINT_VIEW_OBJECT_PYTHON`。核对包内 32 个前端文件和重建脚本与当前源码一致。
- 包内真实操作：6000 点框选 → BPA 11996 面 → 银色金属 → GLB 保存；Poisson 19044 面。无 pageerror / console.error。验证覆盖本机 Ubuntu 22.04 Linux x86_64；未额外验证其他发行版或正常 FUSE 挂载启动。
- 证据：`artifacts/appimage-object-studio-20260907/verification.json` 和 `appimage-running.png`。

打包用运行时组装入口是 `scripts/object-studio/prepare-appimage-runtime.py`。它从 `.tools/portable-python/cpython-3.10.19-linux-x86_64-gnu` 与项目隔离依赖创建 `.tools/appimage-object-runtime`；通过 `linux.extraResources` 放入包内 `.tools/object-runtime`。外部 Python 启动加 `-I` 隔离用户 Python 搜索路径。没有更改系统 Python、全局包或系统挂载配置。
