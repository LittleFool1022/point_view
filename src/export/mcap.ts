import { McapWriter, TempBuffer } from "@mcap/core";
import type { PointCloudData } from "../domain/types";

/** 快照 MCAP 使用公开的 JSON schema；实时原始录制将在设备侧保留原 ROS schema。 */
export async function exportPointCloudMcap(cloud: PointCloudData): Promise<Uint8Array> {
  const target = new TempBuffer();
  const writer = new McapWriter({ writable: target, useChunks: true, chunkSize: 4 * 1024 * 1024 });
  await writer.start({ profile: "point-view", library: "point-view-web" });
  const schemaId = await writer.registerSchema({
    name: "point_view/PointCloudSnapshot",
    encoding: "jsonschema",
    data: new TextEncoder().encode(JSON.stringify({
      type: "object",
      properties: {
        frameId: { type: "string" },
        positions: { type: "array", items: { type: "number" } },
        colors: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } },
      },
      required: ["frameId", "positions", "colors"],
    })),
  });
  const channelId = await writer.registerChannel({
    topic: "/point_view/edited_cloud",
    schemaId,
    messageEncoding: "json",
    metadata: new Map([["source_frame", cloud.frameId]]),
  });
  const visible: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < cloud.visible.length; i++) {
    if (!cloud.visible[i]) continue;
    visible.push(cloud.positions[i * 3]!, cloud.positions[i * 3 + 1]!, cloud.positions[i * 3 + 2]!);
    colors.push(cloud.colors[i * 3]!, cloud.colors[i * 3 + 1]!, cloud.colors[i * 3 + 2]!);
  }
  const data = new TextEncoder().encode(JSON.stringify({ frameId: cloud.frameId, positions: visible, colors }));
  const now = cloud.stampNs || BigInt(Date.now()) * 1_000_000n;
  await writer.addMessage({ channelId, data, sequence: 0, logTime: now, publishTime: now });
  await writer.end();
  return target.get();
}
