/// <reference lib="webworker" />
import { decodeRosImage, type RosRawImage } from "../domain/rosImage";

interface ImageDecodeRequest extends RosRawImage {
  streamId: string;
}

self.onmessage = async (event: MessageEvent<ImageDecodeRequest>) => {
  try {
    const rgba = decodeRosImage(event.data);
    const canvas = new OffscreenCanvas(event.data.width, event.data.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建相机图像画布");
    context.putImageData(new ImageData(rgba, event.data.width, event.data.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    self.postMessage({ streamId: event.data.streamId, blob });
  } catch (error) {
    self.postMessage({
      streamId: event.data.streamId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
