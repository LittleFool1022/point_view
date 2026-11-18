import type { PointCloudData } from "../domain/types";
import { QUALITY_PROFILES } from "./profiles";
import {
  QUALITY_REPORT_VERSION,
  type QualityDimension,
  type QualityDimensionResult,
  type QualityGate,
  type QualityMetric,
  type QualityProfileId,
  type QualityReport,
  type QualityStatus,
  type QualityThreshold,
  type StaticQualityEvidence,
} from "./types";

const ANALYZER_VERSION = "static-pcd/1.0.1";
const DIMENSION_LABELS: Record<QualityDimension, string> = {
  geometry: "几何",
  registration: "配准",
  color: "颜色",
  sync: "同步",
  coverage: "覆盖",
  delivery: "交付",
};

export function createStableQualitySample(cloud: PointCloudData, maxPoints = 20_000): PointCloudData {
  const total = cloud.positions.length / 3;
  const count = Math.min(total, Math.max(1, Math.floor(maxPoints)));
  if (count === total) {
    return {
      ...cloud,
      positions: cloud.positions.slice(),
      colors: cloud.colors.slice(),
      intensities: cloud.intensities?.slice(),
      visible: cloud.visible.slice(),
    };
  }
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const intensities = cloud.intensities ? new Float32Array(count) : undefined;
  let randomState = (total ^ 0x9e3779b9) >>> 0;
  const randomIndex = (limit: number) => {
    randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
    return (randomState >>> 0) % limit;
  };
  // Floyd 算法只迭代采样数量，不遍历百万点数组；固定种子保证结果可复现。
  const selected = new Set<number>();
  for (let cursor = total - count; cursor < total; cursor++) {
    const candidate = randomIndex(cursor + 1);
    selected.add(selected.has(candidate) ? cursor : candidate);
  }
  const indices = [...selected].sort((a, b) => a - b);
  for (let target = 0; target < count; target++) {
    const source = indices[target]!;
    positions.set(cloud.positions.subarray(source * 3, source * 3 + 3), target * 3);
    colors.set(cloud.colors.subarray(source * 3, source * 3 + 3), target * 3);
    if (intensities) intensities[target] = cloud.intensities![source]!;
  }
  return {
    ...cloud,
    positions,
    colors,
    intensities,
    visible: new Uint8Array(count).fill(1),
  };
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]!;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function smallestEigenvalue(
  xx: number, xy: number, xz: number,
  yy: number, yz: number, zz: number,
): number {
  const offDiagonal = xy * xy + xz * xz + yz * yz;
  if (offDiagonal === 0) return Math.min(xx, yy, zz);
  const q = (xx + yy + zz) / 3;
  const p = Math.sqrt(((xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * offDiagonal) / 6);
  if (p === 0) return 0;
  const b00 = (xx - q) / p, b01 = xy / p, b02 = xz / p;
  const b11 = (yy - q) / p, b12 = yz / p, b22 = (zz - q) / p;
  const determinant = b00 * (b11 * b22 - b12 * b12)
    - b01 * (b01 * b22 - b12 * b02)
    + b02 * (b01 * b12 - b11 * b02);
  const phi = Math.acos(Math.max(-1, Math.min(1, determinant / 2))) / 3;
  const largest = q + 2 * p * Math.cos(phi);
  const smallest = q + 2 * p * Math.cos(phi + (2 * Math.PI / 3));
  const middle = 3 * q - largest - smallest;
  return Math.max(0, Math.min(largest, middle, smallest));
}

interface SpatialIndex {
  cells: Map<string, number[]>;
  key(x: number, y: number, z: number): [number, number, number];
}

function createSpatialIndex(points: Array<[number, number, number]>, min: [number, number, number], cellSize: number): SpatialIndex {
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): [number, number, number] => [
    Math.floor((x - min[0]) / cellSize),
    Math.floor((y - min[1]) / cellSize),
    Math.floor((z - min[2]) / cellSize),
  ];
  points.forEach((point, index) => {
    const cell = key(...point);
    const text = cell.join(",");
    const bucket = cells.get(text);
    if (bucket) bucket.push(index); else cells.set(text, [index]);
  });
  return { cells, key };
}

function neighborIndices(index: SpatialIndex, point: [number, number, number], radius: number): number[] {
  const [cx, cy, cz] = index.key(...point);
  const output: number[] = [];
  for (let x = cx - radius; x <= cx + radius; x++) {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        const bucket = index.cells.get(`${x},${y},${z}`);
        if (bucket) output.push(...bucket);
      }
    }
  }
  return output;
}

export function analyzeStaticPointCloud(cloud: PointCloudData, fileName: string): StaticQualityEvidence {
  const total = cloud.positions.length / 3;
  const declaredPointCount = cloud.sourcePointCount ?? total;
  const validSourceIndices: number[] = [];
  const points: Array<[number, number, number]> = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const exact = new Set<string>();
  let duplicates = 0;

  for (let index = 0; index < total; index++) {
    const offset = index * 3;
    const x = cloud.positions[offset]!, y = cloud.positions[offset + 1]!, z = cloud.positions[offset + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    validSourceIndices.push(index);
    points.push([x, y, z]);
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
    const key = `${x},${y},${z}`;
    if (exact.has(key)) duplicates++; else exact.add(key);
  }

  const valid = points.length;
  const finiteRatio = valid / Math.max(1, total);
  const safeMin: [number, number, number] = valid ? min : [0, 0, 0];
  const safeMax: [number, number, number] = valid ? max : [0, 0, 0];
  const extent: [number, number, number] = [safeMax[0] - safeMin[0], safeMax[1] - safeMin[1], safeMax[2] - safeMin[2]];
  const diagonalM = Math.hypot(...extent);

  let medianNearestSpacingM: number | null = null;
  let densityCv: number | null = null;
  let outlierRatio: number | null = null;
  let roughnessP90M: number | null = null;
  let primaryGridOccupancy: number | null = null;

  if (valid >= 3 && diagonalM > 0) {
    const cellSize = Math.max(1e-5, diagonalM / Math.max(8, Math.cbrt(valid) * 1.5));
    const spatial = createSpatialIndex(points, safeMin, cellSize);
    const nearest: number[] = [];
    points.forEach((point, pointIndex) => {
      let candidates = neighborIndices(spatial, point, 1);
      if (candidates.length <= 1) candidates = neighborIndices(spatial, point, 2);
      let best = Infinity;
      for (const candidate of candidates) {
        if (candidate === pointIndex) continue;
        const other = points[candidate]!;
        const distance = Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]);
        if (distance < best) best = distance;
      }
      nearest.push(best);
    });
    const finiteNearest = nearest.filter(Number.isFinite);
    const positiveNearest = finiteNearest.filter((value) => value > 0);
    medianNearestSpacingM = percentile(positiveNearest, 0.5);
    if (positiveNearest.length > 1) {
      const average = mean(positiveNearest);
      densityCv = Math.sqrt(mean(positiveNearest.map((value) => (value - average) ** 2))) / Math.max(1e-9, average);
      const median = medianNearestSpacingM ?? average;
      const mad = percentile(positiveNearest.map((value) => Math.abs(value - median)), 0.5) ?? 0;
      const limit = Math.max(median * 3, median + 3 * 1.4826 * mad);
      outlierRatio = nearest.filter((value) => !Number.isFinite(value) || value > limit).length / nearest.length;
    }

    const roughness: number[] = [];
    const roughnessStep = Math.max(1, Math.floor(valid / 2_000));
    for (let pointIndex = 0; pointIndex < valid; pointIndex += roughnessStep) {
      const point = points[pointIndex]!;
      let candidates = neighborIndices(spatial, point, 1).filter((item) => item !== pointIndex);
      if (candidates.length < 6) candidates = neighborIndices(spatial, point, 2).filter((item) => item !== pointIndex);
      candidates = candidates
        .map((item) => ({ item, distance: Math.hypot(point[0] - points[item]![0], point[1] - points[item]![1], point[2] - points[item]![2]) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 16)
        .map(({ item }) => item);
      if (candidates.length < 6) continue;
      const neighborhood = candidates.map((item) => points[item]!);
      const cx = mean(neighborhood.map((item) => item[0]));
      const cy = mean(neighborhood.map((item) => item[1]));
      const cz = mean(neighborhood.map((item) => item[2]));
      let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
      for (const item of neighborhood) {
        const x = item[0] - cx, y = item[1] - cy, z = item[2] - cz;
        xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
      }
      const scale = 1 / neighborhood.length;
      const cxx = xx * scale, cyy = yy * scale, czz = zz * scale;
      const smallest = smallestEigenvalue(cxx, xy * scale, xz * scale, cyy, yz * scale, czz);
      const trace = cxx + cyy + czz;
      // 只在近似平面邻域统计粗糙度，排除墙角、物体边缘和植被等非平面结构。
      if (trace > 0 && smallest / trace <= 0.05) roughness.push(Math.sqrt(smallest));
    }
    roughnessP90M = percentile(roughness, 0.9);

    const axes = [0, 1, 2].sort((a, b) => extent[b]! - extent[a]!).slice(0, 2);
    if (extent[axes[0]!]! > 0 && extent[axes[1]!]! > 0) {
      const occupied = new Set<string>();
      for (const point of points) {
        const a = Math.min(15, Math.floor(((point[axes[0]!] - safeMin[axes[0]!]!) / extent[axes[0]!]!) * 16));
        const b = Math.min(15, Math.floor(((point[axes[1]!] - safeMin[axes[1]!]!) / extent[axes[1]!]!) * 16));
        occupied.add(`${a},${b}`);
      }
      primaryGridOccupancy = occupied.size / 256;
    }
  }

  const colorFieldPresent = cloud.attributes?.hasColor ?? false;
  let rgbCoverageRatio: number | null = null;
  let darkPointRatio: number | null = null;
  let brightPointRatio: number | null = null;
  let channelMean: [number, number, number] | null = null;
  let colorCastRatio: number | null = null;
  if (colorFieldPresent && valid > 0) {
    let validColors = 0, dark = 0, bright = 0, red = 0, green = 0, blue = 0;
    for (const sourceIndex of validSourceIndices) {
      const offset = sourceIndex * 3;
      const r = cloud.colors[offset], g = cloud.colors[offset + 1], b = cloud.colors[offset + 2];
      if (r === undefined || g === undefined || b === undefined) continue;
      validColors++; red += r; green += g; blue += b;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luminance < 15) dark++;
      if (luminance > 245) bright++;
    }
    rgbCoverageRatio = validColors / valid;
    darkPointRatio = dark / Math.max(1, validColors);
    brightPointRatio = bright / Math.max(1, validColors);
    channelMean = [red / Math.max(1, validColors), green / Math.max(1, validColors), blue / Math.max(1, validColors)];
    colorCastRatio = (Math.max(...channelMean) - Math.min(...channelMean)) / 255;
  }

  return {
    analyzerVersion: ANALYZER_VERSION,
    source: {
      fileName,
      format: "pcd",
      declaredPointCount,
      analyzedPointCount: total,
      samplingRatio: total / Math.max(1, declaredPointCount),
      deterministicSampling: true,
      colorFieldPresent,
      intensityFieldPresent: cloud.attributes?.hasIntensity ?? Boolean(cloud.intensities),
      frameIdDeclared: cloud.attributes?.frameIdDeclared ?? false,
      timestampDeclared: cloud.attributes?.timestampDeclared ?? false,
    },
    geometry: {
      validPointCount: valid,
      finiteRatio,
      boundsMin: safeMin,
      boundsMax: safeMax,
      extent,
      diagonalM,
      medianNearestSpacingM,
      densityCv,
      outlierRatio,
      duplicateRatio: duplicates / Math.max(1, valid),
      roughnessP90M,
      primaryGridOccupancy,
    },
    color: { rgbCoverageRatio, darkPointRatio, brightPointRatio, channelMean, colorCastRatio },
    limitations: [
      "静态 PCD 不包含连续帧，无法评估频率、延迟、丢帧、三目时间差和时间戳倒退",
      "缺少轨迹与逐帧点云，无法评估帧间重叠、配准残差、位姿跳变、重影和闭环漂移",
      "点云 RGB 只能评估颜色覆盖及亮暗代理，不能替代原图模糊、曝光和重投影误差",
      "主平面栅格占用率仅为静态空间覆盖代理，不能替代轨迹和视角覆盖分析",
    ],
  };
}

function scoreThreshold(value: number | null, threshold: QualityThreshold): { score: number | null; status: QualityStatus } {
  if (value === null || !Number.isFinite(value)) return { score: null, status: "unavailable" };
  const pass = threshold.direction === "min" ? value >= threshold.pass : value <= threshold.pass;
  const fail = threshold.direction === "min" ? value <= threshold.fail : value >= threshold.fail;
  if (pass) return { score: 100, status: "pass" };
  if (fail) return { score: 0, status: "fail" };
  const ratio = threshold.direction === "min"
    ? (value - threshold.fail) / (threshold.pass - threshold.fail)
    : (threshold.fail - value) / (threshold.fail - threshold.pass);
  return { score: Math.round(Math.max(0, Math.min(1, ratio)) * 100), status: "warn" };
}

export function buildQualityReport(evidence: StaticQualityEvidence, profileId: QualityProfileId): QualityReport {
  const profile = QUALITY_PROFILES[profileId];
  const metrics: QualityMetric[] = [];
  const add = (
    id: string, label: string, dimension: QualityDimension, value: number | null, unit: string,
    evidenceText: string, confidence = 1, thresholdId: string | null = id,
  ) => {
    const threshold = thresholdId ? profile.thresholds[thresholdId] : undefined;
    const scored = threshold ? scoreThreshold(value, threshold) : { score: null, status: value === null ? "unavailable" as const : "info" as const };
    metrics.push({ id, label, dimension, value, unit, confidence, threshold, evidence: evidenceText, ...scored });
  };
  const unavailable = (id: string, label: string, dimension: QualityDimension, evidenceText: string) =>
    metrics.push({ id, label, dimension, value: null, unit: "", status: "unavailable", score: null, confidence: 0, evidence: evidenceText });

  add("finiteRatio", "有限坐标比例", "geometry", evidence.geometry.finiteRatio, "ratio", `${evidence.geometry.validPointCount}/${evidence.source.analyzedPointCount} 个分析点坐标有限`);
  add("outlierRatio", "离群点比例", "geometry", evidence.geometry.outlierRatio, "ratio", "基于稳定采样、空间哈希和稳健最近邻阈值");
  add("densityCv", "点间距变异系数", "geometry", evidence.geometry.densityCv, "ratio", "最近邻距离标准差/均值；用于衡量密度均匀性");
  add("roughnessP90M", "局部平面粗糙度 P90", "geometry", evidence.geometry.roughnessP90M, "m", "最多 2000 个近似平面邻域的最小协方差特征值平方根");
  add("medianNearestSpacingM", "最近邻间距中位数", "geometry", evidence.geometry.medianNearestSpacingM, "m", "密度原始值；场景尺度未知，不参与首版评分", 0.8, null);
  add("diagonalM", "包围盒对角线", "geometry", evidence.geometry.diagonalM, "m", `范围 ${evidence.geometry.extent.map((value) => value.toFixed(3)).join(" × ")} m`, 1, null);

  add("rgbCoverageRatio", "RGB 有效覆盖率", "color", evidence.color.rgbCoverageRatio, "ratio", evidence.source.colorFieldPresent ? "PCD 声明 RGB/RGBA 或独立 r/g/b 字段" : "PCD 未声明颜色字段");
  add("darkPointRatio", "暗色点比例", "color", evidence.color.darkPointRatio, "ratio", "点云颜色亮度 < 15/255；仅为原图欠曝代理", 0.65);
  add("brightPointRatio", "亮色点比例", "color", evidence.color.brightPointRatio, "ratio", "点云颜色亮度 > 245/255；仅为原图过曝代理", 0.65);
  add("colorCastRatio", "通道均值色差", "color", evidence.color.colorCastRatio, "ratio", "RGB 通道均值最大差/255；受场景本色影响", 0.5);

  add("duplicateRatio", "完全重复点比例", "coverage", evidence.geometry.duplicateRatio, "ratio", "稳定采样中坐标完全相同的点");
  add("primaryGridOccupancy", "主平面栅格占用率", "coverage", evidence.geometry.primaryGridOccupancy, "ratio", "包围盒最大两轴上的 16×16 栅格；仅作静态覆盖代理", 0.55);
  unavailable("spatialHoles", "空间孔洞率", "coverage", "缺少表面拓扑、轨迹和传感器视锥");
  unavailable("viewCoverage", "视角覆盖率", "coverage", "静态 PCD 不包含相机位姿和可见性");
  unavailable("trajectoryContinuity", "轨迹连续性", "coverage", "未提供 odometry/path");

  unavailable("frameOverlap", "相邻帧重叠率", "registration", "静态 PCD 不包含相邻帧");
  unavailable("registrationResidual", "点到平面配准残差 P90", "registration", "局部粗糙度不能冒充帧间配准残差");
  unavailable("poseJump", "位姿跳变", "registration", "未提供逐帧位姿");
  unavailable("loopDrift", "闭环相对漂移", "registration", "未提供闭环轨迹或参考约束");

  unavailable("freshness", "点云新鲜度", "sync", "静态 PCD 没有接收时间");
  unavailable("frequency", "点云频率", "sync", "静态 PCD 不是连续消息流");
  unavailable("triCameraDeltaP95", "三目时间差 P95", "sync", "未提供三路点云/图像 header 时间戳");
  unavailable("frameConsistency", "坐标系一致性", "sync", evidence.source.frameIdDeclared ? "只观察到单一 frame" : "PCD 未声明 ROS frame_id");

  add("pcdPresent", "PCD 数据存在", "delivery", 1, "bool", `${evidence.source.fileName} 可解析，声明 ${evidence.source.declaredPointCount} 点`);
  unavailable("imagesPresent", "原始图片完整性", "delivery", "未提供图片目录");
  unavailable("posesPresent", "位姿完整性", "delivery", "未提供 odometry/path/COLMAP images.txt");
  unavailable("calibrationPresent", "标定完整性", "delivery", "未提供相机内外参和版本");

  const dimensionMetricWeights: Partial<Record<string, number>> = {
    finiteRatio: 0.35, outlierRatio: 0.3, densityCv: 0.15, roughnessP90M: 0.2,
    rgbCoverageRatio: 0.5, darkPointRatio: 0.2, brightPointRatio: 0.2, colorCastRatio: 0.1,
    duplicateRatio: 0.35, primaryGridOccupancy: 0.65,
  };
  const dimensions = {} as Record<QualityDimension, QualityDimensionResult>;
  for (const dimension of Object.keys(DIMENSION_LABELS) as QualityDimension[]) {
    const candidates = metrics.filter((metric) => metric.dimension === dimension);
    const scored = candidates.filter((metric) => metric.score !== null);
    const weightSum = scored.reduce((sum, metric) => sum + (dimensionMetricWeights[metric.id] ?? 1), 0);
    const score = weightSum > 0
      ? Math.round(scored.reduce((sum, metric) => sum + metric.score! * (dimensionMetricWeights[metric.id] ?? 1), 0) / weightSum)
      : null;
    const status: QualityStatus = score === null ? "unavailable" : score >= 80 ? "pass" : score >= 60 ? "warn" : "fail";
    dimensions[dimension] = { id: dimension, label: DIMENSION_LABELS[dimension], score, status, availableMetrics: scored.length, totalMetrics: candidates.length };
  }

  const hardGates: QualityGate[] = [
    {
      id: "finite-coordinates",
      label: "坐标有效性",
      status: evidence.geometry.finiteRatio < 0.99 ? "fail" : "pass",
      evidence: `有限坐标比例 ${(evidence.geometry.finiteRatio * 100).toFixed(3)}%，失败线 99%`,
    },
    {
      id: "non-degenerate-range",
      label: "有效空间范围",
      status: evidence.geometry.diagonalM > 0 ? "pass" : "fail",
      evidence: `包围盒对角线 ${evidence.geometry.diagonalM.toFixed(4)} m`,
    },
    {
      id: "coordinate-consistency",
      label: "坐标系一致性",
      status: "unavailable",
      evidence: "单个 PCD 且没有 ROS frame_id 序列，无法证明一致或不一致",
    },
    {
      id: "timestamp-monotonic",
      label: "时间戳单调性",
      status: "unavailable",
      evidence: "静态 PCD 没有消息时间序列",
    },
  ];
  if (profileId === "3dgs-ready") {
    hardGates.push(
      { id: "3dgs-images", label: "3DGS 原始图片", status: "fail", evidence: "仅提供 PCD，缺少原始图片" },
      { id: "3dgs-poses", label: "3DGS 相机位姿", status: "fail", evidence: "仅提供 PCD，缺少相机位姿" },
      { id: "3dgs-calibration", label: "3DGS 标定", status: "fail", evidence: "仅提供 PCD，缺少相机内外参" },
    );
  }

  const weightedDimensions = (Object.keys(dimensions) as QualityDimension[])
    .filter((dimension) => dimensions[dimension].score !== null && profile.dimensionWeights[dimension] > 0);
  const availableWeight = weightedDimensions.reduce((sum, dimension) => sum + profile.dimensionWeights[dimension], 0);
  const overallScore = availableWeight > 0
    ? Math.round(weightedDimensions.reduce((sum, dimension) => sum + dimensions[dimension].score! * profile.dimensionWeights[dimension], 0) / availableWeight)
    : null;
  const sampleConfidence = Math.min(1, Math.sqrt(evidence.geometry.validPointCount / 20_000));
  const metricConfidence = weightedDimensions.length
    ? mean(weightedDimensions.flatMap((dimension) => metrics.filter((metric) => metric.dimension === dimension && metric.score !== null).map((metric) => metric.confidence)))
    : 0;
  const confidence = Math.round(availableWeight * sampleConfidence * metricConfidence * 100) / 100;
  const failedGate = hardGates.find((gate) => gate.status === "fail");
  const deliveryStatus: QualityReport["deliveryStatus"] = failedGate
    ? { status: "fail", reason: `不通过：${failedGate.label}（${failedGate.evidence}）` }
    : confidence < 0.75
      ? { status: "partial", reason: "部分评估：静态 PCD 指标已计算，实时、轨迹、图像和标定项无法评估" }
      : overallScore !== null && overallScore >= 80
        ? { status: "pass", reason: "已评估项目通过；仍需结合未提供的数据完成最终交付门禁" }
        : { status: "fail", reason: "不通过：已评估质量分低于 80" };

  return {
    schemaVersion: QUALITY_REPORT_VERSION,
    reportId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    profile: { id: profile.id, name: profile.name, version: profile.version },
    source: evidence.source,
    dimensions,
    metrics,
    hardGates,
    overallScore,
    confidence,
    deliveryStatus,
    evidence,
  };
}
