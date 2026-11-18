import { LAZPerfLoader } from "@point-view/lazperf-loader";

export async function decodeLazMesh(buffer: ArrayBuffer) {
  return LAZPerfLoader.parse(buffer, { las: { fp64: false, skip: 1, colorDepth: 8 } });
}
