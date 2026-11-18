import { Camera, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { CAMERA_DIRECTIONS, CAMERA_DIRECTION_LABELS, type CameraDirection } from "../domain/types";

interface CameraViewProps {
  direction: CameraDirection;
  imageUrl?: string;
  maximized: boolean;
  recording: boolean;
  elapsed: string;
  onCycle(): void;
  onMaximize(): void;
}

export function CameraView({ direction, imageUrl, maximized, recording, elapsed, onCycle, onMaximize }: CameraViewProps) {
  const label = `${CAMERA_DIRECTION_LABELS[direction]}相机`;
  const shortLabel = `${CAMERA_DIRECTION_LABELS[direction]}视`;
  const nextDirection = CAMERA_DIRECTIONS[(CAMERA_DIRECTIONS.indexOf(direction) + 1) % CAMERA_DIRECTIONS.length]!;
  const nextLabel = `${CAMERA_DIRECTION_LABELS[nextDirection]}相机`;
  return <section className={`camera-view panel-glass ${maximized ? "maximized" : ""}`}>
    {imageUrl
      ? <img src={imageUrl} alt={`${label}实时画面`} />
      : <div className="camera-empty"><Camera size={26} /><strong>{shortLabel}画面</strong><span>等待设备画面</span></div>}
    <button className="camera-badge" aria-label={`当前${label}，点击切换到${nextLabel}`} title={`点击切换到${nextLabel}`} onClick={onCycle}>
      <span>{shortLabel}</span>
      <RefreshCw aria-hidden="true" />
    </button>
    <button className="icon-button camera-max" onClick={onMaximize} aria-label={maximized ? "退出全屏" : `全屏${label}`} title={maximized ? "退出全屏（Esc）" : `全屏${label}`}>
      {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      {maximized ? <span>退出全屏</span> : null}
    </button>
    {recording && <div className="camera-rec" role="status"><i /> 正在录制 <code>{elapsed}</code></div>}
  </section>;
}
