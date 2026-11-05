/**
 * 东侧外墙平行线逐条诊断（零闭合修复 e，Issue #23 交付 1）。
 *
 * 目的：PR #22 之后真实样本房间仍为 0，首要断点定位到东侧外墙（x≈30.2–30.6）——同一面外墙被保留成
 * 2–3 条几乎重合的平行线，端点对延长线交点距一端 0.847 m，超出 `CORNER_REACH_M`。本脚本把该处的
 * 每一条线（去重前 → 去重后 → 墙网连接后）与 `wallDedupe.ts` 的三项判据逐项对照，回答"PR #13 的去重
 * 为什么没有合并它们"，不改任何判据、不写墙网、只读源点云。
 *
 * 用法：SURVEY_REAL_FIXTURE=/path/to/file.pcd npm run diagnose:east-wall
 * 输出：artifacts/east-wall/<样本名>/east-wall.json 与 east-wall.md（判据对照表）。
 * 口径衔接：`dedupe` 一节使用与 `wallDedupe.ts` 完全相同的常量与几何定义（方向差、两端轴间距、
 * 投影空隙、投影重叠），因此表中"判据差多少"可直接对照 PR #13 §8 的 dedupe 口径。
 */
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { readCloud } from "../src/pipeline/binaryPcd";
import { fitWallLines } from "../src/pipeline/wallLines";
import { DEDUPE_AXIS_GAP_M, DEDUPE_DIRECTION_DEG, DEDUPE_PROJECTION_GAP_M, mergeWallSegments } from "../src/pipeline/wallDedupe";
import { CORNER_REACH_M } from "../src/pipeline/wallNetwork";
import { traceWallLines } from "./replay-wall-lines";
import type { PointCloudData } from "../../src/domain/types";

type P = [number, number];
const file = process.env.SURVEY_REAL_FIXTURE;
if (!file) throw Error("Set SURVEY_REAL_FIXTURE to the original binary PCD.");
/** 东侧外墙的检索窗口（m）：覆盖 PR #22 §11.3.1 记录的 x≈30.2–30.6、y≈−5.3…2.2 一带。 */
const WINDOW = { minX: Number(process.env.EAST_MIN_X ?? 28), maxX: Number(process.env.EAST_MAX_X ?? 32), minY: Number(process.env.EAST_MIN_Y ?? -6.5), maxY: Number(process.env.EAST_MAX_Y ?? 2.8) };
const elevationM = Number(process.env.ELEVATION_M ?? 0), heightM = Number(process.env.HEIGHT_M ?? 3), thicknessM = Number(process.env.THICKNESS_M ?? .2);
const name = basename(file), out = `artifacts/east-wall/${name.replace(/\.pcd$/i, "")}`;
await mkdir(out, { recursive: true });
const round = (v: number, d = 4) => Number(v.toFixed(d));
const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const directionOf = (s: { a: P; b: P }): P => { const l = distance(s.a, s.b); return [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l]; };
/** 无向夹角（度），0–90°：与 `wallDedupe.ts` 的 `angleBetween` 同一公式。 */
const angleBetween = (u: P, v: P) => { const d = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI; return d > 90 ? 180 - d : d; };
const project = (p: P, origin: P, axis: P) => (p[0] - origin[0]) * axis[0] + (p[1] - origin[1]) * axis[1];
const sideOffset = (p: P, origin: P, axis: P) => (p[0] - origin[0]) * axis[1] - (p[1] - origin[1]) * axis[0];
const span = (s: { a: P; b: P }, origin: P, axis: P): [number, number] => { const t = [s.a, s.b].map(p => project(p, origin, axis)); return [Math.min(...t), Math.max(...t)]; };
const inWindow = (s: { a: P; b: P }) => [s.a, s.b].some(p => p[0] >= WINDOW.minX && p[0] <= WINDOW.maxX && p[1] >= WINDOW.minY && p[1] <= WINDOW.maxY);

const handle = await open(file, "r"), stat = await handle.stat(), hash = createHash("sha256");
for (let offset = 0; offset < stat.size; offset += 64 * 1024 ** 2) { const size = Math.min(64 * 1024 ** 2, stat.size - offset), buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, offset); hash.update(buffer); }
const sha256 = hash.digest("hex");
const decoded = await readCloud({ name, native: { token: "east-wall", name, size: stat.size, sha256 } }, "m", async (offset, size) => { const b = Buffer.alloc(size); await handle.read(b, 0, size, offset); return b.buffer; }, () => {});
await handle.close();
const cloud = decoded.cloud, working: PointCloudData = { ...cloud, visible: cloud.visible.slice() };
for (let i = 0; i < working.visible.length; i++) { const z = working.positions[i * 3 + 2]!; if (z < elevationM || z > elevationM + heightM) working.visible[i] = 0; }
const fitted = await fitWallLines(working, () => {});
const replayed = traceWallLines(working);
if (replayed.rawSegments.length !== fitted.fittedSegments || replayed.deduped.segments.length !== fitted.dedupedSegments) throw Error("重放与 fitWallLines 阶段计数不一致，判据对照表不可信。");

/** 逐段证据：墙厚带（±厚度/2）内点数、±0.45 m 带宽内点数、支撑证据格数。 */
const evidenceOf = (s: { a: P; b: P; support: number; rmsM: number }) => {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], length = Math.hypot(dx, dy), half = thicknessM / 2;
  let inside = 0, near = 0;
  for (let p = 0; p < working.visible.length; p++) {
    if (!working.visible[p]) continue;
    const x = working.positions[p * 3]! - s.a[0], y = working.positions[p * 3 + 1]! - s.a[1], u = (x * dx + y * dy) / length, d = Math.abs(x * dy - y * dx) / length;
    if (u < 0 || u > length) continue;
    if (d <= half) inside++;
    if (d <= .45) near++;
  }
  return { lengthM: round(length), pointsInThickness: inside, pointsNearBand: near, supportCells: s.support, rmsMm: round(s.rmsM * 1000, 2) };
};

const describe = (s: { a: P; b: P; support: number; rmsM: number }, index: number) => {
  const u = directionOf(s);
  return { index, a: [round(s.a[0]), round(s.a[1])] as P, b: [round(s.b[0]), round(s.b[1])] as P, angleDeg: round(((Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 180 / Math.PI) % 180 + 180) % 180, 2), unit: [round(u[0], 6), round(u[1], 6)] as P, ...evidenceOf(s) };
};
const before = replayed.rawSegments.map((s, i) => ({ s, d: describe(s, i) })).filter(x => inWindow(x.s));
const after = replayed.deduped.segments.map((s, i) => ({ s, d: describe(s, i), sources: s.sources ?? [i] })).filter(x => inWindow(x.s));

/** 两段之间的三项判据对照（与 `wallDedupe.ts` 的 compatible / touching 完全同一几何）。 */
const pairCriteria = (i: { a: P; b: P }, j: { a: P; b: P }) => {
  const ui = directionOf(i), uj = directionOf(j);
  const deltaDeg = angleBetween(ui, uj);
  // 轴间距：j 的两端点到 i 的轴（以及反向）的垂直距离，取两者较大值（"两端对称判据"）。
  const sides = [j.a, j.b].map(p => Math.abs(sideOffset(p, i.a, ui)));
  const sidesBack = [i.a, i.b].map(p => Math.abs(sideOffset(p, j.a, uj)));
  const axisGap = Math.max(...sides, ...sidesBack);
  // 投影：两段都投到 i 的轴上，给出区间、重叠长度与最小空隙（≤0 表示重叠）。
  const si = span(i, i.a, ui), sj = span(j, i.a, ui);
  const overlap = Math.max(0, Math.min(si[1], sj[1]) - Math.max(si[0], sj[0]));
  const gap = Math.max(0, Math.max(si[0], sj[0]) - Math.min(si[1], sj[1]));
  // 沿 j 的轴再算一次：方向差较大时两个轴的投影不等价，取更"宽松"（更可能合并）的那一侧，避免误判为可合并。
  const sjOnJ = span(j, j.a, uj), siOnJ = span(i, j.a, uj);
  const overlapJ = Math.max(0, Math.min(sjOnJ[1], siOnJ[1]) - Math.max(sjOnJ[0], siOnJ[0]));
  return {
    directionDeltaDeg: round(deltaDeg, 2), directionPass: deltaDeg < DEDUPE_DIRECTION_DEG,
    directionMarginDeg: round(DEDUPE_DIRECTION_DEG - deltaDeg, 2),
    axisGapM: round(axisGap), axisPass: axisGap < DEDUPE_AXIS_GAP_M,
    axisMarginM: round(DEDUPE_AXIS_GAP_M - axisGap),
    projectionGapM: round(gap), projectionOverlapM: round(overlap),
    projectionOverlapOnOtherAxisM: round(overlapJ),
    projectionPass: Math.max(0, Math.max(si[0], sj[0]) - Math.min(si[1], sj[1])) <= DEDUPE_PROJECTION_GAP_M,
    mergeable: deltaDeg < DEDUPE_DIRECTION_DEG && axisGap < DEDUPE_AXIS_GAP_M && Math.max(0, Math.max(si[0], sj[0]) - Math.min(si[1], sj[1])) <= DEDUPE_PROJECTION_GAP_M,
  };
};
const crossPairs = (list: Array<{ s: { a: P; b: P } }>) => {
  const pairs = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push({ i, j, ...pairCriteria(list[i]!.s, list[j]!.s) });
  return pairs;
};

// 沿墙轴投影对照：把每条线投到"最长的那条线"的轴上，给出它们的轴向覆盖关系与横向偏移。
const longest = [...after].sort((x, y) => y.d.lengthM - x.d.lengthM)[0];
const projected = longest ? after.map(x => {
  const u = longest.s && directionOf(longest.s);
  const t = [x.s.a, x.s.b].map(p => round(project(p, longest.s.a, u)));
  const side = [x.s.a, x.s.b].map(p => round(sideOffset(p, longest.s.a, u)));
  return { index: x.d.index, sources: x.sources, alongM: t, sideM: side };
}) : [];

// 去重结论：每条去重后线段来自哪一组、是否参与合并、合并组内的判据对照。
const groups = replayed.deduped.groups.map(g => ({ ...g, members: g.sourceIndexes.map(i => describe(replayed.rawSegments[i]!, i)) }));

// 墙网连接后在东侧窗口内的墙段与角部断点。
const network = replayed.network;
const joinedEast = network.segments.map((s, i) => ({ i, ...describe(s, i), sourceIndex: s.sourceIndex })).filter(x => inWindow(x));
const cornerPairs = network.corners.filter(c => c.points.some(p => p[0] >= WINDOW.minX && p[0] <= WINDOW.maxX && p[1] >= WINDOW.minY && p[1] <= WINDOW.maxY));
const unclosedEast = network.unclosed.filter(u => u.pointM[0] >= WINDOW.minX && u.pointM[0] <= WINDOW.maxX && u.pointM[1] >= WINDOW.minY && u.pointM[1] <= WINDOW.maxY);

const result = {
  source: { name, sha256, bytes: stat.size, window: WINDOW, thicknessM, elevationM, heightM },
  criteria: { DEDUPE_DIRECTION_DEG, DEDUPE_AXIS_GAP_M, DEDUPE_PROJECTION_GAP_M, CORNER_REACH_M },
  fittedSegments: replayed.rawSegments.length, dedupedSegments: replayed.deduped.segments.length, mergeGroups: groups.length,
  east: { before, after, pairsBefore: crossPairs(before), pairsAfter: crossPairs(after), projected, groups: groups.filter(g => g.members.some(m => inWindow(replayed.rawSegments[m.index]!))), joined: joinedEast, cornerPairs, unclosed: unclosedEast },
};

const md: string[] = [];
const fmt = (p: P) => `(${p[0].toFixed(3)}, ${p[1].toFixed(3)})`;
md.push(`# 东侧外墙平行线逐条诊断（${name}）`, "");
md.push(`- 原件 SHA256：\`${sha256}\``, `- 检索窗口：x ${WINDOW.minX}–${WINDOW.maxX} m、y ${WINDOW.minY}–${WINDOW.maxY} m；墙厚 ${thicknessM} m；标高 ${elevationM} m、墙高 ${heightM} m`, "");
md.push("## 判据常量（与 `wallDedupe.ts` 同一命名常量）", "");
md.push("| 常量 | 值 |", "| --- | --- |", `| \`DEDUPE_DIRECTION_DEG\` | ${DEDUPE_DIRECTION_DEG}° |`, `| \`DEDUPE_AXIS_GAP_M\` | ${DEDUPE_AXIS_GAP_M} m |`, `| \`DEDUPE_PROJECTION_GAP_M\` | ${DEDUPE_PROJECTION_GAP_M} m |`, `| \`CORNER_REACH_M\` | ${CORNER_REACH_M} m |`, "");
md.push("## 1. 去重前（`fitWallLines` 拟合输出）东侧窗口内的段", "");
md.push("| # | 起点 | 终点 | 长度 m | 方位角° | 方向差到判据 | 证据格 | 墙厚带内点 | 0.45 m 带内点 | RMS mm |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const x of before) md.push(`| ${x.d.index} | ${fmt(x.d.a)} | ${fmt(x.d.b)} | ${x.d.lengthM} | ${x.d.angleDeg} | — | ${x.d.supportCells} | ${x.d.pointsInThickness} | ${x.d.pointsNearBand} | ${x.d.rmsMm} |`);
md.push("", "## 2. 去重后东侧窗口内的段（`sources` = 拟合来源段号）", "");
md.push("| # | 来源 | 起点 | 终点 | 长度 m | 方位角° | 证据格 | 墙厚带内点 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const x of after) md.push(`| ${x.d.index} | ${x.sources.join("/")} | ${fmt(x.d.a)} | ${fmt(x.d.b)} | ${x.d.lengthM} | ${x.d.angleDeg} | ${x.d.supportCells} | ${x.d.pointsInThickness} |`);
md.push("", "## 3. 两两判据对照（去重后）", "", "`可合并` = 三项同时满足（方向差 < 1.5°、两端轴间距 < 0.15 m、投影空隙 ≤ 0.02 m）。", "");
md.push("| 段对 | 方向差° | 方向差余量 | 轴间距 m | 轴距余量 | 投影空隙 m | 投影重叠 m | 可合并 | 差在哪一项 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
const reasonOf = (p: ReturnType<typeof pairCriteria>) => [p.directionPass ? null : "方向差", p.axisPass ? null : "轴间距", p.projectionPass ? null : "投影空隙"].filter(Boolean).join("、") || "—";
for (const p of result.east.pairsAfter) md.push(`| ${after[p.i]!.d.index} ↔ ${after[p.j]!.d.index} | ${p.directionDeltaDeg} | ${p.directionMarginDeg} | ${p.axisGapM} | ${p.axisMarginM} | ${p.projectionGapM} | ${p.projectionOverlapM} | ${p.mergeable ? "是" : "否"} | ${reasonOf(p)} |`);
md.push("", "## 4. 沿最长段的墙轴投影对照", "", "| 段 | 来源 | 轴向覆盖 m | 横向偏移 m |", "| --- | --- | --- | --- |");
for (const p of projected) md.push(`| ${p.index} | ${p.sources.join("/")} | ${p.alongM.join(" … ")} | ${p.sideM.join(" / ")} |`);
md.push("", "## 5. 东侧窗口内的墙网连接结果（角部断点与未闭合项）", "");
md.push("| 段对 | 端点 | 夹角° | 端点间距 m | 交点 | 到端点 | 结果 | 原因 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const c of cornerPairs) md.push(`| ${c.segments.join(" ↔ ")} | ${c.points.map(fmt).join(" ↔ ")} | ${c.angleDeg} | ${c.gapM} | ${fmt(c.intersection)} | ${c.toA} / ${c.toB} | ${c.outcome} | ${c.reason ?? "—"} |`);
md.push("", "| 段 | 端点 | 位置 | 原因 | 最近目标 | 缺口 m |", "| --- | --- | --- | --- | --- | --- |");
for (const u of unclosedEast) md.push(`| ${u.segmentIndex} | ${u.end} | ${fmt(u.pointM)} | ${u.reason} | ${u.targetSegmentIndex} | ${u.gapM} |`);
await writeFile(`${out}/east-wall.json`, JSON.stringify(result, null, 2));
await writeFile(`${out}/east-wall.md`, md.join("\n") + "\n");
console.log(md.join("\n"));
