# OMNI Scan 点云上云接口与实施约定

本轮结果：在现有 Waydroid App 增加项目级“一键上云”，配套可替换的通用 REST 接口和本地参考服务。尚无生产云地址或登录体系；默认未配置，不向任何外部地址自动发送数据。

## 业务流程

1. 打开项目，在查看器底部点击“一键上云”。未配置时打开云服务设置；服务地址持久保存，Bearer 凭证仅在本次 App 运行期间保留。
2. 一次只处理一个项目。优先读取 App 内完整文件；仅有设备预览时，先从设备取得完整 PCD 并缓存。设备文件下载中断后仍需重新下载，云端上传支持续传。
3. Worker 校验完整文件 SHA256。上传原始 Blob，不上传显示抽样、rosbag 或其他会话文件。
4. 创建或查询相同内容的上传任务。按服务端已确认字节偏移逐块发送，进度区分准备文件、上传、云端校验。
5. 完成接口返回大小和 SHA256 一致的完成回执，才标记“已上云”。同一服务、相同 SHA256 的重复点击可直接取得已有回执。
6. 暂停或网络失败保留本地文件及待继续状态；重开 App 不自动上传，用户点击继续后查询服务端偏移。切换页面继续当前任务，切换云地址或凭证需先暂停。
7. 保存到设备、下载到 App、上传到云服务是独立状态；上云失败不修改扫描或设备文件。

## 接口契约 v1

生产服务采用 HTTPS，认证头 `Authorization: Bearer <access-token>`。局域网 HTTP 仅用于自建内网/本机联调。响应均为 JSON，不返回服务器文件路径。浏览器/App Origin 必须在服务端允许列表内。

- `POST /api/v1/pointcloud-uploads`：请求 `{projectId,name,fileName,bytes,sha256,points}`。返回 `{uploadId,offset,chunkSize,receipt?}`。`receipt` 存在表示内容已完成。重复创建按内容 SHA256 幂等；多租户部署须在认证租户内去重。
- `GET /api/v1/pointcloud-uploads/{uploadId}`：取得已确认偏移及回执。
- `PUT /api/v1/pointcloud-uploads/{uploadId}`：二进制块，头 `Content-Type: application/octet-stream`、`Content-Range: bytes START-END/TOTAL`。返回 `{uploadId,offset}`，只确认已经写入的连续字节。初版块长 1 MiB。
- `POST /api/v1/pointcloud-uploads/{uploadId}/complete`：完整文件校验后返回 `{state:"completed",objectId,sha256,bytes,completedAt}`。完成操作幂等。客户端核对回执内容，不能把 HTTP 200 或字节发送完毕当作成功。

错误：401/403 认证失败；404 任务不存在；409 偏移冲突/文件未传完；413 文件超限；422 内容校验失败。失败后不自动从零重复整文件上传；用户继续时重新创建/查询任务。

## 参考服务边界

`scripts/omni_cloud_server.py` 使用 Python 标准库，仅为单租户接入参考。支持 Bearer、来源白名单、续传、SHA256 校验、原子落盘和内容去重。仅接收 PCD，单文件上限与 App 一致为 512 MiB。非回环监听必须提供 token 文件。生产部署仍需 HTTPS 入口、账户/租户认证、容量管理和备份策略；本轮不擅自创建收费云资源或公开公网入口。

## 验收与部署顺序

先恢复 Waydroid 并观察原 App；再完成接口、参考服务与界面；验证暂停续传、重复提交、坏回执/坏文件不成功、身份与跨域限制；构建前端和测试 APK；最后备份旧 APK、保留应用数据替换，在 Waydroid 用合成 PCD 对本机参考服务完成端到端上传。验收不启动真实传感器采集，也不上传已有真实项目到外部云。

## 运行参考服务

```sh
python3 scripts/omni_cloud_server.py --bind 127.0.0.1 --port 8788 --storage ./cloud-pcd-storage
# 非回环联调或部署需提供自己的私有凭证文件；前端填其内容，不包含 Bearer 前缀。
python3 scripts/omni_cloud_server.py --bind <内网IP> --port 8788 \
  --storage ./cloud-pcd-storage --token-file /path/to/private-token-file
```

浏览器/Android 以参考服务的可达地址作为 API 根地址，生产时应通过 HTTPS 入口访问。
设备热点没有互联网时，App 会先保留已取得的完整文件；可换到可联网网络后点击继续上云。
参考服务的回执描述文件对象，不包含云端项目目录或下载分享能力。

## 本轮验证与部署

- 客户端 6 项测试、参考服务 4 项测试通过；本地浏览器对真实参考服务验证 1 MiB 暂停续传、去重、回执校验及凭证不持久化。
- 额外验证仅有设备文件的项目：只下载一次完整文件，缓存后上云；刷新设备列表及重开 App 都保留完成回执。
- Waydroid 原生 App 实际上传新生成的合成 PCD，2,400,132 字节，3 个 PUT 块。云端落盘 SHA256 与客户端一致：`cf67a3f82d8cb4789408bd8ac802d074deb04f88e15d07073acabdd466a98b83`。
- 原生流程的初次收尾等待了错误路由；只修正收尾检查，没有重新上传。最终清理确认 18 条原有项目、3 个缓存条目和 177,562,161 字节完整点云缓存保留。
- 测试 APK 已更新安装到 Waydroid，包名 `com.guanyao.omniscan.waydroid`；已安装文件与交付包 SHA256 一致。前端资源内容也与构建一致。
- 本轮没有上传原有真实点云，没有启动采集或保存。合成测试记录、临时云地址与凭证已清理；App 保持未配置云服务。临时参考服务在验收后停用。
- 构建产物与证据：`artifacts/omni-app/cloud-20261014/`，最终部署记录为 `deployment-result.json`，原生回执为 `native-cloud-final-result.json`。

界面修订（2026-10-15）：记录列表移除逐项上云按钮，只展示等高项目信息卡片；上云入口集中在项目详情。任务进行时，离开详情仍显示一条全局进度与暂停入口。
