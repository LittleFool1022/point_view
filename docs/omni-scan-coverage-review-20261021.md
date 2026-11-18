# OMNI Scan 累计预览与交互修改审查

状态：本地源码设计及实现 review 通过；最小测试与构建通过。用户明确授权后，已通过 App 启动一次真实扫描并收到真实点云/相机图像；移动累计与性能验收尚未放行。没有部署或替换真实主机源码/二进制。

## 审查记录

三名独立只读 Agent 分别审查数据契约、渲染性能、会话生命周期。首轮均 BLOCK，补齐长期 Worker 生命周期、会话/坐标系/epoch 隔离、启动失败冻结、消息单槽与立即 ACK、空间预算后，三方设计 PASS 才开始源码修改。实现复审发现的启动门禁和交互 LOD 问题也已修正并取得 PASS。

额外的扫描点云 CDR 解析迁入 Worker，在两个 Agent 审查 PASS 后实施，实施后的数据契约复审 PASS。扫描交互预算由 50k 调至 10k、DPR 由 0.75 调至 0.5，及全域 stride 排列方案亦在渲染 Agent PASS 后实施。

## 最终修改

- `ScanPreviewAccumulator.ts` / `scanPreview.worker.ts`：5cm 起始空间体素、最多100k体素；超限空间粗化，保留旧区域代表点；原始 RGB 与历史降低亮度的显示 RGB 分开；200ms 输出间隔、一个未 ACK 快照。展示数组与累计状态不共享所有权。
- `OmniPreviewSession.ts`：累计 Worker 不随切相机、网络重连终止；完整 token 包含设备地址、确认会话、坐标系和 epoch；输入最多一帧处理中及一帧最新待处理；收到快照立即 ACK。未知设备状态冻结写入；启动、启动失败、坐标变化、卸载有独立隔离和释放路径。
- `LiveOmniApp.tsx`：控制请求与启动动作隔离过期回调；确认会话后才累计；首次累计取景与手动复位使用 Worker bounds；帮助明确预览缺帧不回填。
- `PointCloudCanvas.tsx`：复用现有画布和 OrbitControls；扫描 RGB 使用预计算颜色、容量复用 buffer；拖动期间仅保存最新待提交快照；交互前缀最多10k点且均匀覆盖全域，DPR0.5，松手恢复。其他编辑入口的原有预算保留。
- `pointCloud.worker.ts` / `foxgloveSource.ts`：仅扫描入口将 ROS/CDR 解析一并迁入解码 Worker；其他调用默认沿用原路径；原始数据钩子保留，转移独立副本。
- `pointCloud2.ts` / `types.ts`：保留真实 frame 声明标记，增加扫描展示元数据。

此功能仅累计本次 App 运行中实际接收到的预览；断连、后台、中途接入前和 App 被销毁后的历史不补齐，不等同设备完整地图。

## 验证与边界

1. 最终最小单元测试：3个文件、10项通过，覆盖空间累计、颜色/强度重排、交互前缀全域分布、预算粗化、buffer转移、会话与迟到消息隔离、启动失败冻结和 frame 声明。
2. `npm run build:omni:app`：最终源码类型检查与前端构建通过。Gradle offline `:app:assembleDebug` 通过。
3. 已安装本机 Waydroid 测试包 `com.guanyao.omniscan.waydroid`；这是现有 Android WebView 测试壳，并非 Tauri 正式手机包。保留原项目记录和画质设置，原 APK 备份为 `artifacts/omni-app/scan-coverage-20261021/before.apk`。
4. 50k交互版本的本机夹具验证涵盖累计 A+B、切相机、暂停/恢复、双指平移缩放、实际 Android Home/前台恢复、新会话清空与后续预算稳定。最终10k版本验证了累计 A+B、持续收帧触控；生命周期代码没有在参数调整中改变，但完整组合未重跑。
5. **性能尚未通过。** 最终10k版本在Waydroid本机60k点/帧、10Hz、无图像的夹具下，rAF P50=50ms、P95=122.3ms，未达到最初建议的33ms目标。旧版、不同参数及不同测试窗口不用于精确收益比较。CPU profile 显示有图像时 `createObjectURL` 占用明显，无图像/静态点云输入隔离后仍有GL驱动调用阻塞。不得把功能脚本中的早期 `PASS` 当作性能放行；脚本现已将性能不达标输出为 `PARTIAL`。
6. CDP `Page.captureScreenshot` 漏掉此 Android WebView 的 WebGL 图层；实际显示以 Android `screencap` 为准。`native-region-AB.png` 可见旧区域与较亮的新区域。
7. 浏览器软件渲染夹具两次超时，未作为通过证据；后续以用户指定的Waydroid实际App为主要验证入口。

## 真实主机当前连接

已实时核对 SSID=OMNI、WLAN直连路由、既有ED25519指纹和远端身份 `orangepi@10.42.0.1` / `orangepi5max`。SSH、控制接口和Foxglove握手成功。

当前接口返回 `state=idle`，`livox=false`、`camera=false`、`mapping=false`；Foxglove `channels=[]`。返回的会话为历史会话，不能据此宣称设备正在扫描。

Waydroid App 已通过本机临时只读中继接入真实主机，页面 `?readonly=1` 显示“累计预览已连接”，实时点云为0；中继拒绝POST，未修改路由、防火墙或远端配置。证据：`artifacts/omni-app/scan-coverage-20261021/real-host-app-result.json`、`real-host-app.png`。

以上是启动前只读连接证据；后续授权和真实扫描记录见下节。

最终本地测试APK SHA256：`ca7d9bbe016d387fb5b296a108a5e3c46c7976ae9fed52bdd1250b7acb1ad27c`。

## 2026-10-22：授权后的真实扫描及补充修订

- 用户回复“允许”，明确授权一次真实扫描。经重新核对 Wi-Fi、路由、主机指纹、身份和待机状态后，临时本机中继仅开放 start/pcd/stop 控制路径，App 页面退出只读模式，由真实开始按钮提交一次 `/api/v1/actions/start`。未直接调用 shell 启动传感器。
- 新会话 `production_small_20260930_212133`，start job `fc89e5719c41420cbb02b2ee65cf3bdf` 最终 `succeeded`。实际相机、雷达、建图均运行，设备累计点数持续增长。
- 发现启动期 WebSocket 已连但频道公告为空，App 仍为0点。手动 App 暂停/恢复预览后收到10个真实频道，得到12,552预览点和真实2048宽相机图像。证据：`real-scan-start-result.json`、`real-scan-observe-result.json/png`。
- 真机触控测量81个rAF样本：P50=33.3ms、P95=66.7ms、最大82.7ms，未记录到50ms以上主线程长任务。仍未达到建议的P95≤33ms，不能放行性能。
- 连续35秒观察中，App累计预览26,996→28,178点、图像宽度2048；独立里程计订阅388样本，最大位移约0.00185m。尚未证实用户完成1–2米移动，因此不能把该记录当作移动区域保留验收。已向用户给出移动与放稳提示，等待必要物理配合。
- 本轮测量没有新增 start/save/stop 请求。扫描仍运行，为用户移动验证保留原APK和累计缓存。

### 启动频道发现恢复修订

两名Agent先审查修订设计，补齐“现有session自动重连也计入最多两次预算”的约束并分别PASS后，才修改产品源码：

- `setScanIdentity()` 返回实际 source 重建结果及连接generation；同步构造失败不误计数。
- `rediscoverPreview()` 只重建网络预览，保留累计数据，不产生设备控制动作。
- `PreviewDiscoveryBudget.ts` 将session重连、随后正常自动连接或显式发现计为首次，首次连接后最多再做一次2秒目标频道检查；不会叠成三次发现。
- `LiveOmniApp.tsx` 只对本地发起且成功的start job分配预算，key绑定control epoch、规范设备地址、确认session、job ID；延迟检查同时核对generation、前台和预览需求；暂停/后台/切会话取消预算。

实现复审发现同步建连失败误计预算，修正后两方实施审查无阻塞。最终最小测试为4文件15项通过，最新前端类型检查/构建通过。此修订未在当前真实扫描中重装，以免丢失正在验证的App内存累计地图；真实自动发现回归仍未完成。

上文APK哈希对应当前已安装、参与真实采样的版本；新恢复修订的候选包需与该版本区分。

## 用户要求结束后的状态

用户明确要求结束扫描后，App 保存请求因临时中继未转发Content-Length而未被控制服务接受；已修正中继文件，改用主机控制接口提交同一会话的pcd操作。控制job为`df37db178a294f5f950bdb780c5d0ef0`。

最终已核对 `state=idle`、`session=null`，雷达/相机/建图均停止，相关采集可执行进程查询无残留；只保留连接服务。点云导出及电脑备份完成，`backupVerified=true`：

- 文件：`/home/orangepi/fast_livo_runtime/static_pcd/production_small_20260930_212133/tri_true_color_20260930_214401_966.pcd`
- 点数：8,513,369；大小：340,536,494字节。
- SHA256：`3fe5af83dbd791876dfbab29c852a44e3a20353dc5a2e4dc5945e4700a7e7030`。
- job状态为`warning`、退出码3，消息为“点云已保存，完整性检查存在告警”；不据此宣称采集质量通过。

结束证据见`artifacts/omni-app/scan-coverage-20261021/real-scan-final-state.json`。临时本机中继已恢复只读模式；没有再次启动采集，移动验证不再继续。
