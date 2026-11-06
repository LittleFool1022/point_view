/**
 * 墙网人工复核处置演示（脚本化，不是人工在界面操作）：
 * 在真实样本副本上沿 `buildingOps.ts` 的未闭合清单做一遍完整复核序列——
 * 连接两端 / 补墙 / 删伪影 / 确认洞口——逐步记录处置条数、每步房间数变化与最终房间数/面积。
 *
 * 用法：SURVEY_REAL_FIXTURE=/path/to/file.pcd npm run review:wall-sample
 * 只读源件（前后核对 SHA256），不连接设备、不部署、不改动任何已保存工程；输出 JSON 至 artifacts/wall-review/<样本名>/。
 * 处置本身由规则挑选（最大缺口的连接两端、补墙、删最短孤立墙段、确认最大洞口），只是操作 API 的脚本化演示，
 * 不代表人工判断结论，也不构成精度验收。
 */
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { readCloud } from "../src/pipeline/binaryPcd";
import { fitWallLines } from "../src/pipeline/wallLines";
import { buildingFromSegments, levelRoomsAndIssues, levelClosure, type BuildingOptions } from "../src/domain/buildingOps";
import { applyReviewAction, reviewSummary, reviewFitImpact, type ReviewActionRequest } from "../src/domain/buildingReview";
import { activeWalls, wallLength, type BuildingModel } from "../src/domain/building";
import type { PointCloudData } from "../../src/domain/types";

const file = process.env.SURVEY_REAL_FIXTURE;
if (!file) throw Error("Set SURVEY_REAL_FIXTURE to the original binary PCD.");
const options: BuildingOptions = {
  elevationM: Number(process.env.ELEVATION_M ?? 0), heightM: Number(process.env.HEIGHT_M ?? 3),
  thicknessM: Number(process.env.THICKNESS_M ?? .2), levelName: process.env.LEVEL_NAME ?? "复核演示",
};
const name = basename(file), out = `artifacts/wall-review/${name.replace(/\.pcd$/i, "")}`;
await mkdir(out, { recursive: true });

const hashOf = async () => {
  const handle = await open(file, "r"), stat = await handle.stat(), hash = createHash("sha256");
  for (let offset = 0; offset < stat.size; offset += 64 * 1024 ** 2) { const size = Math.min(64 * 1024 ** 2, stat.size - offset), buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, offset); hash.update(buffer); }
  await handle.close();
  return { sha256: hash.digest("hex"), bytes: stat.size };
};
const before = await hashOf();
const handle = await open(file, "r");
const decoded = await readCloud({ name, native: { token: "review", name, size: before.bytes, sha256: before.sha256 } }, "m",
  async (offset, size) => { const b = Buffer.alloc(size); await handle.read(b, 0, size, offset); return b.buffer; }, () => {});
await handle.close();
const cloud: PointCloudData = { ...decoded.cloud, visible: decoded.cloud.visible.slice() };
let inBand = 0;
for (let i = 0; i < cloud.visible.length; i++) { const z = cloud.positions[i * 3 + 2]!; if (z >= options.elevationM && z <= options.elevationM + options.heightM) inBand++; else cloud.visible[i] = 0; }
const fitted = await fitWallLines(cloud, () => {});
const source = { name, bytes: before.bytes, units: "m" as const, synthetic: false, native: { token: "review", name, size: before.bytes, sha256: before.sha256 } };
let model: BuildingModel = buildingFromSegments(source, options, fitted.segments);
const levelId = model.levels[0]!.id;
const area = (m: BuildingModel) => m.rooms.filter(r => r.levelId === levelId).reduce((s, r) => s + Math.abs(r.boundaryM.reduce((acc, p, i) => { const q = r.boundaryM[(i + 1) % r.boundaryM.length]!; return acc + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2, 0);
const openIssues = (m: BuildingModel) => (m.unclosedIssues ?? []).filter(i => i.levelId === levelId && !i.resolution && !i.closedBy);
const levelRooms = (m: BuildingModel) => m.rooms.filter(r => r.levelId === levelId).length;
const snapshot = (m: BuildingModel, step: string) => {
  const issues = openIssues(m), closure = levelClosure(m, levelId);
  return {
    step, roomsAfter: levelRooms(m), roomAreaAfterM2: Number(area(m).toFixed(3)),
    openIssues: issues.length, wallGap: issues.filter(i => i.kind === "wall-gap").length, danglingEnd: issues.filter(i => i.kind === "dangling-end").length,
    activeWalls: activeWalls(m, levelId).length, manualWalls: activeWalls(m, levelId).filter(w => w.source?.kind === "manual").length,
    removedWalls: m.walls.filter(w => w.removed && w.levelId === levelId).length, reviewActions: m.reviewActions?.length ?? 0,
    net: { walls: closure.walls, nodes: closure.nodes, faces: closure.faces, rooms: closure.rooms, wallGap: closure.unclosedIssues.wallGap, danglingEnd: closure.unclosedIssues.danglingEnd },
  };
};

const steps: { action: string; request: ReviewActionRequest | null; record?: unknown; roomsBefore: number; roomsAfter: number; error?: string }[] = [];
const timeline: ReturnType<typeof snapshot>[] = [snapshot(model, "生成候选后")];
function run(request: ReviewActionRequest) {
  const roomsBefore = levelRooms(model);
  try {
    const step = applyReviewAction(model, request);
    model = step.model;
    steps.push({ action: request.kind, request, record: step.action, roomsBefore, roomsAfter: levelRooms(model) });
    timeline.push(snapshot(model, `${request.kind} #${steps.length}`));
  } catch (error) { steps.push({ action: request.kind, request, roomsBefore, roomsAfter: roomsBefore, error: error instanceof Error ? error.message : String(error) }); }
}
const byGap = (kind: "wall-gap" | "dangling-end") => openIssues(model).filter(i => i.kind === kind).sort((a, b) => (b.gapM ?? 0) - (a.gapM ?? 0));

// 1) 连接两端：优先处理最大缺口（墙网已判定为同一墙轴延续或洞口，脚本按规则挑选）。
for (const issue of byGap("wall-gap").slice(0, 20)) run({ kind: "connect", issueId: issue.id });
// 2) 补墙：仍为缺口、且两端在 0.3 m 内的，脚本演示补墙处置。
for (const issue of byGap("wall-gap").filter(i => (i.gapM ?? 0) <= .3).slice(0, 10)) run({ kind: "add-wall", levelId, a: issue.pointM, b: issue.toM!, issueId: issue.id });
// 3) 删伪影：两端都不接其它墙段的孤立段，按长度从短到长删除前 3 条，删除原因写入留痕。
const degrees = new Map<string, number>();
for (const w of activeWalls(model, levelId)) for (const end of w.axisM) {
  const key = `${end[0].toFixed(2)},${end[1].toFixed(2)}`;
  degrees.set(key, (degrees.get(key) ?? 0) + 1);
}
const isolated = activeWalls(model, levelId).filter(w => w.axisM.every(end => (degrees.get(`${end[0].toFixed(2)},${end[1].toFixed(2)}`) ?? 0) <= 1));
for (const w of isolated.sort((a, b) => wallLength(a) - wallLength(b)).slice(0, 3)) run({ kind: "remove-wall", wallId: w.id, reason: `脚本化演示：两端均不接其它墙段、长度 ${wallLength(w).toFixed(2)} m 的孤立段` });
// 4) 确认洞口：剩余最大缺口确认为洞口（不计入未闭合，不据此造房间）。
for (const issue of byGap("wall-gap").slice(0, 5)) run({ kind: "resolved-opening", issueId: issue.id });

const after = await hashOf();
const summary = reviewSummary(model, levelId);
void levelRoomsAndIssues;
const report = {
  schema: "survey-wall-review-demo/1",
  note: "脚本化演示（非人工在界面操作）：处置由规则挑选，仅为操作 API 的演示，不代表人工判断结论，也不构成精度验收。",
  source: { name, bytes: before.bytes, sha256Before: before.sha256, sha256After: after.sha256, unchanged: before.sha256 === after.sha256, points: cloud.positions.length / 3, pointsInBand: inBand },
  options, fittedSegments: fitted.segments.length,
  initial: timeline[0], steps, timeline,
  final: { rooms: summary.rooms.length, roomAreaM2: Number(area(model).toFixed(3)), openIssues: summary.unclosed, resolvedOpenings: summary.resolvedOpenings.length, manualWalls: summary.manualWalls, removedWalls: summary.removedWalls.length, reviewActions: summary.actions.length },
  refitPolicy: { default: "block-on-fit", impact: reviewFitImpact(model) },
  limitations: [
    "处置由脚本按固定规则挑选，不是人工复核结论；界面操作与人工判断不在本脚本范围。",
    "未提供 RD-01 独立真值，房间数与面积只作功能演示，不是精度验收。",
    "只读源件与本次生成的内存模型；不写入、不改动任何已保存工程，不连接设备、不部署。",
  ],
};
await writeFile(`${out}/review-demo.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ sample: name, unchanged: report.source.unchanged, walls: model.walls.length, steps: steps.length, failed: steps.filter(s => s.error).length, rooms: report.final.rooms, roomAreaM2: report.final.roomAreaM2, openIssues: report.final.openIssues, resolvedOpenings: report.final.resolvedOpenings }, null, 2));
