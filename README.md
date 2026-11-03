# Guanyao Survey Studio 0.10.4

观曜空间数据工作室核心源码，应用入口位于 `windows-studio/`。

主要流程：完整点云导入、单位与坐标核对、框选与高度剖切、平立面出图、CAD 尺寸与文字标注、工程保存与复核成果导出。

## 源码结构

- `windows-studio/src/`：React 界面、点云处理、建筑与工程数据模型。
- `windows-studio/electron/`：桌面主进程、文件存储、设备接收及 PDF 导出。
- `src/cad/`、`src/components/CadPreview.tsx`、`src/domain/`：应用实际引用的共享 CAD 与点云解析模块。
- `windows-studio/tests/`、`windows-studio/scripts/`、`windows-studio/docs/`：测试、验证脚本与工程文档。

根目录保留原有共享依赖清单及锁文件，用于上层模块解析和 LAZ 加载器路径；应用构建入口是 `windows-studio/`，请使用以下命令。

## 安装与运行

需要支持 Vite 6 的 Node.js 与 npm。

```sh
npm ci
cd windows-studio
npm ci
npm run dev
```

在 `windows-studio/` 中执行：

```sh
npm run build
npm test
npm run desktop
npm run pack:win
```

浏览器界面验证使用 `npm run test:ui`，需另行准备 Playwright Chromium。Windows 安装包生成需要相应打包环境。

## 收录范围

版本以 `windows-studio/package.json` 的 `0.10.4` 为准。保留原始源码及开发文档；部分历史文档仍记录较早版本的状态。

本次仅同步核心源码与必要配置，不包含依赖目录、安装包、构建产物、运行日志、实采点云、工程成果或设备会话数据。测试夹具随源码保留；部分实采验证脚本需要自行提供原始数据。

可选 AI 评估模块的 ONNX 权重未纳入核心源码；`windows-studio/public/ai-evaluation/engine.json` 保留模型标识、校验值和原始许可说明。缺少该权重时不能使用对应的本地语义识别功能；核心点云与 CAD 构建不依赖该权重。

本次源码同步不代表独立现场尺寸、Windows 实机或目标 CAD 软件验收。工程边界见 [应用说明](windows-studio/README.md) 和 [架构文档](windows-studio/docs/architecture.md)。
