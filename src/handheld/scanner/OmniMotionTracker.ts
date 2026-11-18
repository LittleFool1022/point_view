import type { OdometrySample } from "../../transport/foxgloveSource";

/** 从 OMNI 定位位移计算三维平均速度；使用 ROS 时间，避免无线传输抖动。 */
export class OmniMotionTracker {
  private anchor?: OdometrySample;
  private latestStamp?: number;
  reset() { this.anchor = undefined; this.latestStamp = undefined; }

  sample(sample: OdometrySample): { speed: number | null; reset: boolean } | null {
    const { timestamp, position, frameId } = sample;
    if (![timestamp, position.x, position.y, position.z].every(Number.isFinite) || timestamp < 0) {
      this.reset(); return { speed: null, reset: true };
    }
    if (timestamp === this.latestStamp) return null;
    if (!this.anchor || frameId !== this.anchor.frameId || timestamp < (this.latestStamp ?? timestamp)
      || timestamp - (this.latestStamp ?? timestamp) > 2) {
      this.anchor = sample; this.latestStamp = timestamp;
      return { speed: null, reset: true };
    }
    this.latestStamp = timestamp;
    const elapsed = timestamp - this.anchor.timestamp;
    if (elapsed < 0.3) return null;
    const previous = this.anchor.position;
    const speed = Math.hypot(position.x - previous.x, position.y - previous.y, position.z - previous.z) / elapsed;
    this.anchor = sample;
    return { speed: Number.isFinite(speed) ? speed : null, reset: false };
  }
}
