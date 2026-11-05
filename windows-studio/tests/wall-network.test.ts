import { describe, expect, it } from "vitest";
import { CORNER_REACH_M, EXTENSION_MIN_M, MIN_PIECE_M, OPENING_M, MAX_EXTENSION_M, buildWallNetwork } from "../src/pipeline/wallNetwork";
type P = [number, number];
const seg = (a: P, b: P) => ({ a, b, support: 20, rmsM: .01 });
const length = (s: { a: P; b: P }) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
const degrees = (segments: ReturnType<typeof seg>[]) => buildWallNetwork(segments).nodes.map(n => n.degree).sort((a, b) => a - b);

/**
 * 墙网级连接规则夹具（Issue #11）：沿轴延长、T 形插节点、门口不连。
 * 期望值按功能正确性（连不连、连在哪、度数）给出，不是精度验收阈值。
 */
describe("墙网连接规则", () => {
  it("沿轴延长：同一墙轴 0.3 m 缺口延伸成一段，不产生斜线", () => {
    const { segments, join } = buildWallNetwork([seg([0, 0], [3.7, 0]), seg([4, 0], [8, 0])]);
    expect(segments).toHaveLength(2);
    expect(join.extensions).toBe(1);
    const shared = segments[0]!.b;
    expect(segments[1]!.a[0]).toBeCloseTo(shared[0], 6);
    expect(segments[1]!.a[1]).toBeCloseTo(shared[1], 6);
    // 延长只沿墙轴（y 不变），两段方向一致。
    expect(shared[1]).toBeCloseTo(0, 6);
    expect(degrees([seg([0, 0], [3.7, 0]), seg([4, 0], [8, 0])])).toContain(2);
  });

  it("沿轴延长受上限约束：0.6 m 与 1.2 m 缺口都不连接，分别计入未闭合与洞口", () => {
    // 3.4→4.0 的 0.6 m 缺口被记为不连接；3.4 的远端则离另一墙 4 m，按洞口处理。
    const wide = buildWallNetwork([seg([0, 0], [3.4, 0]), seg([4, 0], [8, 0])]);
    expect(wide.join.extensions).toBe(0);
    expect(wide.join.unclosed).toBe(2);
    expect(wide.unclosed.filter(u => u.reason === "gap-too-large").map(u => u.gapM)).toEqual([.6, .6]);
    expect(wide.join.opening).toBe(2);
    expect(wide.segments[0]!.b).toEqual([3.4, 0]);
    const door = buildWallNetwork([seg([0, 0], [8, 0]), seg([8, 0], [8, 6]), seg([8, 6], [0, 6]), seg([0, 6], [0, 4.2]), seg([0, 3], [0, 0])]);
    expect(door.join.extensions).toBe(0);
    expect(door.join.opening).toBe(2);
    const openings = door.unclosed.filter(u => u.reason === "opening");
    expect(openings.map(u => u.segmentIndex).sort()).toEqual([3, 4]);
    expect(openings.every(u => u.gapM === 1.2)).toBe(true);
  });

  it("洞口参数边界：0.5 m 以内才允许延长，0.5–1.0 m 不连接并计入清单", () => {
    expect(MAX_EXTENSION_M).toBe(.5);
    expect(OPENING_M).toBe(1);
    const atLimit = buildWallNetwork([seg([0, 0], [3.5, 0]), seg([4, 0], [8, 0])]);
    expect(atLimit.join.extensions).toBe(1);
    const overLimit = buildWallNetwork([seg([0, 0], [3.45, 0]), seg([4, 0], [8, 0])]);
    expect(overLimit.join.extensions).toBe(0);
    expect(overLimit.join.unclosed).toBe(2);
  });

  it("不在同一墙轴上的缺口不补斜线", () => {
    const { segments, join, unclosed } = buildWallNetwork([seg([0, 0], [3.7, 0]), seg([4, .25], [8, .25])]);
    expect(join.extensions).toBe(0);
    expect(join.unclosed).toBe(2);
    // 面向缺口的两端记为"不在同一墙轴"，远端各自离最近墙 ≥1 m 记为洞口。
    expect(unclosed.filter(u => u.reason === "no-alignment")).toHaveLength(2);
    expect(segments[0]!.b).toEqual([3.7, 0]);
    expect(segments[1]!.a).toEqual([4, .25]);
  });

  it("T 形连接：端点落在另一面墙段内时在被穿过墙上插节点并分段，不在端点处连斜线", () => {
    const network = buildWallNetwork([seg([0, 0], [8, 0]), seg([8, 0], [8, 6]), seg([8, 6], [0, 6]), seg([0, 6], [0, 0]), seg([4, 3], [4, .05])]);
    // 竖直隔墙的端点被投到水平墙上，水平墙在 x=4 处分成两段。
    expect(network.segments).toHaveLength(6);
    expect(network.join.insertedNodes).toBe(1);
    expect(network.join.splits).toBe(1);
    const pole = network.segments.find(s => s.sourceIndex === 4)!;
    expect(pole.b[1]).toBeCloseTo(0, 6);
    expect(pole.b[0]).toBeCloseTo(4, 6);
    const split = network.segments.filter(s => s.sourceIndex === 0);
    expect(split).toHaveLength(2);
    expect(split.map(s => s.b)).toContainEqual([4, 0]);
    // 插点处是 3 度节点（水平墙 2 段 + 隔墙），墙网可追溯回原墙段 0 与 4。
    const tee = network.nodes.find(n => Math.abs(n.p[0] - 4) < 1e-6 && Math.abs(n.p[1]) < 1e-6)!;
    expect(tee.degree).toBe(3);
    expect(tee.walls.sort()).toEqual([0, 4]);
    expect(split.map(s => [s.pieceStart, s.pieceCount])).toEqual([[0, 2], [1, 2]]);
  });

  it("丁字连接：端点正落在另一面墙轴上（偏差 0）同样插节点，而不是把端点当角点", () => {
    const network = buildWallNetwork([seg([0, 0], [3, 0]), seg([3, 0], [8, 0]), seg([3, 0], [3, 3])]);
    const shared = network.nodes.find(n => Math.abs(n.p[0] - 3) < 1e-6 && Math.abs(n.p[1]) < 1e-6)!;
    expect(shared.degree).toBe(3);
    expect(shared.walls.sort()).toEqual([0, 1, 2]);
    // 三条墙本来就共点于 (3,0)：不需要插点或延长，节点合并即可得到 3 度节点。
    expect(network.join.joined).toBe(0);
    expect(network.segments).toHaveLength(3);
  });

  it("角接：两墙端点相距 10 cm 时对齐到同一节点，缺口过大时不强行连", () => {
    // 两墙端点相距约 14 cm：只沿墙轴延长任何一方都不成立（横向偏差 > 12 cm），因此角接不强行对齐。
    const corner = buildWallNetwork([seg([0, 0], [7.9, 0]), seg([8, .1], [8, 6])]);
    expect(corner.join.joined).toBe(0);
    // 端点相距 5 cm 时同样不靠"直接相连"，而是水平墙沿墙轴延长 y=0 到竖直墙起点 x=8。
    const snug = buildWallNetwork([seg([0, 0], [7.95, 0]), seg([8, .04], [8, 6])]);
    expect(snug.join.extensions).toBe(1);
    expect(snug.segments[0]!.b).toEqual([8, 0]);

    // 端点相距 0.42 m（在 0.5 m 上限内），但横向偏差 0.3 m：不延长、不拉斜线。
    const apache = buildWallNetwork([seg([0, 0], [7.7, 0]), seg([8, .3], [8, 6])]);
    expect(apache.join.joined).toBe(0);
    expect(apache.join.corners).toBe(0);
    expect(apache.join.unclosed).toBe(2);
    // 交点 (8,0) 距水平墙端点 0.3 m、距竖直墙端点 0.3 m；收敛后两段之间的连线是 0.42 m 的斜线而不是墙角，
    // 且交点附近没有其它墙体证据，因此不收敛、不拉斜线，原因逐条写到墙角口径下。
    expect(apache.unclosed.filter(u => u.reason === "corner-no-evidence")).toHaveLength(2);
    expect(apache.unclosed.filter(u => u.corner === "no-evidence")).toHaveLength(2);
    expect(apache.segments[0]!.b).toEqual([7.7, 0]);
    expect(apache.segments[1]!.a).toEqual([8, .3]);
  });

  it("L 形角部双侧各短缺约 0.3 m：延长线交于墙角，两端点收敛到同一交点节点", () => {
    // 墙角在 (8, 0)：水平墙一侧短缺 0.3 m（止于 7.7, 0），竖直墙一侧短缺 0.5 m（自 8, 0.5 起），
    // 另有外墙自 (8.3, 0) 起提供交点处的墙体证据。两段端点相距 0.58 m 超过单侧可达距离，
    // 因此由共享该角的外墙与竖直墙收敛：交点 (8, 0) 距两端点 0.3 m 与 0.5 m，两侧都在 CORNER_REACH_M 内。
    const network = buildWallNetwork([seg([0, 0], [7.7, 0]), seg([8, .5], [8, 6]), seg([8, 6], [0, 6]), seg([0, 6], [0, 0]), seg([8.3, 0], [12, 0])]);
    expect(network.join.corners).toBe(1);
    const joined = network.corners.filter(c => c.outcome === "joined");
    expect(joined).toHaveLength(1);
    // segments = [竖直墙 1, 外墙 4]：toA 是竖直墙端点到交点的距离（0.5 m），toB 是外墙端点的（0.3 m）。
    expect(joined[0]).toMatchObject({ segments: [1, 4], toA: .5, toB: .3, angleDeg: 90 });
    expect(joined[0]!.intersection).toEqual([8, 0]);
    // 交点节点同时接住竖直墙与外墙，二者都收敛到 (8, 0)。
    const corner = network.nodes.find(n => Math.hypot(n.p[0] - 8, n.p[1]) < 1e-6)!;
    expect(corner.degree).toBe(2);
    expect(network.segments.find(s => s.sourceIndex === 1)!.a).toEqual([8, 0]);
    expect(network.segments.find(s => s.sourceIndex === 4)!.a).toEqual([8, 0]);
    // 收敛后每条墙仍沿自身墙轴（竖直墙 x=8、外墙 y=0），没有斜线；水平墙一侧的 0.3 m 短缺如实保留。
    expect(network.segments.find(s => s.sourceIndex === 1)!.b).toEqual([8, 6]);
    expect(network.segments.find(s => s.sourceIndex === 4)!.b).toEqual([12, 0]);
    expect(network.segments.find(s => s.sourceIndex === 0)!.b).toEqual([7.7, 0]);
    // 水平墙一侧与竖直墙原端点之间那对端点反映的是收敛前的候选，收敛后该端已接入节点、不再重复记录。
    expect(network.corners.every(c => c.outcome !== "skipped" || c.reason !== undefined)).toBe(true);
    expect(network.unclosed.some(u => u.segmentIndex === 0 && u.reason === "corner-too-far")).toBe(true);
  });

  it("角部上限与墙体证据：交点过远或无证据时保持断开并计入角部断点清单", () => {
    // 有墙体证据但两侧各短缺 0.6 m：交点 (8, 0) 距两端点都 0.6 m > CORNER_REACH_M（= 沿轴延长上限），
    // 因此不收敛，逐对记为"交点过远"，两根墙端点都不动。
    const far = buildWallNetwork([seg([0, 0], [7.4, 0]), seg([8, .6], [8, 6]), seg([8, 6], [0, 6]), seg([0, 6], [0, 0]), seg([8.3, 0], [12, 0])]);
    expect(CORNER_REACH_M).toBe(MAX_EXTENSION_M);
    expect(far.join.corners).toBe(0);
    expect(far.corners.length).toBeGreaterThan(0);
    expect(far.corners.every(c => c.outcome === "skipped")).toBe(true);
    expect(far.corners.map(c => c.reason)).toContain("too-far");
    expect(far.corners.find(c => c.reason === "too-far")).toMatchObject({ toA: .6, toB: .6 });
    expect(far.segments.find(s => s.sourceIndex === 1)!.a).toEqual([8, .6]);
    expect(far.segments.find(s => s.sourceIndex === 4)!.a).toEqual([8.3, 0]);
    // 未闭合清单沿用角部口径（同一数组、同一原因），不另起平行口径。
    const cornerEnds = far.unclosed.filter(u => u.corner === "too-far");
    expect(cornerEnds.length).toBeGreaterThan(0);
    // 角部规则明确判定"交点可达但过远"的悬空端直接记成角部原因；缺口本身 0.85 m 的端点对连角部断点都不记录。
    expect(cornerEnds.every(u => u.reason === "corner-too-far")).toBe(true);
    // 交点可达（两侧 0.3 m）但交点附近没有其它墙体证据：同样保持断开，原因写"无墙体证据"。
    const bare = buildWallNetwork([seg([0, 0], [7.7, 0]), seg([8, .3], [8, 6])]);
    expect(bare.join.corners).toBe(0);
    expect(bare.corners.find(c => c.reason === "no-evidence")).toMatchObject({ outcome: "skipped", toA: .3, toB: .3 });
    expect(bare.segments[0]!.b).toEqual([7.7, 0]);
    expect(bare.segments[1]!.a).toEqual([8, .3]);
  });

  it("悬空端最近的是墙体内部（丁字接头）时不属于角部断点，未闭合清单保留原原因", () => {
    // 隔墙端点落在上墙中部附近的 T 形情形：丁字接头由贴合插点处理，这里只核对"不把 T 形说成墙角"。
    const network = buildWallNetwork([seg([0, 0], [8, 0]), seg([8, 0], [8, 6]), seg([8, 6], [0, 6]), seg([0, 6], [0, 0]), seg([4, 3], [4, .3])]);
    // 隔墙下端点离上墙 0.3 m（丁字缺口）：不计入角部断点，未闭合清单按原有"不同墙轴"口径如实记录。
    expect(network.unclosed.every(u => u.corner === undefined)).toBe(true);
    expect(network.unclosed.some(u => u.segmentIndex === 4 && u.end === "b" && u.reason === "no-alignment")).toBe(true);
  });

  it("1.2 m 门口两侧不被角部规则误连", () => {
    const door = buildWallNetwork([seg([0, 0], [8, 0]), seg([8, 0], [8, 6]), seg([8, 6], [0, 6]), seg([0, 6], [0, 4.2]), seg([0, 3], [0, 0])]);
    expect(door.join.corners).toBe(0);
    // 门口两侧是同一墙轴的平行缺口，延长线平行（不相交），因此连角部断点都不构成。
    expect(door.corners).toHaveLength(0);
    expect(door.segments.find(s => s.sourceIndex === 3)!.b).toEqual([0, 4.2]);
    expect(door.segments.find(s => s.sourceIndex === 4)!.a).toEqual([0, 3]);
    expect(door.unclosed.filter(u => u.reason === "opening").map(u => u.gapM)).toEqual([1.2, 1.2]);
  });

  it("近共线端点对仍走沿轴延长，角部规则不接管也不补斜线", () => {
    // 两段夹角约 1°，横向错位 0.05 m：延长线交点会落在很远处，角部规则因"交点过远+夹角过小"不接管，
    // 由沿轴延长把缺口接上（结果仍为同一墙轴上的缺口）。
    const network = buildWallNetwork([seg([0, 0], [3.7, 0]), seg([4, .05], [8, .05])]);
    expect(network.join.corners).toBe(0);
    expect(network.corners).toHaveLength(0);
    expect(network.join.extensions).toBe(1);
    expect(network.segments[0]!.b[1]).toBeCloseTo(0, 6);
  });

  it("延伸不足最小墙长的回退为悬空端并给出原因，不算连接", () => {
    // 0.2 m 的短墙延伸到 1 m 处后也才 1.0 m 的起点可补，但缺口 0.8 m 超出延长上限：不连接并计入未闭合。
    // 把缺口收到上限内（0.9 m 起点的墙）时，短墙会延伸到 0.9 m，延伸后 0.9 m ≥ 0.8 m，属正常延长。
    const short = buildWallNetwork([seg([0, 0], [.2, 0]), seg([1, 0], [2.5, 0])]);
    expect(short.join.extensions).toBe(0);
    expect(short.join.unclosed).toBe(2);
    const extended = buildWallNetwork([seg([0, 0], [.4, 0]), seg([.9, 0], [6, 0])]);
    expect(extended.join.extensions).toBe(1);
    expect(extended.join.revertedExtensions).toBe(0);
  });

  it("短段不越过极限拉长：连接延长段只受 EXTENSION_MIN_M 约束，长段可反向补到短段端点", () => {
    // 修复 f（Issue #24）后的口径：0.1 m 的短段与 0.3 m 起点的墙之间 0.2 m 缺口由长段沿墙轴补上
    // （短段保持 0.1 m，不再被拉成 0.9 m 的墙）。
    const network = buildWallNetwork([seg([0, 0], [.1, 0]), seg([.3, 0], [6, 0])]);
    expect(network.join.revertedExtensions).toBe(0);
    expect(network.join.extensions).toBe(1);
    expect(network.segments.some(s => s.a[0] === 0 && Math.abs(s.b[0] - .1) < 1e-9)).toBe(true);
    // 拼缝落在短段端点处（延长方向沿途的端点优先，长段从 0 起与短段共点），短段仍是 0.1 m。
    expect(network.segments.some(s => s.a[0] === 0 && s.b[0] === 6)).toBe(true);
    // 0.5 m 缺口（延长上限内）同样只由一侧补上，不留"延伸不足"回退：旧口径下短段被顶到 0.6 m 才算连上。
    const wide = buildWallNetwork([seg([0, 0], [.1, 0]), seg([.6, 0], [6, 0])]);
    expect(wide.join.extensions).toBe(1);
    expect(wide.join.revertedExtensions).toBe(0);
    expect(wide.segments.some(s => Math.abs(s.b[0] - .6) < 1e-9)).toBe(true);
  });

  it("短延长段（<0.8 m）连接两段已确认墙体应通过：旧口径被 extension-too-short 拦下的那一对", () => {
    // 修复 f（Issue #24）验收夹具：0.2 m 的短墙与 0.7 m 起点的墙之间 0.5 m 缺口（延长上限内），
    // 旧口径要求"延长后的整段 ≥ 0.8 m"，短墙被拉成 0.7 m 仍不足而被拒；新口径只看延长段本身（≥ 0.12 m）。
    const network = buildWallNetwork([seg([0, 0], [.2, 0]), seg([.7, 0], [2.5, 0])]);
    expect(EXTENSION_MIN_M).toBeLessThan(MIN_PIECE_M);
    expect(network.join.extensions).toBe(1);
    expect(network.join.revertedExtensions).toBe(0);
    expect(network.unclosed.some(u => u.reason === "extension-too-short")).toBe(false);
    // 延长后两段在同一节点相接，墙轴方向不变、没有斜线。
    expect(network.segments.map(s => s.b)).toContainEqual([.7, 0]);
    expect(network.segments.some(s => s.a[0] === .7 && s.b[0] === 2.5)).toBe(true);
  });

  it("旧口径对照：延长段也按最小墙长拦截时，这一对被最小墙长回退（诊断可复现）", () => {
    // policies 只给诊断复核用：还原 Issue #24 之前的判定，确认"被最小墙长拦下"的形态确实存在。
    const legacy = buildWallNetwork([seg([0, 0], [.2, 0]), seg([.7, 0], [2.5, 0])], { pieceLengthAppliesToExtension: true });
    expect(legacy.join.revertedExtensions).toBeGreaterThan(0);
    // 生产口径返回自己实际使用的参数，诊断脚本据此归类。
    const current = buildWallNetwork([seg([0, 0], [.2, 0]), seg([.7, 0], [2.5, 0])]);
    expect(current.policies).toMatchObject({ extensionMinM: EXTENSION_MIN_M, pieceLengthAppliesToExtension: false });
  });

  it("独立拟合短段（<0.8 m、无连接对象）仍被过滤：噪声短段不因延长口径放宽进入墙网", () => {
    // 拟合端的最小墙长（wallLines.ts 的 0.8 m）与最小支撑格数未改；这里给出墙网层的等价保证：
    // 一个孤立的 0.3 m 短段不会被延长成墙——没有可接的墙段时它保持原长并列为未闭合悬空端。
    const network = buildWallNetwork([seg([0, 0], [.3, 0])]);
    expect(network.segments).toHaveLength(1);
    expect(network.segments[0]!.b).toEqual([.3, 0]);
    expect(network.join.extensions).toBe(0);
    expect(network.unclosed.every(u => u.reason === "structural-gap")).toBe(true);
    // 与另一段平行但不在同一墙轴上的近邻墙也不会被短延长连上（0.3 m 轴间距 > 贴合容差）。
    const parallel = buildWallNetwork([seg([0, 0], [.3, 0]), seg([0, .3], [6, .3])]);
    expect(parallel.join.extensions).toBe(0);
    expect(parallel.join.dangling).toBe(4);
  });

  it("1.2 m 门口不得被短延长误连：洞口判据先于延长，短延长口径不缩短门口", () => {
    // 同一面墙、同一墙轴上的 1.2 m 缺墙按门口处理：不补墙、不延长，两侧墙原样保留。
    const door = buildWallNetwork([seg([0, 0], [2, 0]), seg([3.2, 0], [8, 0])]);
    expect(door.join.extensions).toBe(0);
    expect(door.unclosed.filter(u => u.reason === "opening" && u.gapM === 1.2)).toHaveLength(2);
    // 洞口两侧的墙原样保留，没有被任何一条延长规则缩短或接上。
    expect(door.segments).toHaveLength(2);
    expect(door.segments[0]!.a).toEqual([0, 0]);
    expect(door.segments[0]!.b).toEqual([2, 0]);
    expect(door.segments[1]!.a).toEqual([3.2, 0]);
    expect(door.segments[1]!.b[0]).toBeCloseTo(8, 6);
  });

  it("平行近邻墙不被合并，开放端原因逐条给出位置", () => {
    const network = buildWallNetwork([seg([0, 0], [8, 0]), seg([0, .3], [8, .3])]);
    expect(network.join.joined).toBe(0);
    expect(network.join.dangling).toBe(4);
    expect(network.unclosed).toHaveLength(4);
    expect(network.unclosed.every(u => u.pointM.length === 2 && u.note.length > 0)).toBe(true);
  });

  it("闭合房间不做多余改动：四条墙各 8 m / 6 m，节点度数为 2", () => {
    const network = buildWallNetwork([seg([0, 0], [8, 0]), seg([8, 0], [8, 6]), seg([8, 6], [0, 6]), seg([0, 6], [0, 0])]);
    expect(network.segments).toHaveLength(4);
    expect(network.join.joined).toBe(0);
    expect(network.nodes.map(n => n.degree)).toEqual([2, 2, 2, 2]);
    expect(network.segments.map(length)).toEqual([8, 6, 8, 6]);
  });
});
