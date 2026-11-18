# Point View

omni MID360S + 三目相机设备的跨平台配套显示、点云采集、轻编辑与格式导出工作台。

## 已实现

- React 19 + TypeScript + Three.js/WebGL2 共享前端。
- Electron Windows/Linux 桌面壳，不包含 Rust。
- Capacitor Android APK 工程，最低 Android API 24。
- Foxglove WebSocket 同时兼容 ROS1/ROS2 schema；Orange Pi 默认显示协议：
  - `/cloud_registered/tri_precise`（严格同步、遮挡过滤和去重后的三目精确彩色点云，默认主数据源）
  - `/cloud_registered/front`（前相机诊断点云）
  - `/cloud_registered/left`（左相机诊断点云）
  - `/cloud_registered/right`（右相机诊断点云）
  - `/aft_mapped_to_init`（里程计）
  - `/path`（轨迹）
  - `/omni/camera/front/image/compressed`
  - `/omni/camera/left/image/compressed`
  - `/omni/camera/right/image/compressed`
  - `/omni/sync/status`（`std_msgs/String`）
- 默认按真彩 RGB 显示；支持 PointCloud2 的 XYZ、RGB/RGBA、独立 RGB、intensity 字段解码。
- 默认只订阅设备端严格同步、遮挡过滤和去重的三目精确彩色点云，避免客户端再次叠加造成拼接杂糅；
  三路诊断点云可在配置中保留。相机画面只订阅当前前/左/右一路，避免 Wi-Fi 重复传输。
- PCD（ASCII、binary、PCL binary_compressed）/PLY/LAS 导入和二进制导出、MCAP 直播录制/快照/末帧加载、3DGS/COLMAP 数据集包。
- 点击邻域选择、裁剪、删除掩码、平移、颜色增益、撤销。
- `0–100 秒` Decay time：按时间窗累积实时点云，过期帧自动移除，并受平台点数预算保护。
- Leaflet RTK 栅格地图和响应式 Windows/Android 布局。

## 架构边界

应用不包含相机/Livox 驱动、MAVLink、MAVSDK、ROS2 runtime 或 Rust 后端。
FAST_LIVO2、`foxglove_bridge`、三目压缩图像发布和硬同步状态均由 omni 设备端提供。

点云源数据保持不变，编辑以操作序列保存；导出时再应用删除、变换和颜色操作。
Android 以 WebGL2 为最低图形能力，不依赖 WebGPU。

## 开发和验证

```bash
npm install
npm test
npm run build
npm run test:e2e
npm run dev
```

真实 FAST-LIVO2 PCD、LAZ 与持续渲染验证可显式传入夹具；持续时间单位为秒：

```bash
LAZ_FIXTURE=/path/to/sample.laz \
FAST_LIVO2_PCD=/path/to/all_raw_points.pcd \
npm run test:e2e

SOAK_SECONDS=1800 \
FAST_LIVO2_PCD=/path/to/all_raw_points.pcd \
npm run test:e2e -- --grep '持续渲染稳定性'
```

桌面开发包：

```bash
npm run electron:pack
```

Android 同步：

```bash
npm run android:sync
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 \
ANDROID_HOME=/path/to/android-sdk \
ANDROID_SDK_ROOT=/path/to/android-sdk \
gradle -p android assembleDebug
```

Android 构建还要求本机设置 `ANDROID_HOME`，并安装 Android SDK Platform 36。

## omni 设备端数据要求

设备端使用 ROS2 Humble。启动顺序由 omni 独立编排，显示端只消费 Foxglove
WebSocket，不负责启动驱动或算法。当前显示协议要求设备端提供：

- 主 `sensor_msgs/PointCloud2`：`/cloud_registered/tri_precise`；设备端负责三目重叠点的
  唯一相机归属。诊断主题为 `/cloud_registered/front`、`/cloud_registered/left`、
  `/cloud_registered/right`。所有彩色点云必须携带 `rgb`、`rgba` 或独立 `r/g/b`
  字段，并统一使用 `camera_init` 坐标系；
- `nav_msgs/Odometry`：`/aft_mapped_to_init`；
- 三路 `sensor_msgs/CompressedImage`；
- `std_msgs/String`：`/omni/sync/status`，建议值为 `locked`、`degraded`、`error`。

三目全分辨率采集留在设备本机；显示通道应采用 JPEG 压缩和受控帧率，避免 Wi‑Fi
发送缓存被原始图像占满。显示端不会订阅当前未渲染的 `/path`，避免持续增长的轨迹
消息阻塞相机切换和点云传输。Foxglove Bridge 示例：

> 备注：旧项目仍可通过单路 `/cloud_registered` 显示。如果点云只有 `XYZI` 而没有
> 颜色字段，显示端会使用青色兜底色；这只能验证几何链路，不能作为三视角彩色点云
> 验收通过。当前 FAST-LIVO2 原生只接收一路相机，设备端必须额外完成三目标定、同步
> 投影着色并发布上述三个 topic。

```bash
source /opt/ros/humble/setup.bash
ros2 launch foxglove_bridge foxglove_bridge_launch.xml \
  port:=8765 address:=0.0.0.0
```

历史项目存档中的单相机 `topics.image` 字段仍可读取，并按前相机显示；新项目使用
`topics.images.front/left/right`。

## 当前限制

- Android 文件选择器会显示全部文件，再由应用校验 PCD/PLY/LAS/LAZ/MCAP 扩展名；
  待导入文件必须先进入手机公开的 Downloads/Documents 或可访问的文档提供器，
  电脑 `/home/...` 和微信私有缓存不会自动出现在手机中。
- Android 导入 PCD 时均匀保留最多 100 万点，桌面端最多 400 万点；原始点数会在状态栏标明。
- PLY 暂不支持 list property 和 big-endian。
- 支持未压缩 LAS 1.0-1.3 point format 0-3；LAZ 通过按需加载的 laz-perf WASM 解码。
- 超大点云外存分块和完整 MCAP 时间轴播放控制尚未接入；当前加载选定通道末帧。
- 3DGS 导出要求选择真实 FAST-LIVO2 `Log/Colmap` 目录；应用会核验相机、
  注册图像、稀疏点和图片是否齐全，拒绝空占位数据，再加入编辑后的 RGB PLY。
