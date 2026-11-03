import {STUDIO_VERSION} from "../version";
import { parsePcd } from "../../../src/domain/pcd";
import { parsePly } from "../../../src/domain/ply";
import { parseLasOrLaz } from "../../../src/domain/las";
import type { PointCloudData } from "../../../src/domain/types";
import { buildDrawingModel, type CadDrawingSettings } from "../../../src/cad/model";
import type { CadProjection } from "../../../src/cad/geometry";

export type SourceUnit = "m" | "mm";
export async function decodeSource(name: string, buffer: ArrayBuffer, units: SourceUnit): Promise<PointCloudData> {
  const extension = name.split(".").at(-1)?.toLowerCase();
  const cloud = extension === "pcd" ? parsePcd(buffer) : extension === "ply" ? parsePly(buffer)
    : extension === "las" || extension === "laz" ? await parseLasOrLaz(buffer) : undefined;
  if (!cloud) throw Error("请选择 PCD、PLY、LAS 或 LAZ 测量成果。");
  if (!cloud.visible.length || cloud.visible.length > 4_000_000) throw Error("当前基座分析支持 1～400 万点；请先分区，分析不会静默抽样。");
  if (units === "mm") for (let i = 0; i < cloud.positions.length; i++) cloud.positions[i] *= .001;
  if (!cloud.positions.every(Number.isFinite)) throw Error("点云包含无效坐标，请检查源文件。");
  return cloud;
}
export function generateDrawing(cloud: PointCloudData, name: string, projection: CadProjection, settings: Partial<CadDrawingSettings>) {
  return buildDrawingModel({ cloud, projection, sourceName: name, settings: { ...settings, inferWallGaps: false }, softwareVersion: `Survey Studio ${STUDIO_VERSION}`, drawnBy: "观曜测量成果工作台" });
}
