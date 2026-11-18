/// <reference lib="webworker" />
import { decodePointCloud2, type RosPointCloud2 } from "../domain/pointCloud2";
import type { PointCloudStream } from "../domain/types";
import type { Channel } from "@foxglove/ws-protocol";
import { parse } from "@foxglove/rosmsg";
import { MessageReader as Ros1Reader } from "@foxglove/rosmsg-serialization";
import { MessageReader as Ros2Reader } from "@foxglove/rosmsg2-serialization";

type Input = { streamId: PointCloudStream } & (
  | { type: "register"; channel: Channel }
  | { type: "raw"; channelId: number; data: Uint8Array }
  | { type?: undefined; message: RosPointCloud2 }
);
const readers = new Map<number, { readMessage<T>(data: ArrayBufferView): T }>();

self.onmessage = (event: MessageEvent<Input>) => {
  try {
    const input = event.data;
    if (input.type === "register") {
      const channel = input.channel;
      const ros2 = channel.schemaEncoding === "ros2msg" || channel.encoding === "cdr";
      const definitions = parse(channel.schema, { ros2 });
      readers.set(channel.id, ros2 ? new Ros2Reader(definitions) : new Ros1Reader(definitions));
      return;
    }
    const message = input.type === "raw" ? readers.get(input.channelId)?.readMessage<RosPointCloud2>(input.data) : input.message;
    if (!message) throw new Error("点云消息定义未就绪");
    const cloud = decodePointCloud2(message);
    self.postMessage({ streamId: event.data.streamId, cloud }, [cloud.positions.buffer, cloud.colors.buffer, cloud.visible.buffer, ...(cloud.intensities ? [cloud.intensities.buffer] : [])]);
  } catch (error) {
    self.postMessage({ streamId: event.data.streamId, error: error instanceof Error ? error.message : String(error) });
  }
};
