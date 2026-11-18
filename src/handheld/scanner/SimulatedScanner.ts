import type { NetworkScenario, ScannerPort, ScanSnapshot } from "./types";

/** 只模拟设备独立采集：预览断线后继续计时，恢复连接后再同步预览。 */
export class SimulatedScanner implements ScannerPort {
  private snapshot: ScanSnapshot = {
    source: "simulation", connection: "offline", phase: "idle",
    seconds: 0, previewSeconds: 0, savedProject: null,
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private network: NetworkScenario = "normal";
  private connectAt = 0;
  private phaseAt = 0;
  private runningAt = 0;
  private elapsedMs = 0;
  private projectName = "";

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 200);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) { clearInterval(this.timer); this.timer = undefined; }
    };
  };
  private update(patch: Partial<ScanSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private tick() {
    const now = performance.now();
    if (this.snapshot.connection === "connecting" && now >= this.connectAt) {
      this.update({ connection: "online", previewSeconds: this.snapshot.seconds });
    }
    if (this.snapshot.phase === "initializing" && now >= this.phaseAt) {
      this.runningAt = now;
      this.update({ phase: "scanning" });
    }
    if (this.snapshot.phase === "scanning") {
      const seconds = Math.floor((this.elapsedMs + now - this.runningAt) / 1000);
      const previewSeconds = this.snapshot.connection === "online" ? seconds : this.snapshot.previewSeconds;
      if (seconds !== this.snapshot.seconds || previewSeconds !== this.snapshot.previewSeconds) this.update({ seconds, previewSeconds });
    }
    if (this.snapshot.phase === "saving" && now >= this.phaseAt) {
      const seconds = this.snapshot.seconds;
      this.update({ phase: "idle", savedProject: {
        id: `demo-${crypto.randomUUID()}`, name: this.projectName, location: "空间扫描",
        date: new Date().toISOString(), seconds, size: Math.max(24, seconds * 3),
        points: `${(Math.max(1, seconds) * 1.8).toFixed(1)} 万`,
        local: false, uploaded: false, kind: "studio",
      } });
    }
  }
  connect = () => {
    if (this.network === "offline" || this.snapshot.connection !== "offline") return;
    this.connectAt = performance.now() + (this.network === "slow" ? 5000 : 1600);
    this.update({ connection: "connecting" });
  };
  disconnect = () => this.update({ connection: "offline" });
  setNetwork = (network: NetworkScenario) => {
    this.network = network;
    if (network === "offline") this.disconnect();
  };
  start = () => {
    if (this.snapshot.connection !== "online" || this.snapshot.phase !== "idle") return;
    this.elapsedMs = 0;
    this.phaseAt = performance.now() + 2400;
    this.update({ phase: "initializing", seconds: 0, previewSeconds: 0, savedProject: null });
  };
  pause = () => {
    if (this.snapshot.connection !== "online" || this.snapshot.phase !== "scanning") return;
    this.elapsedMs += performance.now() - this.runningAt;
    this.update({ phase: "paused", seconds: Math.floor(this.elapsedMs / 1000) });
  };
  resume = () => {
    if (this.snapshot.connection !== "online" || this.snapshot.phase !== "paused") return;
    this.runningAt = performance.now();
    this.update({ phase: "scanning", previewSeconds: this.snapshot.seconds });
  };
  save = (name: string) => {
    if (!name.trim() || this.snapshot.connection !== "online" || !["scanning", "paused"].includes(this.snapshot.phase)) return;
    if (this.snapshot.phase === "scanning") this.elapsedMs += performance.now() - this.runningAt;
    this.projectName = name.trim();
    this.phaseAt = performance.now() + 2100;
    this.update({ phase: "saving", seconds: Math.floor(this.elapsedMs / 1000) });
  };
  discard = () => {
    if (this.snapshot.connection !== "online" || !["scanning", "paused"].includes(this.snapshot.phase)) return;
    this.elapsedMs = 0;
    this.update({ phase: "idle", seconds: 0, previewSeconds: 0, savedProject: null });
  };
}
