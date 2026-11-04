# 最小几何修订证据

- `before-pr5-head.png`：基线，取自 PR #5 评审头 `79884b7` 构建的界面（生成工程图后，右侧核验面板只有关键尺寸核验；选中尺寸只能改尺寸线位置，定义点不能动）。
- `after-selected-linked.png`：本修订选中横向尺寸后，核验面板明确列出关联墙线端点，图纸上高亮关联墙线（上方提示“选中尺寸关联 3 个端点 · 墙线·实测”）。
- `after-revised.png`：按数值修订 500 mm 后，尺寸随几何重算为 7500.135 mm（显示 7500 mm），修订记录逐项列出修订量、尺寸变化量与残差（-500 / -500 / 0），工具条出现“几何修订 1 项”。
- `after-revised-sheet.png`：修订后的完整图纸视图（同一原因下的整张图，尺寸线与图框同时可见）。
- `after-no-link.png`：选中无关联对象的手工尺寸时，核验面板与修订面板明确提示“没有关联的墙线”，不静默无响应。

## 独立读取器回读（ezdxf）

- `ezdxf-readback.json`：`DXF_READBACK_PYTHON=<ezdxf 1.4.5 解释器> npx vite-node scripts/readback-dxf.ts -- <dxf> <drawing.json> <report.json>` 的输出。两处修订（+25.4 mm、+13.37 mm）在 DXF 中回读为 8025.4 mm 与 6152.904884 mm，最大偏差 0 mm，审计 0 错误、0 修正。
- `revision-readback.json`：成果包内的回读报告（内置回读 + 修订一致性和逐项偏差），最大偏差 0 mm，问题 0 项。
- `drawing.json`：同一成果包的标注清单，用于独立读取器核对尺寸定义。

未验证：目标 CAD 软件打开验收、Windows/Electron 实机与桌面 PDF 渲染（本环境无法运行）。
