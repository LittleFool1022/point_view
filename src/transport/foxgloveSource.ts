import { FoxgloveClient, type Channel } from "@foxglove/ws-protocol";
import { parse } from "@foxglove/rosmsg";
import { MessageReader as Ros1Reader } from "@foxglove/rosmsg-serialization";
import { MessageReader as Ros2Reader } from "@foxglove/rosmsg2-serialization";
import {
  cameraTopicEntries,
  pointCloudTopicEntries,
  type CameraDirection,
  type DeviceProfile,
  type GeoPosition,
  type PointCloudStream,
  type PointCloudData,
} from "../domain/types";
import type { RosPointCloud2 } from "../domain/pointCloud2";
import { detectEncodedImageMime } from "../domain/rosImage";

export type SourceState = "idle" | "connecting" | "connected" | "error";

export interface OdometrySample {
  timestamp: number;
  frameId: string;
  position: { x: number; y: number; z: number };
}

export interface FoxgloveSourceHandlers {
  onState(state: SourceState, detail?: string): void;
  onPointCloud(stream: PointCloudStream, cloud: PointCloudData): void;
  onImageUrl(direction: CameraDirection, url: string): void;
  onPosition(position: GeoPosition): void;
  onOdometry?(sample: OdometrySample): void;
  onSyncStatus(status: string): void;
  onChannels(channels: Channel[]): void;
  onRawChannel?(channel: Channel): void;
  onRawMessage?(channel: Channel, timestamp: bigint, data: Uint8Array): void;
}

type Reader = { readMessage<T>(data: ArrayBufferView): T };

export class FoxgloveSource {
  #profile: DeviceProfile;
  #handlers: FoxgloveSourceHandlers;
  #client?: FoxgloveClient;
  #readers = new Map<number, Reader>();
  #topics = new Map<number, string>();
  #subscriptions = new Map<number, number>();
  #channels = new Map<number, Channel>();
  #decoder?: Worker;
  #pointCloudBusy = new Set<PointCloudStream>();
  #imageDecoder?: Worker;
  #imageBusy = new Set<CameraDirection>();
  #imageUrls = new Map<CameraDirection, string>();
  #cameraByTopic: Map<string, CameraDirection>;
  #pointCloudByTopic: Map<string, PointCloudStream>;
  #activeCamera: CameraDirection;
  #connectionGeneration = 0;

  constructor(profile: DeviceProfile, handlers: FoxgloveSourceHandlers, activeCamera: CameraDirection = "front", private pointCloudWorkerDecode = false) {
    this.#profile = profile;
    this.#handlers = handlers;
    this.#activeCamera = activeCamera;
    this.#cameraByTopic = new Map(cameraTopicEntries(profile).map(([direction, topic]) => [topic, direction]));
    this.#pointCloudByTopic = new Map(pointCloudTopicEntries(profile).map(([direction, topic]) => [topic, direction]));
  }

  setActiveCamera(direction: CameraDirection) {
    if (direction === this.#activeCamera) return;
    this.#activeCamera = direction;
    // Foxglove Bridge 运行中更换 best-effort 图像订阅后可能不再转发新路帧；
    // 重建连接可保证只传当前相机，同时不让前一路积压帧污染切换结果。
    if (this.#client) this.connect();
    else this.#refreshSubscriptions();
  }

  connect() {
    this.disconnect();
    const generation = ++this.#connectionGeneration;
    this.#decoder = new Worker(new URL("../workers/pointCloud.worker.ts", import.meta.url), { type: "module" });
    this.#decoder.onmessage = (event: MessageEvent<{ streamId?: PointCloudStream; cloud?: PointCloudData; error?: string }>) => {
      if (generation !== this.#connectionGeneration) return;
      if (event.data.streamId) this.#pointCloudBusy.delete(event.data.streamId);
      if (event.data.streamId && event.data.cloud) this.#handlers.onPointCloud(event.data.streamId, event.data.cloud);
      if (event.data.error) this.#handlers.onState("error", event.data.error);
    };
    this.#imageDecoder = new Worker(new URL("../workers/image.worker.ts", import.meta.url), { type: "module" });
    this.#imageDecoder.onmessage = (event: MessageEvent<{ streamId?: CameraDirection; blob?: Blob; error?: string }>) => {
      const direction = event.data.streamId;
      if (direction) this.#imageBusy.delete(direction);
      if (event.data.error) this.#handlers.onState("error", event.data.error);
      if (!direction || !event.data.blob) return;
      const previous = this.#imageUrls.get(direction);
      if (previous) URL.revokeObjectURL(previous);
      const url = URL.createObjectURL(event.data.blob);
      this.#imageUrls.set(direction, url);
      this.#handlers.onImageUrl(direction, url);
    };
    this.#handlers.onState("connecting");
    const socket = new WebSocket(this.#profile.wsUrl, FoxgloveClient.SUPPORTED_SUBPROTOCOL);
    const client = new FoxgloveClient({ ws: socket });
    this.#client = client;
    client.on("open", () => generation === this.#connectionGeneration && this.#handlers.onState("connected"));
    client.on("error", (error) => generation === this.#connectionGeneration && this.#handlers.onState("error", error.message));
    client.on("close", () => generation === this.#connectionGeneration && this.#handlers.onState("idle", "连接已关闭"));
    client.on("advertise", (channels) => generation === this.#connectionGeneration && this.#advertise(channels));
    client.on("message", (event) => generation === this.#connectionGeneration && this.#handleMessage(event.subscriptionId, event.timestamp, event.data));
  }

  disconnect() {
    this.#connectionGeneration++;
    // 先退订，再发关闭握手；慢链路上关闭握手排队时不再继续生产预览流量。
    for (const subscriptionId of this.#subscriptions.keys()) {
      try { this.#client?.unsubscribe(subscriptionId); } catch { /* 已断开的连接仍需继续释放本地资源。 */ }
    }
    this.#client?.close();
    this.#client = undefined;
    this.#readers.clear();
    this.#topics.clear();
    this.#subscriptions.clear();
    this.#channels.clear();
    this.#decoder?.terminate();
    this.#decoder = undefined;
    this.#pointCloudBusy.clear();
    this.#imageDecoder?.terminate();
    this.#imageDecoder = undefined;
    this.#imageBusy.clear();
    this.#imageUrls.forEach((url) => URL.revokeObjectURL(url));
    this.#imageUrls.clear();
  }

  #advertise(channels: Channel[]) {
    this.#handlers.onChannels(channels);
    for (const channel of channels) {
      this.#channels.set(channel.id, channel);
      this.#handlers.onRawChannel?.(channel);
    }
    this.#refreshSubscriptions();
  }

  #wantedTopics(): Set<string> {
    const activeCameraTopic = [...this.#cameraByTopic.entries()]
      .find(([, direction]) => direction === this.#activeCamera)?.[0];
    return new Set([
      ...this.#pointCloudByTopic.keys(),
      this.#profile.topics.odometry,
      this.#profile.topics.gnss,
      this.#profile.topics.rtkStatus,
      this.#profile.topics.syncStatus,
      activeCameraTopic,
    ].filter((topic): topic is string => Boolean(topic)));
  }

  #refreshSubscriptions() {
    if (!this.#client) return;
    const wanted = this.#wantedTopics();
    for (const [subscriptionId, channelId] of [...this.#subscriptions]) {
      const topic = this.#channels.get(channelId)?.topic;
      if (topic && wanted.has(topic)) continue;
      this.#client.unsubscribe(subscriptionId);
      this.#subscriptions.delete(subscriptionId);
    }
    const subscribedChannelIds = new Set(this.#subscriptions.values());
    for (const channel of this.#channels.values()) {
      if (!wanted.has(channel.topic) || subscribedChannelIds.has(channel.id)) continue;
      try {
        const isRos2 = channel.schemaEncoding === "ros2msg" || channel.encoding === "cdr";
        const definitions = parse(channel.schema, { ros2: isRos2 });
        this.#readers.set(channel.id, isRos2 ? new Ros2Reader(definitions) : new Ros1Reader(definitions));
        this.#topics.set(channel.id, channel.topic);
        if (this.pointCloudWorkerDecode && this.#pointCloudByTopic.has(channel.topic)) {
          this.#decoder?.postMessage({ type: "register", channel, streamId: this.#pointCloudByTopic.get(channel.topic) });
        }
        const subscriptionId = this.#client?.subscribe(channel.id);
        if (subscriptionId !== undefined) {
          this.#subscriptions.set(subscriptionId, channel.id);
        }
      } catch (error) {
        this.#handlers.onState("error", `${channel.topic} schema 解析失败: ${String(error)}`);
      }
    }
  }

  #handleMessage(subscriptionId: number, timestamp: bigint, data: ArrayBufferView) {
    const channelId = this.#subscriptions.get(subscriptionId);
    const topic = channelId === undefined ? undefined : this.#topics.get(channelId);
    const reader = channelId === undefined ? undefined : this.#readers.get(channelId);
    if (!reader || !topic) return;
    const channel = channelId === undefined ? undefined : this.#channels.get(channelId);
    if (channel) this.#handlers.onRawMessage?.(channel, timestamp, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    try {
      if (this.pointCloudWorkerDecode && this.#pointCloudByTopic.has(topic) && channel) {
        const direction = this.#pointCloudByTopic.get(topic)!;
        if (this.#pointCloudBusy.has(direction)) return;
        // 扫描模式连 CDR 解析也放到 Worker；保留 raw hook 持有的原始 buffer。
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        this.#pointCloudBusy.add(direction);
        this.#decoder?.postMessage({ type: "raw", channelId: channel.id, streamId: direction, data: bytes }, [bytes.buffer]);
        return;
      }
      const message = reader.readMessage<Record<string, unknown>>(data);
      if (this.#pointCloudByTopic.has(topic)) {
        const direction = this.#pointCloudByTopic.get(topic)!;
        // Worker 尚未处理完本方向上一帧时丢弃旧实时帧，避免消息排队形成可见延迟。
        if (this.#pointCloudBusy.has(direction)) return;
        const pointCloud = message as unknown as RosPointCloud2;
        const bytes = pointCloud.data instanceof Uint8Array ? pointCloud.data.slice() : Uint8Array.from(pointCloud.data);
        pointCloud.data = bytes;
        this.#pointCloudBusy.add(direction);
        this.#decoder?.postMessage({ streamId: direction, message: pointCloud }, [bytes.buffer]);
      } else if (this.#cameraByTopic.has(topic)) {
        const direction = this.#cameraByTopic.get(topic)!;
        const payload = message.data;
        const bytes = payload instanceof Uint8Array ? payload.slice() : Uint8Array.from(payload as number[]);
        const embeddedMime = detectEncodedImageMime(bytes);
        if (!embeddedMime && typeof message.encoding === "string" && Number(message.width) > 0 && Number(message.height) > 0) {
          // 原始 1280x960 BGR8 帧较大；上一帧仍在编码时直接丢弃，避免 Android 内存堆积。
          if (this.#imageBusy.has(direction)) return;
          this.#imageBusy.add(direction);
          this.#imageDecoder?.postMessage({
            streamId: direction,
            width: Number(message.width),
            height: Number(message.height),
            step: Number(message.step),
            encoding: message.encoding,
            data: bytes,
          }, [bytes.buffer]);
        } else {
          const previous = this.#imageUrls.get(direction);
          if (previous) URL.revokeObjectURL(previous);
          const url = URL.createObjectURL(new Blob([bytes], { type: embeddedMime ?? String(message.format || "image/jpeg") }));
          this.#imageUrls.set(direction, url);
          this.#handlers.onImageUrl(direction, url);
        }
      } else if (topic === this.#profile.topics.odometry) {
        const header = message.header as { stamp?: { sec?: number; nanosec?: number; secs?: number; nsecs?: number }; frame_id?: string } | undefined;
        const pose = message.pose as { pose?: { position?: OdometrySample["position"] } } | undefined;
        if (header?.stamp && pose?.pose?.position) this.#handlers.onOdometry?.({
          timestamp: Number(header.stamp.sec ?? header.stamp.secs) + Number(header.stamp.nanosec ?? header.stamp.nsecs) / 1e9,
          frameId: header.frame_id ?? "",
          position: pose.pose.position,
        });
      } else if (topic === this.#profile.topics.gnss) {
        const status = message.status as { status?: number } | undefined;
        this.#handlers.onPosition({
          latitude: Number(message.latitude),
          longitude: Number(message.longitude),
          altitude: Number(message.altitude),
          accuracy: Array.isArray(message.position_covariance) ? Math.sqrt(Number(message.position_covariance[0])) : undefined,
          fix: (status?.status ?? -1) < 0 ? "none" : "single",
        });
      } else if (topic === this.#profile.topics.syncStatus) {
        const status = typeof message.data === "string" ? message.data : String(message.status ?? "unknown");
        this.#handlers.onSyncStatus(status);
      }
    } catch (error) {
      this.#handlers.onState("error", `${topic} 消息解析失败: ${String(error)}`);
    }
  }
}
