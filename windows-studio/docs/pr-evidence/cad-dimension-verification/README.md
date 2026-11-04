# 关键尺寸核验证据

- `before-baseline.png`：基线截图，取自 PR #3 评审头 `f222a5b`（改动画面前）。
- `after-verified.png`：`0ae2167` 导出并录入独立参考后的状态。
- `after-expired.png`：`0ae2167` 图纸视图切换并重建后核验过期的状态。
- `readback-*.json`：ezdxf 独立读取导出 DXF 的结果（单位、原生标注测量值、审计）。

复现：
`DXF_READBACK_PYTHON=<带 ezdxf 的 python> npx vite-node scripts/readback-dxf.ts -- <drawing.dxf> <drawing.json> <report.json>`
