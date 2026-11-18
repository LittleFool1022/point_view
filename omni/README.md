# OMNI Scan 手机 App 工程

2026-09-11：基于 `release/OMNI-Scan-手机App演示.html` 对应的 React 源码搭建。
保留现有蓝色主操作、深色工具栏、扫描画中画、素材与记录流程。
2026-09-14：新增真实 OMNI 预览入口，复用现有 Foxglove 数据接入与点云画布；保留独立模拟演示。真实主机的点云接收、绘制、同步与 App 重连已在浏览器验证；相机因 bridge 未公布图像话题仍未闭环，也没有生成可安装 APK。

## Ubuntu 日常调试

在仓库根目录执行：

```sh
npm run dev:omni
```

打开 <http://127.0.0.1:5174/lab.html>。默认真实 OMNI 预览，需主动点击连接；调试台“数据来源”可切换到模拟演示。Vite 热更新；在浏览器开发者工具中选择 iframe 检查 App。
独立页面是 <http://127.0.0.1:5174/index.html>，APK 使用同一真实 App 入口。模拟演示为 `index.html?mode=demo`；切换数据来源会重建页面，未保存的模拟扫描不会迁移到真实设备。
默认只监听本机；使用 `Ctrl+C` 停止服务。端口占用时明确报错，不自动换端口。

```sh
npm run build:omni         # 类型检查 + 浏览器交付目录 omni/dist-browser
npm run preview:omni       # 查看浏览器构建产物，端口 4174
npm run build:omni:app     # 类型检查 + APK 内嵌前端 omni/dist-app
```

APK 内嵌构建只包含 App 入口，不包含设备调试台页面。原 `dist`、Electron 和 Capacitor 打包入口保持独立。
浏览器构建产物需要通过 HTTP 服务打开；原 release 单文件 HTML 继续用作离线演示基线。

## 多设备交互

调试台提供 7 个代表性 CSS 视口：320×640、360×780、393×851、412×915、344×882、768×884、800×1280。
Galaxy、Pixel、小米/OPPO 名称仅便于理解典型档位，不是厂商实测参数或已认证机型。
配置见 `src/handheld/preview/devices.ts`，可在明确目标机型后增补。

- 旋转、折叠屏尺寸切换：保持 iframe 和 React 实例，保留当前扫描、表单和视角；可选进入扫描自动横屏。
- 安全区：模拟顶部状态栏、底部手势区域；横屏把留白转到两侧。App 使用相同布局容器读取真实 `env(safe-area-inset-*)`。
- 字号：对主要文字应用 100%、115%、130% 压力档位；不是 Android 系统字体缩放的完整仿真。
- 像素比：1、1.5、2 直接作用于 Three 渲染缓冲区，不伪造浏览器 `devicePixelRatio` 或手机 GPU。
- 网络：正常/5 秒慢连接/设备断线，只控制模拟连接。断线不终止模拟采集计时，预览冻结；恢复网络后点击重新连接。
- 返回键：优先关弹窗；扫描中打开保存面板。原生返回事件预留 `omni:native-back`，Android 系统返回桥尚待生成工程后实现和真机验收。

调试台外层缩放只用于把完整手机屏放进 Ubuntu 窗口，iframe 内的 CSS 逻辑尺寸不变。
机型与方向写入 URL，可复制链接复现布局。默认不开启自动旋转，避免干扰手动检查。

## 代码边界

```text
omni/
  index.html + main.tsx         浏览器与 APK 共用 App 入口
  lab.html + lab.tsx            浏览器调试台入口
  src-tauri/                   Rust 移动入口、配置、权限
src/handheld/
  OmniApp.tsx                  App 容器、安全区、真实/演示入口
  LiveOmniApp.tsx              真实预览、连接和简洁状态界面
  scanner/OmniPreviewSession.ts 只读 Foxglove 会话、超时和最近帧预算
  HandheldDemo.tsx              复用的手机 UI 与模拟项目交互
  scanner/types.ts             ScannerPort / ScanSnapshot
  scanner/SimulatedScanner.ts  模拟设备会话，集中处理命令与阶段
  scanner/useScanner.ts        React 订阅与模拟网络注入
  platform/runtime.ts          浏览器下载 / Tauri 文本导出
  preview/                    设备档位、调试台、同源消息校验
  DemoScene.tsx                Three 双视图、相机与渲染预算
```

`ScannerPort` 是手机端内部接口，不代表设备已有这些 HTTP 或 ROS 方法。
后续真实适配器需核对设备身份、能力、会话 ID、命令回执和落盘清单后实现；不能用计时器推断真机成功。
真实预览复用 `src/transport/foxgloveSource.ts`，默认地址 `ws://10.42.0.1:8765`、点云 `/cloud_registered/tri_precise`，只订阅点云、当前相机和同步状态。不会调用 ROS service、SSH、启动、保存或停止设备。
仅 `mode=demo` 中的扫描/传输/RTK/云端状态为模拟；刷新演示页面会重建模拟会话，演示索引保存在浏览器 localStorage。真实入口不读入模拟项目，不将网络连接或收到点云视为设备扫描已开始。
模拟项目记录不等于真实点云文件，DXF 是固定示意平面。

### 生产控制适配

手机不能直接执行主机 shell。`/mnt/zk/3DGS/scripts/rk3588/omni_app_control_server.py`
提供独立的 `8766` 控制端口，并且只允许以下映射：

- 开始扫描：`production_fast_livo.sh start small-2k`
- 结束并保存：`production_fast_livo.sh pcd`
- 停止且不保存：`production_fast_livo.sh stop`
- 状态接管：`production_fast_livo.sh status`

适配器默认只读；仅显式传入 `--allow-actions` 才开放生产操作。它使用单任务锁；`pcd` 和 `stop` 必须提交当前 `expectedSession`，会话变化时拒绝执行。
App 打开后先读取状态，已有会话只显示接管入口，不重复启动。`pcd` 会结束采集栈，界面不得简称为普通保存。
适配器没有上线时，实时 Foxglove 预览仍可独立使用，采集按钮保持禁用。

生产部署将控制面与数据面分离：`omni-app-control.service` 常驻 `10.42.0.1:8766`；Foxglove `8765`
仍随扫描栈运行。App 先连接控制面，设备空闲时静默提交默认 `small-2k`，仅当 `previewReady=true`
后连接 Foxglove。这样保存结束后 8765 关闭不会被误报为设备网络断开。

首页只保留进入实时预览和结束并保存两个主要动作。高级设置可将下一次启动参数切换为
`small`、`small-2k` 或 `large`；默认始终是 `small-2k`。用户执行保存或停止后，当前页面不会自动新建扫描。

小型文本导出：浏览器调用下载；Tauri 调用 Rust `save_demo_text`，写入应用私有 `exports` 目录。
原生文件名拒绝路径穿越，同名文件保留时间后缀，内容上限 1 MiB。Android 文档选择器、系统分享与大文件流式下载待实现；私有目录不等于公共 Downloads。

## Android 工程与 APK

采用设计稿约定的 React + Tauri 2 + Foxglove 方向；独立应用标识 `com.guanyao.omniscan`。
`minSdkVersion=28` 是首版 Android 9+ 安装下限，不是所有 Android 9 设备均已兼容的承诺。
Tauri 使用系统 Android WebView；WebGL2、软键盘、返回键、安全区、触控、后台恢复与文件访问必须在目标设备上验收。

本轮项目内已安装 Tauri CLI 2.11.4，并记录 `omni/package-lock.json`；未进行全局安装。
新检出工程先在仓库根目录执行 `npm ci`，再执行 `npm ci --prefix omni` 安装原生 CLI；日常浏览器调试只依赖根目录前端依赖。
本机有 Rust、JDK 21、Android SDK，但没有 Android NDK、Android Rust target 和 Emulator。
真实执行 `tauri android init --ci --skip-targets-install` 返回 `Android NDK not found`，因此尚无 `src-tauri/gen/android`、Cargo 锁定构建或 APK。

```sh
# 只读检查；缺失依赖时返回非零，不自行安装
npm --prefix omni run android:doctor

# 在 NDK、对应 Rust target 已配置后执行
npm --prefix omni run android:init
npm --prefix omni run android:build       # arm64 真机 Debug APK
npm --prefix omni run android:emulator    # x86_64 Debug APK
npm --prefix omni run android:dev         # 已连接设备或已配置的 AVD
```

运行器优先读取 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`；未指定时使用本机 JDK 21 和仓库 `.tools/android-sdk`，NDK 从 SDK 下已安装版本中选取。
环境设置只传给当前子进程，不改 shell 配置或系统默认 Java。初始化默认 `--skip-targets-install`，不会自动安装全局 Rust target。
ARM64 所需 target 为 `aarch64-linux-android`，x86_64 模拟器为 `x86_64-linux-android`。
Android SDK/NDK、系统镜像的安装与许可接受属于下一步环境准备，需用户确认后处理。

构建成功后的 APK 由 Tauri/Gradle 放在 `omni/src-tauri/gen/android/app/build/outputs/apk/`；此处是预期位置，当前不存在 APK。
正式发布还需应用图标定稿、release 签名、版本策略与设备验收。当前壳复用仓库已有图标，不写入签名密钥。

## 2026-09-11 历史验证（仅模拟版本）

- `npm run build:omni`：类型检查和浏览器构建通过。
- `npm run build:omni:app`：APK 内嵌前端构建通过，输出只有 `index.html` 和 `assets`；这不是原生 APK 编译。
- 7 个尺寸首页：内容宽度未超过视口，底部导航位于安全区内；见 `artifacts/omni-app/device-layouts.json`。
- 浏览器交互：连接→开始→旋转→断线计时分离→重连→暂停→返回保存→模拟下载→JSON 导出通过，页面异常记录为 `[]`。
- 首轮自动化因连接弹窗按钮定位过早中断，限定弹窗内按钮后完成上述流程。
- Tauri JSON 配置依据已安装 CLI schema 校验通过；Android 工程生成在 NDK 检查处停止。
- 紧凑屏、Pixel 类、折叠展开、平板的横竖屏 130% 字号预览已检查，预览页标题与状态条未重叠；见 `capture-layouts.json`。这不覆盖所有扫描状态和系统字体行为。
- 尚未验证：原生编译/APK安装、厂商 WebView、安全区真值、软键盘、系统返回、后台恢复、真实扫描与传输、云服务。

截图：`artifacts/omni-app/lab-home.png`、`lab-capture.png`；交互结果：`browser-check.json`；导出示例：`export-demo.json`。

参考：[Tauri Android 前置依赖](https://v2.tauri.app/start/prerequisites/#android)、[Tauri 配置](https://v2.tauri.app/reference/config/)、[Android WebView 安全区](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets)。

## 真实主机接入：当前证据与实施边界

2026-09-14 已只读连接固定 OMNI，确认 `orangepi@orangepi5max` 与 Skill 指纹一致；当次查询无 `8765` 监听，也未发现 FAST-LIVO/Livox/Foxglove/三目相机进程。此记录不是未来运行状态的保证。没有运行主机 start/stop/pcd、部署配置或构建，没有修改 `/mnt/zk/3DGS`，不接管该目录正在进行的候选优化。

主机契约通过当前源码核对：

- `/mnt/zk/3DGS/config/foxglove_bridge_production.yaml`：Foxglove 绑定 8765，提供点云、里程计、同步状态等；三路 `/omni/camera/{front,left,right}/image/compressed` 没有列入生产白名单。App 会等待真实图像，不能据相机发布器存在宣称预览可用。
- `/mnt/zk/3DGS/scripts/rk3588/production_fast_livo.sh`：`start {small|small-2k|large}`、`status`、`pcd [--only]`、`stop` 是主机 shell 操作。`pcd` 成功后停止采集栈，不能当作普通“保存副本”。
- `omni_mapping_services.py` 与 FAST-LIVO2 当前导出使用 `/save_true_color_pcd` (`std_srvs/srv/Trigger`)，Foxglove 白名单却是 `/save_color_map`。本 App 不调用任何导出服务。
- 尚未定位到手机可用的设备身份、会话控制、文件列表及下载服务。开始/结束、暂停/恢复、记录/下载不伪造成功；设备会话保持未知。

实现边界：

1. 连接失败/8 秒超时返回可重试状态；只允许显式 WebSocket 地址，不携带用户名、密码或查询参数。
2. 最近一次接收超过 3 秒标记过期；同步、相机和点云分别计时，网络连接不等于数据已就绪。
3. 最多保留最近一帧的 12 万点展示预算，不累计完整地图。解码仍复用现有 Worker，接收时的完整消息开销并未因此消失，真机内存/帧率待测。
4. 相机按 bridge 公布的前/左/右话题选择，切换时重建订阅并清除旧画面；当前相机未开放时选择已开放相机，无可用相机时只显示简短不可用提示，少于两路时隐藏切换操作。离开前台后断开预览，回到前台仅在此前主动连接过时重新连接；不会重发任何采集命令。
5. 调试日志、topic、协议字段、原始错误只出现在外层开发调试台。App 无诊断面板、无原始异常文本，仅显示简短连接与画面状态。用户体验要求：简洁、流畅。
6. 预览通道尚无权威设备身份与会话接口，不能用 IP、WebSocket 已打开或收到点云作为设备身份或采集状态证明。

## Android Debug 网络准备

`tauri.conf.json` 的 `connect-src` 已允许 WebSocket。`omni/android/debug/` 提供 Android Debug 网络配置，`omni-android.mjs` 在成功生成工程后、后续开发/构建前复制到 `app/src/debug/`；已有自定义文件冲突时停止，不覆盖。当前缺少 NDK 和 Rust Android target，因此尚未实际生成或验证 Gradle 合并结果。

模板只开放 `10.42.0.1`、`localhost`、`127.0.0.1`、`10.0.2.2` 的明文开发连接。使用其他 `TAURI_DEV_HOST` 或设备地址前需调整模板并合并 Debug source set；Release 网络策略与目标 Android WebView 兼容性另行验收。依据：[Android 网络安全配置](https://developer.android.com/privacy-and-security/security-config)、[Tauri Android manifest 模板](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/templates/mobile/android/app/src/main/AndroidManifest.xml)。

## 2026-09-14 首轮本机协议验证

- 用户已于 2026-09-14 授权最小本地验证；前端类型检查、APK 内嵌前端构建及以下验证通过。Android 原生配置仍未编译、安装或实机验收。
- `node scripts/omni-android.mjs doctor` 当前输出 `MISSING Android NDK` 和 `MISSING Rust Android target: aarch64-linux-android`；未安装或修改全局环境。
- `timeout 60s npm run build:omni:app`：通过，生成 `omni/dist-app/index.html`、点云/图像 Worker 及样式资源；有大于 500 kB 的分块提示，未据此承诺手机性能。这不是可安装 APK。
- `timeout 60s npm run test -- src/handheld/scanner/OmniPreviewSession.test.ts`：4 项通过，覆盖迟到回调隔离、连接超时释放、各数据流独立过期、预览抽样的属性对应关系。与随后 CSS 修正无关，未重复执行。
- `timeout 60s node scripts/validate-omni-preview.mjs`：7 项浏览器检查通过，`browserErrors=[]`；本地 Foxglove/CDR 夹具验证点云、图像、同步接收，相机切换、过期、断线重连、演示隔离及 App 无调试详情。夹具收到的客户端操作只有 `subscribe`，无控制调用。
- 浏览器检查实际发现并修正了横屏画中画遮挡返回按钮、设置页底部导航遮挡断开按钮的问题：真实模式样式最后加载，操作层高于画中画，内容在独立区域滚动。修正后重新验证，旋转/切换主画面保持同一个 WebGL canvas。
- 验证脚本初次启动因 `ws` 缺失及 Foxglove CommonJS 导入方式失败，改为复用已安装 Playwright 的 WebSocket 实现与 CommonJS 导入，无新增依赖；最后的演示选择器也按实际可访问名称修正后完成验证。重跑均因新增修正或前轮未完成，未增加宽泛回归。
- 报告：`artifacts/omni-app/real-preview-check/result.json`；截图：`live-preview-lab.png`。成功数据均来自独立本机夹具，图像使用项目图标，不能称作 OMNI 真机扫描结果。验证结束后关闭本次浏览器、Vite 和夹具服务。
- 同一浏览器对 `ws://10.42.0.1:8765` 的只读连接观察为 `connection=error`、`WebSocket error`，没有收到真实点云或图像，没有启动或重启远端设备链。
- 此轮真机观察发生在用户启动服务之前；后续实际结果见下节。
- 完整采集 APK 仍依赖明确的主机会话/身份/保存结果及文件服务契约。新增主机服务或改变生产脚本前，需要协调当前 3DGS 优化的所有权与部署范围，不能用页面定时器补齐。

## 2026-09-14 主机启动后的 App 实际闭环

用户确认主机已完全启动，并将本轮范围限定为 App 连接及数据闭环。仅在本机启动浏览器/Vite，通过 App 订阅 `ws://10.42.0.1:8765`；没有 SSH、主机配置修改、节点启停或 3DGS 修改。

- 首次连接建立并收到真实点云，但等待相机超时。实际公告只有 `/aft_mapped_to_init`、`/cloud_registered`、`/cloud_registered/tri_precise`、`/omni/sync/status`、`/path`、`/rgb_img`、`/tf`，没有三路相机压缩图像。
- `/rgb_img` 源于 `LIVMapper::publish_img_rgb()` 的 `vio_manager->img_cp`；`VIOManager::plotTrackedPoints()` 会画跟踪标记。App 没有自动将这路算法图像当作干净相机画面。
- App 已增加相机可用性判断；本次真实无相机话题场景验证了简短不可用提示及无效切换按钮隐藏。仅部分相机开放时自动选路的分支尚未在真机验证。
- 改动后 `timeout 60s npm run build:omni:app` 通过类型检查与前端构建。原生 APK 尚未构建。
- `timeout 60s node scripts/validate-omni-host.mjs` 输出 `PARTIAL`（退出码 2），明确保留相机缺口。5 项检查完成：真实握手公告、连续点云与同步接收、无相机时的 App 状态、横屏及主画面切换保留同一 canvas、主动断开后重连恢复数据。
- 收帧样本包含 8 帧点云，时间跨度 1102 ms，样本末帧 32,331 点；同步收到 2 条，状态 `locked`。这是短时浏览器收帧观测，不是手机 GPU 帧率、长稳测试或图像与点云的空间配准证明。
- `browserErrors=[]`，客户端操作仅 `subscribe`，没有服务或采集控制调用。App 页面未出现调试详情。
- 报告与实际点云截图：`artifacts/omni-app/host-preview/2026-09-14T03-07-04-713Z/` 下的 `result.json`、`cloud.png`、`cloud-landscape.png`。第一次缺图像的失败证据保留在相邻 `2026-09-14T03-03-24-861Z/`。

相机闭环需要主机侧在现有 8765 bridge 开放 `/omni/camera/{front,left,right}/image/compressed`。App 已具备对应订阅与解码入口；实际三路图像显示与切换应在这些话题可见后完成验证，当前不宣称通过。
