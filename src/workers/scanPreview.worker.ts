/// <reference lib="webworker" />
import { ScanPreviewAccumulator, SCAN_SNAPSHOT_MS, type ScanWorkerInput, type ScanWorkerOutput } from "../handheld/scanner/ScanPreviewAccumulator";

let token = "";
let accumulator = new ScanPreviewAccumulator();
let outstanding = false, dirty = false;
let lastSent = -Infinity;
let timer: ReturnType<typeof setTimeout> | undefined;
const send = (message: ScanWorkerOutput, transfer: Transferable[] = []) => self.postMessage(message, transfer);

function publish() {
  if (!dirty || outstanding || timer) return;
  const delay = Math.max(0, SCAN_SNAPSHOT_MS - (performance.now() - lastSent));
  timer = setTimeout(() => {
    timer = undefined;
    const cloud = accumulator.snapshot(token);
    dirty = false;
    if (!cloud) return;
    outstanding = true;
    lastSent = performance.now();
    // 展示快照与体素表互不共享内存，transfer 不会破坏后续累计。
    send({ type: "snapshot", token, cloud }, [cloud.positions.buffer, cloud.colors.buffer, cloud.visible.buffer,
      cloud.intensities!.buffer, cloud.scanPreview!.displayColors.buffer]);
  }, delay);
}

self.onmessage = ({ data }: MessageEvent<ScanWorkerInput>) => {
  if (data.type === "reset") {
    clearTimeout(timer); timer = undefined;
    token = data.token;
    accumulator = new ScanPreviewAccumulator();
    outstanding = false; dirty = false; lastSent = -Infinity;
    return;
  }
  if (data.token !== token) return;
  if (data.type === "ack") outstanding = false;
  else {
    accumulator.add(data.cloud);
    dirty = true;
    send({ type: "consumed", token });
  }
  publish();
};
