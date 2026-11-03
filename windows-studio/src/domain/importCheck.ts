import type { PointCloudData } from "../../../src/domain/types";
import type { SourceUnit } from "../pipeline/analysis";

export interface ImportBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ImportResult {
  cloud: PointCloudData;
  bounds: ImportBounds;
}

export interface ImportCheck {
  /** 范围与点数能用于核对。 */
  valid: boolean;
  /** 需要用户确认单位后才能成图。 */
  suspicious: boolean;
  pointCount: number;
  minM: [number, number, number];
  maxM: [number, number, number];
  sizeM: [number, number, number];
  reasons: string[];
}

/** 只用于提示，不据此自动换算单位；阈值取常见建筑尺度边界的宽松值。 */
export const MAX_HORIZONTAL_EXTENT_M = 500;
export const MAX_HEIGHT_M = 100;
export const MIN_HORIZONTAL_EXTENT_M = 0.5;

export const SOURCE_UNIT_LABELS: Record<SourceUnit, string> = { m: "米", mm: "毫米" };

const finiteTriple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

const numberText = (value: number) => value.toFixed(2);

export function assessImportExtents(bounds: ImportBounds | undefined, pointCount: number | undefined): ImportCheck {
  const empty: [number, number, number] = [0, 0, 0];
  const count = Number.isSafeInteger(pointCount) && (pointCount ?? 0) > 0 ? pointCount! : 0;
  const reasons: string[] = [];
  if (count === 0) reasons.push("源点数缺失或无效。");
  if (!bounds || !finiteTriple(bounds.min) || !finiteTriple(bounds.max)) {
    return { valid: false, suspicious: true, pointCount: count, minM: empty, maxM: empty, sizeM: empty,
      reasons: [...reasons, "点云范围为空或包含无效坐标。"] };
  }
  const minM: [number, number, number] = [...bounds.min];
  const maxM: [number, number, number] = [...bounds.max];
  const sizeM: [number, number, number] = [maxM[0] - minM[0], maxM[1] - minM[1], maxM[2] - minM[2]];
  if (sizeM.some(v => v < 0)) {
    return { valid: false, suspicious: true, pointCount: count, minM, maxM, sizeM: empty,
      reasons: [...reasons, "点云范围上下限颠倒，无法核对单位。"] };
  }
  if (!count) {
    return { valid: false, suspicious: true, pointCount: count, minM, maxM, sizeM, reasons };
  }
  const horizontal = Math.max(sizeM[0], sizeM[1]);
  if (horizontal > MAX_HORIZONTAL_EXTENT_M) reasons.push(`水平范围 ${numberText(horizontal)} m，超过 ${MAX_HORIZONTAL_EXTENT_M} m。`);
  if (sizeM[2] > MAX_HEIGHT_M) reasons.push(`高度 ${numberText(sizeM[2])} m，超过 ${MAX_HEIGHT_M} m。`);
  if (horizontal < MIN_HORIZONTAL_EXTENT_M) reasons.push(`水平范围仅 ${numberText(horizontal)} m，小于 ${MIN_HORIZONTAL_EXTENT_M} m。`);
  return { valid: true, suspicious: reasons.length > 0, pointCount: count, minM, maxM, sizeM, reasons };
}
