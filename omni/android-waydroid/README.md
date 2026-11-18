# Waydroid OMNI 测试 APK

更新（2026-10-13 控制闭环）：当前默认入口已改为控制版
`http://tauri.localhost/index.html`，由用户点击开始或结束并保存。
本机类型检查、构建和实际 APK 的启动/保存/同步链路已验证。
设备项目现支持预览、完整文件下载到 App 私有缓存、离线打开及本机 PCD 导入。
完整文件下载尚未部署到补电离线的 OMNI 主机；本机接口与浏览器流程已验证。
实际 Waydroid 已导入 352.6 万点成果，重启后离线打开与 SHA256 校验通过。
下文只读描述为早期验证版本记录；最新证据见
`docs/omni-scan-control-progress.md` 和 `artifacts/omni-app/control-20261013/`。

此目录是独立 Android WebView 测试壳，嵌入 `omni/dist-app`，包名为
`com.guanyao.omniscan.waydroid`。它不代替尚未构建的 Tauri 正式 APK。
入口为 `http://tauri.localhost/index.html`，使用主机已有来源白名单。
用户点击后才发送采集动作。`?readonly=1` 保留作为只读验证入口。
完整点云存储于 WebView IndexedDB，未实现导出到公共 Downloads 或系统分享。

在 `/mnt/zk/point_view` 构建（本机已有工具链和缓存，无需下载）：

```sh
npm run build:omni:app
ANDROID_HOME=/mnt/zk/point_view/.tools/android-sdk \
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 \
GRADLE_USER_HOME=/home/jn/.gradle \
.tools/gradle-8.14.3/bin/gradle -p omni/android-waydroid \
  --offline --no-daemon --max-workers=2 \
  -Pandroid.aapt2FromMavenOverride=/mnt/zk/point_view/.tools/android-sdk/build-tools/36.0.0/aapt2 \
  :app:assembleDebug
waydroid app install omni/android-waydroid/app/build/outputs/apk/debug/app-debug.apk
```

2026-10-13 验证：安装与底部导航定位通过；APK 内控制接口连续返回 HTTP 200；
Android WebView 的 Foxglove 握手成功，但 `advertise.channels=[]`、服务列表为空，
25 秒内点云和图像解码均为 0 帧，整体结果为 `PARTIAL`。
主机仅有控制服务和 Foxglove，雷达、相机、建图组件未运行；
残留会话导致主机返回 `running`，App 的“正在扫描”不是有效采集证明。
主机状态请求实际超过 5 秒，客户端超时已改为 20 秒，覆盖服务端 15 秒处理上限。

证据位于 `artifacts/omni-app/waydroid-20261013/`。
本轮添加的路由和 NAT 仅在当前运行期间有效，且只面向 `10.42.0.1`；
`network-rollback.sh` 可删除这些规则。未修改持久网络配置、未启停主机传感器栈。
