/// <reference lib="webworker" />
import { analyzeStaticPointCloud } from "../quality/analyze";
import type { PointCloudData } from "../domain/types";

interface StaticPcdRequest {
  requestId: number;
  fileName: string;
  cloud: PointCloudData;
}

self.onmessage = (event: MessageEvent<StaticPcdRequest>) => {
  const { requestId, fileName, cloud } = event.data;
  try {
    const evidence = analyzeStaticPointCloud(cloud, fileName);
    self.postMessage({ requestId, evidence });
  } catch (error) {
    self.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) });
  }
};
