import { describe, expect, it } from "vitest";
import { OPENING_M, MAX_EXTENSION_M, buildWallNetwork } from "../src/pipeline/wallNetwork";
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
    expect(apache.join.unclosed).toBe(2);
    expect(apache.unclosed.filter(u => u.reason === "no-alignment")).toHaveLength(2);
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

  it("一侧延伸回退时另一侧仍可补缝，回退记录不被覆盖", () => {
    // 0.1 m 的短墙补不到成墙长度（回退），但 0.6→6 m 的墙可以顺墙轴补到 0.1 m 处连上。
    const network = buildWallNetwork([seg([0, 0], [.1, 0]), seg([.6, 0], [6, 0])]);
    expect(network.join.revertedExtensions).toBe(1);
    expect(network.join.extensions).toBe(1);
    expect(network.notes.join(" ")).toContain("延伸不足");
    expect(network.segments.map(s => s.b)).toContainEqual([.1, 0]);
    expect(network.segments.some(s => s.a[0] === .1 && s.b[0] === 6)).toBe(true);
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
