export interface RosRawImage {
  width: number;
  height: number;
  step: number;
  encoding: string;
  data: Uint8Array;
}

const CHANNELS: Record<string, number> = {
  bgr8: 3,
  rgb8: 3,
  bgra8: 4,
  rgba8: 4,
  mono8: 1,
};

/** 兼容部分相机驱动把 JPEG/PNG 字节塞入 sensor_msgs/Image.data 的非标准行为。 */
export function detectEncodedImageMime(data: Uint8Array): string | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return "image/png";
  return undefined;
}

/** 将 ROS sensor_msgs/Image 的常见交错格式转换为浏览器 ImageData 使用的 RGBA。 */
export function decodeRosImage(image: RosRawImage): Uint8ClampedArray {
  const encoding = image.encoding.toLowerCase();
  const channels = CHANNELS[encoding];
  if (!channels) throw new Error(`暂不支持 ROS 图像编码: ${image.encoding}`);
  if (image.width <= 0 || image.height <= 0) throw new Error("ROS 图像尺寸无效");
  if (image.step < image.width * channels) throw new Error("ROS 图像 step 小于有效行宽");
  if (image.data.byteLength < image.step * image.height) throw new Error("ROS 图像数据不完整");

  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const source = y * image.step + x * channels;
      const target = (y * image.width + x) * 4;
      if (encoding === "mono8") {
        rgba[target] = image.data[source]!;
        rgba[target + 1] = image.data[source]!;
        rgba[target + 2] = image.data[source]!;
      } else if (encoding === "bgr8" || encoding === "bgra8") {
        rgba[target] = image.data[source + 2]!;
        rgba[target + 1] = image.data[source + 1]!;
        rgba[target + 2] = image.data[source]!;
      } else {
        rgba[target] = image.data[source]!;
        rgba[target + 1] = image.data[source + 1]!;
        rgba[target + 2] = image.data[source + 2]!;
      }
      rgba[target + 3] = channels === 4 ? image.data[source + 3]! : 255;
    }
  }
  return rgba;
}
