# 墙网人工复核编辑（模型层）：连接 / 补墙 / 删伪影 / 确认洞口

本文件说明人工复核处置在模型层怎么落、怎么记录、重新自动拟合时怎么处理，以及真实样本演示脚本的口径。

## 1. 入口与数据结构

- 代码：`windows-studio/src/domain/buildingReview.ts`（处置与分析），`windows-studio/src/domain/building.ts`（模型字段与核验）。
- 处置 API：`applyReviewAction(model, request)`，`request.kind` 取 `connect` / `add-wall` / `remove-wall` / `resolved-opening`。
  返回 `{ model, action, undo }`：新模型、处置记录与单步撤销帧；入参模型不被修改。
- 撤销：`ReviewUndoStack`（把 `undo` 帧压栈后 `undo(model)`）或直接 `applyUndo(model, frame)`。
  UI 现有的整模型撤销/重做（`App.tsx` 的 `modelHistory`）同样覆盖这些处置，因为每次处置都返回新模型。
- 房间不“造”：每次处置后按更新后的墙网几何重算本层房间与未闭合清单（`levelRoomsAndIssues`），
  其它楼层结果保持不变；未闭合问题编号与人工标记（确认洞口、已连接）按位置与墙段对应保留。

## 2. 墙段与记录字段（`survey-building/1` 兼容扩展，均可缺省）

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| `source` | `Wall` | `{ kind: "fit" \| "manual", origin, at, issueId?, actionId? }`；人工新增/修改的墙段为 `kind=manual`，与自动拟合来源可区分 |
| `removed` | `Wall` | 软删除留痕 `{ at, operator: "manual", reason, issueId?, actionId?, wall }`，`wall` 为被删段原样（含来源） |
| `resolution` | `UnclosedIssue` | `"resolved-opening"`：人工确认为洞口，不计入未闭合，记录保留 |
| `closedBy` | `UnclosedIssue` | `{ actionId, at }`：墙段全部被人工删除后，相关未闭合项按留痕折叠 |
| `reviewActions` | `BuildingModel` | 处置记录数组：`{ id, issueId?, action, operator: "manual", at, source: "review", levelId, roomsBefore, roomsAfter, wallIds, note }` |
| `reviewPolicy` | `BuildingModel` | `"block-on-fit"`（缺省）或 `"rehang"`，见 §4 |

`assertBuildingShape` 校验以上字段结构；`validateBuilding` 新增提示项 `MANUAL_WALL`、`WALL_REMOVED`、
`RESOLVED_OPENING`、`CLOSED_BY_REVIEW`（`REVIEW_CODES`）。这些提示随工程保存、在检查与交付视图可见，
但不属于几何或关联错误：工程打开（`validateProjectState`）与尺寸核验（`assessAccuracy`）只拒绝其它错误码。

## 3. 四种处置

1. **连接两端**（`connect`，必填未闭合项 ID）：两端落到墙网既有交点/吸附落点口径——
   - 缺口另一端就在宿主墙段端点上且贴着同一墙轴（≤ 一个墙厚，如 0.03 m 贴合缺口）：按节点合并，端点对齐到缺口位置，不补墙；
   - 缺口另一端落在墙网吸附范围（墙轴投影点/既有节点，≤ 0.25 m）：问题端所在墙段端点吸附过去；
   - 补墙后用连接处理同一缺口：两端取补墙段端点，只吸附其两侧墙段，不重复生成连接墙轴；
   - 其余：沿缺口生成一段 `source=manual` 的连接墙轴，问题端墙段吸附到该交点；
   - 连接会让墙段长度归零时拒绝并提示改用补墙；处置后房间与未闭合清单按墙网几何重算。
2. **补墙**（`add-wall`）：两点新增一段墙，`source={ kind:"manual", origin:"manual", at, issueId, actionId }`，
   墙高/墙厚取该层已有墙段，端点先按吸附落点口径校正；处置记录含 `issueId`。
   补墙不改未闭合项的几何判定：是否闭合仍由墙网与后续连接/确认处置决定，不静默关闭清单项。
3. **删伪影**（`remove-wall`，须填原因）：软删除，`removed` 留痕记录被删段来源与原因，墙段不再参与墙网与房间；
   涉及墙段全部删除的未闭合项折叠为 `closedBy`，可撤销恢复。
4. **确认洞口**（`resolved-opening`）：同一条缝两端各报一条时一并标记 `resolution=resolved-opening`；
   未闭合数减 1（或 2），问题记录保留并在检查中显示为 `RESOLVED_OPENING`，不据此生成房间。

人工墙段不参与自动尺寸核验的“独立实测”口径：`assessAccuracy` 跳过 `manual` 墙段的核验项，
报告 `counts.skippedManual` 与相应限制说明；`accuracyReferenceTemplate` 也不再列出人工墙段。

## 4. 重新自动拟合时的人工构件处理（采用 `block-on-fit`，可切到 `rehang`）

- **`block-on-fit`（缺省）**：`reconcileFit(model, refit)` / `reviewFitImpact(model)` 在拟合前列出将被覆盖的人工墙段
  与随之失效的处置记录，抛出阻断错误，**不执行拟合**；原模型不变，处置记录与人工墙段都在。
- **`rehang`**：拟合后保留人工墙段与处置记录并重新挂接——人工墙段按所在楼层（名称相同）挂回；
  新拟合已有同轴同长墙段的不重复添加（记入 `covered`）；其余端点按墙网节点容差吸附；挂接后墙网几何已变，
  房间与未闭合清单按墙网几何重算，人工确认洞口/已连接标记按位置与墙段对应保留。

两条路径都不静默删除人工墙段与处置记录；缺省阻断是保守选择，复核者可以选择 `rehang` 继续。

## 5. 验证

`windows-studio/tests/wall-review.test.ts`（`npm test`）：

- 夹具：8×6 m 房间东墙 0.6 m 缺口（两侧平行墙，墙网不自动补）→ 补墙成房净面积 7.8×5.8；连接两端成房；
  3 cm 贴合缺口 → 节点合并不新增墙段；删伪影软删除留痕且墙网计数正确；1.2 m 门口 → 确认洞口后未闭合数减 1、
  无房间、检查项可见；处置后 `encodeProject`/`decodeProject` 往返一致；`rehang` 与 `block-on-fit` 两条路径；
  人工墙段不参与尺寸核验；单步撤销回到处置前。

## 6. 真实样本演示（脚本化，非人工界面操作）

脚本：`SURVEY_REAL_FIXTURE=<原件> npm run review:wall-sample`（`windows-studio/scripts/review-wall-sample.ts`）。
只读源件并在首尾核对 SHA256；输出 `artifacts/wall-review/<样本名>/review-demo.json`，含处置条数、
每步房间数变化与最终房间数/面积；不写入、不改动任何已保存工程，不连接设备、不部署。

脚本按固定规则挑处置：最大缺口先连接两端（前 20 条），≤0.3 m 的剩余缺口补墙（前 10 条），
两端都不接其它墙段的孤立段按长度删前 3 条，剩余最大缺口前 5 条确认洞口。

> 本次提交时该样本原件已不在本机（`tri_true_color_20260911_200108_286.pcd`，SHA256
> `6194be9e2bc4ac14f1116bbc206c56dfbec7ded45b2b07bba497904de669293a`，此前在本机存在并核对过）；
> 因此本次**未产出真实样本演示结果**。脚本已就绪，原件放回后一条命令即可复算并在本文件补记结果。
