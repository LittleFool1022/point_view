import { readFile } from "node:fs/promises";

export interface RealFixture {
  source: string;
  filename: string;
  bytes: number;
  sha256: string;
  points: number;
  pointStrideBytes: number;
  headerBytes: number;
}

export async function readRealFixture(path = "test-data/real-capture/manifest.json"): Promise<RealFixture> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") throw Error("真实数据基准清单无效。");
  if (!("source" in value) || typeof value.source !== "string" || !value.source
    || !("filename" in value) || typeof value.filename !== "string" || !value.filename
    || !("sha256" in value) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error("真实数据基准来源或 SHA256 无效。");
  if (!("bytes" in value) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || !("points" in value) || typeof value.points !== "number" || !Number.isSafeInteger(value.points) || value.points <= 0
    || !("pointStrideBytes" in value) || typeof value.pointStrideBytes !== "number" || !Number.isSafeInteger(value.pointStrideBytes) || value.pointStrideBytes <= 0
    || !("headerBytes" in value) || typeof value.headerBytes !== "number" || !Number.isSafeInteger(value.headerBytes) || value.headerBytes <= 0) throw Error("真实数据基准容量或点布局无效。");
  return {
    source: value.source,
    filename: value.filename,
    sha256: value.sha256,
    bytes: value.bytes,
    points: value.points,
    pointStrideBytes: value.pointStrideBytes,
    headerBytes: value.headerBytes,
  };
}

export function binaryPcdPointCount(bytes: ArrayBuffer | undefined): number {
  if (!bytes) throw Error("工程缺少实际 source.bytes，无法确定 binary PCD 点数。");
  const head = new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 32768)));
  let points: number | undefined, binary = false;
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.trim(), data = /^DATA[\t ]+(\S+)[\t ]*$/i.exec(line);
    if (data) { binary = data[1]!.toLowerCase() === "binary"; break; }
    const row = /^POINTS[\t ]+(\S+)[\t ]*$/i.exec(line); if (row) points = Number(row[1]);
  }
  if (!binary) throw Error("工程源数据不是受支持的 binary PCD，无法确定真实点数。");
  if (points === undefined || !Number.isSafeInteger(points) || points < 1) throw Error("binary PCD 缺少有效的 POINTS 正整数头。");
  return points;
}
