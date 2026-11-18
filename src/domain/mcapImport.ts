import { McapIndexedReader, TempBuffer } from "@mcap/core";
import { parse } from "@foxglove/rosmsg";
import { MessageReader as Ros1Reader } from "@foxglove/rosmsg-serialization";
import { MessageReader as Ros2Reader } from "@foxglove/rosmsg2-serialization";
import { decodePointCloud2, type RosPointCloud2 } from "./pointCloud2";
import type { PointCloudData } from "./types";

export async function loadMcapPointCloud(buffer: ArrayBuffer, preferredTopic = "/cloud_registered"): Promise<PointCloudData> {
  const reader = await McapIndexedReader.Initialize({ readable: new TempBuffer(buffer) });
  const channels = [...reader.channelsById.values()];
  const selected = channels.find((channel) => channel.topic === preferredTopic)
    ?? channels.find((channel) => reader.schemasById.get(channel.schemaId)?.name.includes("PointCloud2"))
    ?? channels.find((channel) => reader.schemasById.get(channel.schemaId)?.name === "point_view/PointCloudSnapshot");
  if (!selected) throw new Error("MCAP 中未找到 PointCloud2 或 Point View 点云快照");
  const schema = reader.schemasById.get(selected.schemaId);
  if (!schema) throw new Error(`MCAP 通道 ${selected.topic} 缺少 schema`);
  let latest: PointCloudData | undefined;
  const schemaText = new TextDecoder().decode(schema.data);
  const isSnapshot = schema.name === "point_view/PointCloudSnapshot" && selected.messageEncoding === "json";
  const isRos2 = schema.encoding === "ros2msg" || selected.messageEncoding === "cdr";
  const definitions = isSnapshot ? undefined : parse(schemaText, { ros2: isRos2 });
  const messageReader = definitions ? (isRos2 ? new Ros2Reader(definitions) : new Ros1Reader(definitions)) : undefined;
  for await (const message of reader.readMessages({ topics: [selected.topic] })) {
    if (isSnapshot) {
      const payload = JSON.parse(new TextDecoder().decode(message.data)) as { frameId: string; positions: number[]; colors: number[] };
      const count = payload.positions.length / 3;
      latest = { id: crypto.randomUUID(), frameId: payload.frameId, stampNs: message.publishTime, positions: Float32Array.from(payload.positions), colors: Uint8Array.from(payload.colors), visible: new Uint8Array(count).fill(1) };
    } else if (messageReader) {
      const decoded = messageReader.readMessage<RosPointCloud2>(message.data);
      latest = decodePointCloud2(decoded);
    }
  }
  if (!latest) throw new Error(`MCAP 通道 ${selected.topic} 没有消息`);
  return latest;
}
