export const QUALITY_REPORT_VERSION = "point-view-quality/1.0.0";

export type QualityProfileId = "omni-realtime" | "metric-map" | "3dgs-ready";
export type QualityDimension = "geometry" | "registration" | "color" | "sync" | "coverage" | "delivery";
export type QualityStatus = "pass" | "warn" | "fail" | "unavailable" | "info";

export interface QualityThreshold {
  direction: "min" | "max";
  pass: number;
  fail: number;
}

export interface QualityMetric {
  id: string;
  label: string;
  dimension: QualityDimension;
  value: number | null;
  unit: string;
  status: QualityStatus;
  score: number | null;
  confidence: number;
  threshold?: QualityThreshold;
  evidence: string;
}

export interface QualityDimensionResult {
  id: QualityDimension;
  label: string;
  score: number | null;
  status: QualityStatus;
  availableMetrics: number;
  totalMetrics: number;
}

export interface QualityGate {
  id: string;
  label: string;
  status: "pass" | "fail" | "unavailable";
  evidence: string;
}

export interface StaticQualityEvidence {
  analyzerVersion: string;
  source: {
    fileName: string;
    format: "pcd";
    declaredPointCount: number;
    analyzedPointCount: number;
    samplingRatio: number;
    deterministicSampling: true;
    colorFieldPresent: boolean;
    intensityFieldPresent: boolean;
    frameIdDeclared: boolean;
    timestampDeclared: boolean;
  };
  geometry: {
    validPointCount: number;
    finiteRatio: number;
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
    extent: [number, number, number];
    diagonalM: number;
    medianNearestSpacingM: number | null;
    densityCv: number | null;
    outlierRatio: number | null;
    duplicateRatio: number;
    roughnessP90M: number | null;
    primaryGridOccupancy: number | null;
  };
  color: {
    rgbCoverageRatio: number | null;
    darkPointRatio: number | null;
    brightPointRatio: number | null;
    channelMean: [number, number, number] | null;
    colorCastRatio: number | null;
  };
  limitations: string[];
};

export interface QualityReport {
  schemaVersion: typeof QUALITY_REPORT_VERSION;
  reportId: string;
  generatedAt: string;
  profile: { id: QualityProfileId; name: string; version: string };
  source: StaticQualityEvidence["source"];
  dimensions: Record<QualityDimension, QualityDimensionResult>;
  metrics: QualityMetric[];
  hardGates: QualityGate[];
  overallScore: number | null;
  confidence: number;
  deliveryStatus: {
    status: "pass" | "partial" | "fail";
    reason: string;
  };
  evidence: StaticQualityEvidence;
}
