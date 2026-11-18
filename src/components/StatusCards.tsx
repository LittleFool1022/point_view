import { Camera, Clock3, LocateFixed, RadioTower } from "lucide-react";
import type { GeoPosition } from "../domain/types";

interface StatusCardsProps {
  position?: GeoPosition;
  cameraOnline: number;
  cameraTotal: number;
  syncStatus: string;
  elapsed: string;
}

export function StatusCards({ position, cameraOnline, cameraTotal, syncStatus, elapsed }: StatusCardsProps) {
  const syncGood = ["locked", "synced", "ok"].includes(syncStatus.toLowerCase());
  const positioned = Boolean(position && position.fix !== "none");
  return <aside className="status-stack" aria-label="采集状态">
    <div className="status-card"><Camera /><span>相机</span><strong className={cameraOnline === cameraTotal && cameraTotal > 0 ? "good" : "warn"}>{cameraOnline === cameraTotal && cameraTotal > 0 ? "在线" : "等待"}</strong></div>
    <div className="status-card"><RadioTower /><span>时间</span><strong className={syncGood ? "good" : "warn"}>{syncGood ? "正常" : "等待"}</strong></div>
    <div className="status-card"><LocateFixed /><span>定位</span><strong className={positioned ? "good" : "warn"}>{positioned ? "正常" : "等待"}</strong></div>
    <div className="status-card"><Clock3 /><span>采集</span><strong>{elapsed}</strong></div>
  </aside>;
}
