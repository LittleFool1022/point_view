export interface DeviceProject {
  id: string; fileName: string; bytes: number; points: number; sha256: string;
  createdAtMs?: number; backupVerified: boolean; captureIntegrity: "passed" | "warning" | "unknown";
  keyframesState?: "complete" | "partial" | "recording" | "invalid" | "unavailable";
  keyframeSets?: Array<import("./source").KeyframePage & {frames:number}>;
}
export interface DeviceReceipt {
  schema: "survey-device-receipt/1"; deviceOrigin: string; session: string; fileName: string;
  bytes: number; points: number; sha256: string; receivedAt: string;
  desktopReceivedVerified: true; deviceBackupVerified: boolean;
  captureIntegrity: "passed" | "warning" | "unknown"; qualityVerified: false;
  keyframesState?: DeviceProject["keyframesState"]; keyframeSets?: DeviceProject["keyframeSets"];
}
export function assertDeviceReceipt(receipt: unknown, source: { name: string; sha256: string; size?: number }) {
  const r = receipt as DeviceReceipt;
  if (!r || r.schema !== "survey-device-receipt/1" || typeof r.deviceOrigin !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(r.session) || r.session.includes("..")
    || r.fileName !== source.name || r.sha256 !== source.sha256 || !/^[a-f0-9]{64}$/.test(r.sha256)
    || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || (source.size !== undefined && r.bytes !== source.size)
    || !Number.isSafeInteger(r.points) || r.points < 1 || !Number.isFinite(Date.parse(r.receivedAt))
    || r.desktopReceivedVerified !== true || typeof r.deviceBackupVerified !== "boolean"
    || !["passed", "warning", "unknown"].includes(r.captureIntegrity) || r.qualityVerified !== false) {
    throw Error("设备接收回执与工程原件不一致。");
  }
}
