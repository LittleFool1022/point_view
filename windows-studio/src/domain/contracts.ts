import type { BuildingModel } from "./building";

/** 后续引擎必须消费同一修订的建筑模型，不能分别猜测 CAD/BIM 几何。 */
export interface EngineJob<T> { id: string; projectId: string; sourceRevision: number; input: T }
export type JobState<T> = { status: "queued" | "running"; stage: string } | { status: "completed"; result: T; sourceRevision: number } | { status: "cancelled" } | { status: "failed"; message: string };
export interface BimExportRequest { model: BuildingModel; format: "IFC4"; purpose: "review" | "delivery" }
export interface ArchitecturalRenderRequest {
  modelId: string; modelRevision: number; viewId: string;
  style: string; geometryControl: { depthAssetId: string; edgeAssetId: string };
  /** 效果图属于设计表达，不写回实测尺寸或建筑构件。 */
  purpose: "design-visualization";
}
export interface RenderProvider {
  id: string; execution: "local" | "remote";
  submit(job: EngineJob<ArchitecturalRenderRequest>, signal: AbortSignal): Promise<{ imageAssetId: string; modelRevision: number }>;
}
