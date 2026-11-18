export interface DeviceProfile {
  id: string; label: string; width: number; height: number;
  insets: { top: number; right: number; bottom: number; left: number };
}

// CSS 逻辑视口的代表性档位，可手动调整；不是厂商硬件参数或认证机型。
export const DEVICE_PROFILES: DeviceProfile[] = [
  { id: "compact", label: "紧凑安卓 · 320", width: 320, height: 640, insets: { top: 24, right: 0, bottom: 24, left: 0 } },
  { id: "galaxy", label: "Galaxy 类 · 360", width: 360, height: 780, insets: { top: 28, right: 0, bottom: 24, left: 0 } },
  { id: "pixel", label: "Pixel 类 · 393", width: 393, height: 851, insets: { top: 32, right: 0, bottom: 24, left: 0 } },
  { id: "large", label: "小米 / OPPO 类 · 412", width: 412, height: 915, insets: { top: 32, right: 0, bottom: 24, left: 0 } },
  { id: "fold-cover", label: "折叠屏外屏 · 344", width: 344, height: 882, insets: { top: 28, right: 0, bottom: 24, left: 0 } },
  { id: "fold-open", label: "折叠屏展开 · 768", width: 768, height: 884, insets: { top: 28, right: 0, bottom: 24, left: 0 } },
  { id: "tablet", label: "安卓平板 · 800", width: 800, height: 1280, insets: { top: 24, right: 0, bottom: 24, left: 0 } },
];
