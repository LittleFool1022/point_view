export type ColorMode = "rgb" | "height" | "intensity" | "distance" | "solid";

/** omni 显示端默认使用 PointCloud2 自带的 RGB/RGBA 真彩颜色。 */
export const DEFAULT_COLOR_MODE: ColorMode = "rgb";

export const CAMERA_DIRECTIONS = ["front", "left", "right"] as const;
export type CameraDirection = typeof CAMERA_DIRECTIONS[number];
export const POINT_CLOUD_STREAMS = ["merged", ...CAMERA_DIRECTIONS] as const;
export type PointCloudStream = typeof POINT_CLOUD_STREAMS[number];

export const CAMERA_DIRECTION_LABELS: Record<CameraDirection, string> = {
  front: "前",
  left: "左",
  right: "右",
};

export const POINT_CLOUD_STREAM_LABELS: Record<PointCloudStream, string> = {
  merged: "三目精确",
  front: "前视诊断",
  left: "左视诊断",
  right: "右视诊断",
};

export type CameraTopics = Record<CameraDirection, string>;

export interface PointCloudData {
  id: string;
  frameId: string;
  stampNs: bigint;
  /** 手机扫描累计快照；仅供显示，不作为设备完整地图或编辑数据。 */
  scanPreview?: {
    token: string;
    displayColors: Uint8Array;
    center: [number, number, number];
    radius: number;
    voxelSize: number;
    interactionCount: number;
  };
  /** 导入文件的原始点数；移动端可能按预算均匀采样。 */
  sourcePointCount?: number;
  /** 内存点到原文件点号的映射；对象提取与编辑重放使用。 */
  sourcePointIndices?: Uint32Array;
  /** 原始载荷中真实存在的属性；避免把渲染默认色误判为有效 RGB。 */
  attributes?: {
    hasColor: boolean;
    hasIntensity: boolean;
    frameIdDeclared?: boolean;
    timestampDeclared?: boolean;
  };
  positions: Float32Array;
  colors: Uint8Array;
  intensities?: Float32Array;
  visible: Uint8Array;
}

export interface DeviceProfile {
  id: string;
  name: string;
  wsUrl: string;
  /** 合并点云与独立点云互斥；独立前、左、右可多选。 */
  pointCloudSelection?: PointCloudStream[];
  topics: {
    /** 旧项目和 MCAP 导入使用的单路点云主题。 */
    pointCloud: string;
    /** Orange Pi 设备端经过严格同步、遮挡过滤和去重的三目精确彩色点云。 */
    mergedPointCloud?: string;
    /** omni 前、左、右三路相机着色点云，均须位于同一坐标系。 */
    pointClouds?: Partial<CameraTopics>;
    /** omni 三目显示主题；旧项目可能没有该字段。 */
    images?: Partial<CameraTopics>;
    /** 兼容旧 Handbot2 项目存档中的单相机字段。 */
    image?: string;
    odometry: string;
    path: string;
    gnss: string;
    rtkStatus?: string;
    syncStatus?: string;
  };
  frames: { world: string };
}

export interface GeoPosition {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy?: number;
  fix: "none" | "single" | "float" | "fixed";
}

export interface EditOperation {
  id: string;
  kind: "hide" | "restore" | "transform" | "color-gain" | "classify";
  indices: number[];
  createdAt: string;
  payload?: {
    matrix?: number[];
    gain?: [number, number, number];
    classification?: number;
  };
}

export interface ProjectManifest {
  formatVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deviceProfile: DeviceProfile;
  crs: string;
  origin?: GeoPosition;
  sourceFiles: string[];
  edits: EditOperation[];
}

export const DEFAULT_DEVICE_PROFILE: DeviceProfile = {
  id: "omni-mid360s-tricamera",
  name: "omni MID360S 三目显示",
  wsUrl: "ws://10.42.0.1:8765",
  pointCloudSelection: ["merged"],
  topics: {
    pointCloud: "/cloud_registered",
    mergedPointCloud: "/cloud_registered/tri_precise",
    pointClouds: {
      front: "/cloud_registered/front",
      left: "/cloud_registered/left",
      right: "/cloud_registered/right",
    },
    images: {
      front: "/omni/camera/front/image/compressed",
      left: "/omni/camera/left/image/compressed",
      right: "/omni/camera/right/image/compressed",
    },
    odometry: "/aft_mapped_to_init",
    path: "/path",
    gnss: "",
    syncStatus: "/omni/sync/status",
  },
  frames: { world: "camera_init" },
};

/**
 * 按“前、左、右”的固定顺序返回有效相机主题。
 * 旧项目只有 topics.image 时，将其视作前相机，保证历史存档仍可打开。
 */
export function cameraTopicEntries(profile: DeviceProfile): Array<[CameraDirection, string]> {
  const entries = CAMERA_DIRECTIONS.flatMap((direction) => {
    const topic = profile.topics.images?.[direction]?.trim();
    return topic ? [[direction, topic] as [CameraDirection, string]] : [];
  });
  if (entries.length > 0) return entries;
  const legacyTopic = profile.topics.image?.trim();
  return legacyTopic ? [["front", legacyTopic]] : [];
}

/**
 * 优先返回前、左、右三路着色点云；旧项目没有 pointClouds 时回退到单路点云。
 */
export function pointCloudTopicEntries(profile: DeviceProfile): Array<[PointCloudStream, string]> {
  if (profile.pointCloudSelection !== undefined) {
    return profile.pointCloudSelection.flatMap((stream) => {
      const topic = stream === "merged"
        ? profile.topics.mergedPointCloud?.trim()
        : profile.topics.pointClouds?.[stream]?.trim();
      return topic ? [[stream, topic] as [PointCloudStream, string]] : [];
    });
  }
  const mergedTopic = profile.topics.mergedPointCloud?.trim();
  if (mergedTopic) return [["merged", mergedTopic]];
  const entries = CAMERA_DIRECTIONS.flatMap((direction) => {
    const topic = profile.topics.pointClouds?.[direction]?.trim();
    return topic ? [[direction, topic] as [PointCloudStream, string]] : [];
  });
  if (entries.length > 0) return entries;
  const legacyTopic = profile.topics.pointCloud.trim();
  return legacyTopic ? [["front", legacyTopic]] : [];
}

export function pointCount(cloud: PointCloudData): number {
  return cloud.positions.length / 3;
}
