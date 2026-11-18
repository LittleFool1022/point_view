import type { DemoProject } from "../demoData";

export type ScanPhase = "idle" | "initializing" | "scanning" | "paused" | "saving";
export type ConnectionState = "offline" | "connecting" | "online";
export type NetworkScenario = "normal" | "slow" | "offline";

export interface ScanSnapshot {
  source: "simulation";
  connection: ConnectionState;
  phase: ScanPhase;
  seconds: number;
  previewSeconds: number;
  savedProject: DemoProject | null;
}

/** 手机侧会话语义；真实适配器必须以设备回执更新状态，不能复用模拟计时器。 */
export interface ScannerPort {
  getSnapshot(): ScanSnapshot;
  subscribe(listener: () => void): () => void;
  connect(): void;
  disconnect(): void;
  start(): void;
  pause(): void;
  resume(): void;
  save(name: string): void;
  discard(): void;
}
