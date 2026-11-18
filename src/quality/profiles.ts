import type { QualityDimension, QualityProfileId, QualityThreshold } from "./types";

export interface QualityProfile {
  id: QualityProfileId;
  name: string;
  version: string;
  dimensionWeights: Record<QualityDimension, number>;
  thresholds: Record<string, QualityThreshold>;
}

const commonThresholds: Record<string, QualityThreshold> = {
  finiteRatio: { direction: "min", pass: 0.999, fail: 0.99 },
  outlierRatio: { direction: "max", pass: 0.03, fail: 0.08 },
  duplicateRatio: { direction: "max", pass: 0.05, fail: 0.15 },
  densityCv: { direction: "max", pass: 0.75, fail: 1.5 },
  roughnessP90M: { direction: "max", pass: 0.05, fail: 0.1 },
  primaryGridOccupancy: { direction: "min", pass: 0.4, fail: 0.15 },
  rgbCoverageRatio: { direction: "min", pass: 0.95, fail: 0.8 },
  darkPointRatio: { direction: "max", pass: 0.1, fail: 0.25 },
  brightPointRatio: { direction: "max", pass: 0.1, fail: 0.25 },
  colorCastRatio: { direction: "max", pass: 0.15, fail: 0.35 },
  pcdPresent: { direction: "min", pass: 1, fail: 0 },
};

export const QUALITY_PROFILES: Record<QualityProfileId, QualityProfile> = {
  "omni-realtime": {
    id: "omni-realtime",
    name: "omni 实时采集",
    version: "1.0.0",
    dimensionWeights: { geometry: 0.2, registration: 0.2, color: 0.1, sync: 0.35, coverage: 0.1, delivery: 0.05 },
    thresholds: commonThresholds,
  },
  "metric-map": {
    id: "metric-map",
    name: "度量建图",
    version: "1.0.0",
    dimensionWeights: { geometry: 0.35, registration: 0.25, color: 0.05, sync: 0.05, coverage: 0.25, delivery: 0.05 },
    thresholds: commonThresholds,
  },
  "3dgs-ready": {
    id: "3dgs-ready",
    name: "3DGS 交付",
    version: "1.0.0",
    dimensionWeights: { geometry: 0.1, registration: 0.15, color: 0.25, sync: 0.1, coverage: 0.25, delivery: 0.15 },
    thresholds: {
      ...commonThresholds,
      rgbCoverageRatio: { direction: "min", pass: 0.98, fail: 0.9 },
      darkPointRatio: { direction: "max", pass: 0.08, fail: 0.2 },
      brightPointRatio: { direction: "max", pass: 0.08, fail: 0.2 },
    },
  },
};

export const QUALITY_PROFILE_IDS = Object.keys(QUALITY_PROFILES) as QualityProfileId[];
