import { afterEach, describe, expect, it, vi } from "vitest";
import type { FoxgloveSourceHandlers } from "../../transport/foxgloveSource";
import type { PointCloudData } from "../../domain/types";
import { DEFAULT_PREVIEW_CONFIG, OmniPreviewSession, limitPreviewCloud, previewFreshness } from "./OmniPreviewSession";
import type { ScanWorkerInput, ScanWorkerOutput } from "./ScanPreviewAccumulator";

function frame(count = 1): PointCloudData {
  return { id: "fixture", frameId: "camera_init", stampNs: 1n,
    positions: new Float32Array(count * 3), colors: new Uint8Array(count * 3),
    visible: new Uint8Array(count).fill(1), intensities: new Float32Array(count) };
}
function harness() {
  const connections: { handlers: FoxgloveSourceHandlers; close: ReturnType<typeof vi.fn> }[] = [];
  const session = new OmniPreviewSession((_config, handlers) => {
    const close = vi.fn(); connections.push({ handlers, close });
    return { connect: () => {}, disconnect: close };
  });
  return { session, connections };
}
afterEach(() => vi.useRealTimers());

describe("OMNI 预览会话", () => {
  it("同步创建 source 失败不计入已完成的频道重发现", () => {
    let fail = false;
    const session = new OmniPreviewSession(() => {
      if (fail) throw new Error("fixture constructor failed");
      return { connect() {}, disconnect() {} };
    });
    session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "A", true);
    session.connect(DEFAULT_PREVIEW_CONFIG);
    fail = true;
    expect(session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "B", true).sourceReconnected).toBe(false);
    expect(session.getSnapshot().connection).toBe("error");
    expect(session.rediscoverPreview()).toBe(false);
    session.dispose();
  });

  it("仅预览重发现保留点云并隔离旧连接，身份结果只报告实际重连", () => {
    const { session, connections } = harness();
    expect(session.rediscoverPreview()).toBe(false);
    session.connect(DEFAULT_PREVIEW_CONFIG);
    const previous = connections[0].handlers;
    previous.onState("connected");
    previous.onPointCloud("merged", frame());
    const cloud = session.getSnapshot().cloud;
    const generation = session.getConnectionGeneration();
    expect(session.rediscoverPreview()).toBe(true);
    expect(session.getConnectionGeneration()).toBeGreaterThan(generation);
    expect(session.getSnapshot().cloud).toBe(cloud);
    previous.onPointCloud("merged", frame(3));
    expect(session.getSnapshot().cloud).toBe(cloud);
    const changed = session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "new", true);
    // 第一次规范设备地址会先释放旧连接，不能把仅 release 算成重连。
    expect(changed.sourceReconnected).toBe(false);
    session.connect(DEFAULT_PREVIEW_CONFIG);
    expect(session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "next", true)).toEqual({
      sourceReconnected: true, connectionGeneration: session.getConnectionGeneration(),
    });
    expect(session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "next", true).sourceReconnected).toBe(false);
    session.dispose();
  });

  it("累计身份、quarantine、重连与迟到 Worker 消息互相隔离，输入为单槽", () => {
    const connections: FoxgloveSourceHandlers[] = [];
    const messages: ScanWorkerInput[] = [];
    const port = { postMessage: (message: ScanWorkerInput) => messages.push(message), terminate: vi.fn(),
      onmessage: null as ((event: MessageEvent<ScanWorkerOutput>) => void) | null, onerror: null };
    const session = new OmniPreviewSession((_config, handlers) => {
      connections.push(handlers); return { connect() {}, disconnect() {} };
    }, () => port as unknown as Worker);
    const emit = (data: ScanWorkerOutput) => port.onmessage!({ data } as MessageEvent<ScanWorkerOutput>);
    const cloud = () => ({ ...frame(), attributes: { frameIdDeclared: true, hasColor: true, hasIntensity: true } });
    const frames = () => messages.filter((m): m is Extract<ScanWorkerInput, { type: "frame" }> => m.type === "frame");
    session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "A", true);
    session.connect(DEFAULT_PREVIEW_CONFIG);
    connections.at(-1)!.onPointCloud("merged", cloud());
    const first = frames()[0];
    connections.at(-1)!.onPointCloud("merged", cloud());
    const latest = cloud(); latest.id = "latest";
    connections.at(-1)!.onPointCloud("merged", latest);
    expect(frames()).toHaveLength(1);
    emit({ type: "consumed", token: first.token });
    expect(frames().at(-1)!.cloud.id).toBe("latest");
    emit({ type: "snapshot", token: first.token, cloud: first.cloud });
    expect(session.getSnapshot().cloud).toBe(first.cloud);
    expect(messages.at(-1)!.type).toBe("ack");
    session.disconnect(); session.connect(DEFAULT_PREVIEW_CONFIG, "left");
    expect(session.getSnapshot().cloud).toBe(first.cloud);
    session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, null, false);
    const before = frames().length;
    connections.at(-1)!.onPointCloud("merged", cloud());
    expect(frames()).toHaveLength(before);
    expect(session.getSnapshot().cloud).toBe(first.cloud);
    session.beginScan(DEFAULT_PREVIEW_CONFIG.wsUrl, "A");
    session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "A", true);
    connections.at(-1)!.onPointCloud("merged", cloud());
    emit({ type: "snapshot", token: first.token, cloud: first.cloud });
    expect(session.getSnapshot().cloud).toBeNull();
    session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "B", true);
    session.rejectScanStart();
    session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "B", true);
    expect(session.getSnapshot().cloud).toBeNull();
    session.resumeConfirmedScan();
    session.setScanIdentity(DEFAULT_PREVIEW_CONFIG.wsUrl, "B", true);
    session.connect(DEFAULT_PREVIEW_CONFIG);
    connections.at(-1)!.onPointCloud("merged", { ...cloud(), attributes: undefined });
    expect(frames()).toHaveLength(before);
    connections.at(-1)!.onPointCloud("merged", cloud());
    expect(frames().at(-1)!.token).not.toBe(first.token);
    const tokenB = frames().at(-1)!.token;
    connections.at(-1)!.onPointCloud("merged", { ...cloud(), frameId: "new_frame" });
    expect(session.getSnapshot().cloud).toBeNull();
    connections.at(-1)!.onPointCloud("merged", { ...cloud(), frameId: "new_frame" });
    expect(frames().at(-1)!.token).not.toBe(tokenB);
    session.dispose();
    emit({ type: "snapshot", token: tokenB, cloud: first.cloud });
    expect(session.getSnapshot().cloud).toBeNull();
    expect(port.terminate).toHaveBeenCalledOnce();
  });

  it("速度只接收当前预览连接，断线与清空会话后不保留旧速度", () => {
    const { session, connections } = harness();
    session.connect(DEFAULT_PREVIEW_CONFIG);
    const odom = (timestamp: number, x: number) => ({ timestamp, frameId: "camera_init", position: { x, y: 0, z: 0 } });
    const old = connections[0].handlers;
    old.onOdometry?.(odom(1, 0));old.onOdometry?.(odom(1.5, 0.5));
    expect(session.getSnapshot().speed).toBe(1);
    session.connect(DEFAULT_PREVIEW_CONFIG);
    old.onOdometry?.(odom(2, 20));
    expect(session.getSnapshot().speed).toBeNull();
    const current = connections[1].handlers;
    current.onOdometry?.(odom(2, 0));current.onOdometry?.(odom(2.5, 1));
    expect(session.getSnapshot().speed).toBe(2);
    session.clearCloud();expect(session.getSnapshot().speedAt).toBeNull();
    current.onOdometry?.(odom(3, 0));current.onOdometry?.(odom(3.5, 1));
    session.disconnect();expect(session.getSnapshot().speed).toBeNull();
  });

  it("相机切换和主动断开后，旧连接的帧与关闭事件不污染新会话", () => {
    const { session, connections } = harness();
    session.connect(DEFAULT_PREVIEW_CONFIG);
    const old = connections[0];
    old.handlers.onState("connected");
    old.handlers.onImageUrl("front", "blob:old");
    session.connect(DEFAULT_PREVIEW_CONFIG, "left");
    expect(old.close).toHaveBeenCalledOnce();
    expect(session.getSnapshot().imageUrl).toBeUndefined();
    const current = connections[1];
    current.handlers.onState("connected");
    current.handlers.onImageUrl("left", "blob:new");
    old.handlers.onImageUrl("front", "blob:late");
    old.handlers.onPointCloud("merged", frame());
    old.handlers.onState("idle", "旧连接关闭");
    expect(session.getSnapshot()).toMatchObject({ connection: "connected", camera: "left", imageUrl: "blob:new", cloud: null });
    session.disconnect();
    current.handlers.onState("connected");
    expect(session.getSnapshot().connection).toBe("offline");
    expect(current.close).toHaveBeenCalledOnce();
  });

  it("无握手连接会超时并释放资源，迟到的握手不能把错误状态改回在线", () => {
    vi.useFakeTimers();
    const { session, connections } = harness();
    session.connect(DEFAULT_PREVIEW_CONFIG);
    vi.advanceTimersByTime(8001);
    expect(session.getSnapshot().connection).toBe("error");
    expect(connections[0].close).toHaveBeenCalledOnce();
    connections[0].handlers.onState("connected");
    expect(session.getSnapshot().connection).toBe("error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("握手不代表首帧就绪，相机持续收帧也不能掩盖点云过期", () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const { session, connections } = harness();
    session.connect(DEFAULT_PREVIEW_CONFIG);
    const { handlers } = connections[0];
    handlers.onState("connected");
    expect(previewFreshness(session.getSnapshot().cloudAt, true)).toBe("waiting");
    handlers.onPointCloud("merged", frame());
    expect(previewFreshness(session.getSnapshot().cloudAt, true)).toBe("live");
    vi.advanceTimersByTime(3500);
    handlers.onImageUrl("front", "blob:latest");
    expect(previewFreshness(session.getSnapshot().cloudAt, true)).toBe("stale");
    expect(previewFreshness(session.getSnapshot().imageAt, true)).toBe("live");
    const lastCloud = session.getSnapshot().cloud;
    session.disconnect();
    expect(session.getSnapshot().cloud).toBe(lastCloud);
    expect(previewFreshness(session.getSnapshot().imageAt, false)).toBe("stale");
  });

  it("大帧裁减保留点和颜色/强度/可见性对应关系，不改写源帧", () => {
    const cloud = frame(240_001);
    cloud.positions.set([3, 4, 5], 9);
    cloud.colors.set([11, 22, 33], 9);
    cloud.intensities![3] = 123;
    cloud.visible[3] = 0;
    const limited = limitPreviewCloud(cloud);
    expect(limited.positions.length / 3).toBeLessThanOrEqual(120_000);
    expect([...limited.positions.slice(3, 6)]).toEqual([3, 4, 5]);
    expect([...limited.colors.slice(3, 6)]).toEqual([11, 22, 33]);
    expect(limited.intensities![1]).toBe(123);
    expect(limited.visible[1]).toBe(0);
    expect(cloud.positions.length / 3).toBe(240_001);
  });
});
