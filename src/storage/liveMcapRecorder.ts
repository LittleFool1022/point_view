import { McapWriter, TempBuffer } from "@mcap/core";
import type { Channel as FoxgloveChannel } from "@foxglove/ws-protocol";

export class LiveMcapRecorder {
  #target = new TempBuffer();
  #writer = new McapWriter({ writable: this.#target, useChunks: true, chunkSize: 4 * 1024 * 1024 });
  #channels = new Map<number, number>();
  #schemas = new Map<string, number>();
  #queue: Promise<void>;
  #sequence = 0;

  constructor() {
    this.#queue = this.#writer.start({ profile: "ros2", library: "point-view-web" });
  }

  addChannel(channel: FoxgloveChannel): void {
    this.#queue = this.#queue.then(async () => {
      const schemaKey = `${channel.schemaName}:${channel.schemaEncoding ?? ""}:${channel.schema}`;
      let schemaId = this.#schemas.get(schemaKey);
      if (schemaId === undefined) {
        schemaId = await this.#writer.registerSchema({
          name: channel.schemaName,
          encoding: channel.schemaEncoding || "ros2msg",
          data: new TextEncoder().encode(channel.schema),
        });
        this.#schemas.set(schemaKey, schemaId);
      }
      const mcapChannel = await this.#writer.registerChannel({
        topic: channel.topic,
        schemaId,
        messageEncoding: channel.encoding,
        metadata: new Map(),
      });
      this.#channels.set(channel.id, mcapChannel);
    });
  }

  addMessage(channel: FoxgloveChannel, timestamp: bigint, data: Uint8Array): void {
    const copy = data.slice();
    this.#queue = this.#queue.then(async () => {
      const channelId = this.#channels.get(channel.id);
      if (channelId === undefined) return;
      await this.#writer.addMessage({ channelId, data: copy, sequence: this.#sequence++, logTime: timestamp, publishTime: timestamp });
    });
  }

  async finish(): Promise<Uint8Array> {
    await this.#queue;
    await this.#writer.end();
    return this.#target.get();
  }
}
