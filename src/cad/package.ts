import { strToU8, zipSync } from "fflate";
import { exportCadDxf } from "./dxf";
import type { DrawingModel } from "./model";

export interface CadExportedFile {
  name: string;
  size: number;
  mime: string;
  sha256?: string;
}

export interface CadDeliveryResult {
  archiveName: string;
  archive: Uint8Array;
  files: CadExportedFile[];
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function createAnnotationPayload(model: DrawingModel) {
  return {
    schemaVersion: "point-view-cad-annotations/1.0.0",
    drawingId: model.drawingId,
    sourceProjectId: model.sourceProjectId,
    sourceName: model.sourceName,
    units: model.units,
    sourceCoordinateSystem: model.sourceCoordinateSystem,
    drawingCoordinateSystem: model.drawingCoordinateSystem,
    view: model.view,
    paperSize: model.paperSize,
    scale: model.scale,
    generatedAt: model.generatedAt,
    areaMethod: "room-net-area-not-available",
    statistics: model.statistics,
    entities: model.entities.map((entity) => ({
      id: entity.id,
      category: entity.category,
      type: entity.type,
      layer: entity.layer,
      source: entity.source,
      confidence: entity.confidence,
      geometry: entity.type === "line"
        ? { start_mm: entity.start, end_mm: entity.end }
        : entity.type === "polyline"
          ? { points_mm: entity.points, closed: entity.closed }
          : entity.type === "text"
            ? { point_mm: entity.position, height_mm: entity.heightMm, rotation_degrees: entity.rotationDegrees ?? 0 }
            : { point_mm: entity.position },
      ...(entity.type === "text" ? { text: entity.text } : {}),
      metadata: entity.metadata,
    })),
    annotations: model.annotations,
    dimensions: model.dimensions ?? [],
    accuracy: model.accuracy,
    warnings: model.warnings,
    software: { name: "Point View", version: model.titleBlock.softwareVersion, drawingSchema: model.schemaVersion },
  };
}

/** 生成跨 Electron、Capacitor 和浏览器均可一次保存的标准三文件成果包。 */
export async function createCadDelivery(model: DrawingModel, baseName: string): Promise<CadDeliveryResult> {
  const safeBase = baseName.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "-") || "point-view-cad";
  const dxfName = `${safeBase}.dxf`;
  const annotationName = `${safeBase}.annotations.json`;
  const manifestName = `${safeBase}.manifest.json`;
  const dxf = exportCadDxf(model);
  const annotationBytes = strToU8(JSON.stringify(createAnnotationPayload(model), null, 2));
  const [dxfHash, annotationHash] = await Promise.all([sha256(dxf), sha256(annotationBytes)]);
  const files: CadExportedFile[] = [
    { name: dxfName, size: dxf.byteLength, mime: "application/dxf", sha256: dxfHash },
    { name: annotationName, size: annotationBytes.byteLength, mime: "application/json", sha256: annotationHash },
  ];
  const manifest = {
    schemaVersion: "point-view-cad-manifest/1.0.0",
    drawingId: model.drawingId,
    sourceProjectId: model.sourceProjectId,
    generatedAt: model.generatedAt,
    units: model.units,
    sourceCoordinateSystem: model.sourceCoordinateSystem,
    drawingCoordinateSystem: model.drawingCoordinateSystem,
    paperSize: model.paperSize,
    scale: model.scale,
    accuracy: model.accuracy,
    warnings: model.warnings,
    files,
  };
  const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
  files.push({ name: manifestName, size: manifestBytes.byteLength, mime: "application/json" });
  const folder = `${safeBase}/`;
  const archive = zipSync({
    [`${folder}${dxfName}`]: dxf,
    [`${folder}${annotationName}`]: annotationBytes,
    [`${folder}${manifestName}`]: manifestBytes,
  }, { level: 6 });
  return { archiveName: `${safeBase}.zip`, archive, files };
}

