import { exportDemoText } from "./platform/runtime";

export interface DemoProject {
  id: string;
  name: string;
  location: string;
  date: string;
  seconds: number;
  size: number;
  points: string;
  local: boolean;
  uploaded: boolean;
  kind: "studio" | "gallery" | "courtyard";
}

export const SEED_PROJECTS: DemoProject[] = [
  { id: "sample-studio", name: "光庭 · 工作室", location: "室内空间", date: "2026-09-09T09:42:00", seconds: 284, size: 328, points: "248.6 万", local: true, uploaded: false, kind: "studio" },
  { id: "sample-gallery", name: "留白 · 展览空间", location: "室内空间", date: "2026-09-08T15:20:00", seconds: 412, size: 516, points: "382.1 万", local: true, uploaded: true, kind: "gallery" },
  { id: "sample-courtyard", name: "山石 · 庭院", location: "室外场景", date: "2026-09-08T10:15:00", seconds: 193, size: 216, points: "186.4 万", local: false, uploaded: false, kind: "courtyard" },
];
export const RECORD_KEY = "point-view-handheld-demo-v1";
export const formatDuration = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
export const formatDate = (date: string) => new Date(date).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }).replaceAll("/", ".");

export function readDemoProjects(): DemoProject[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECORD_KEY) ?? "null");
    if (Array.isArray(saved) && saved.every(p => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.seconds === "number" && typeof p.date === "string" && typeof p.size === "number" && typeof p.local === "boolean" && typeof p.uploaded === "boolean" && typeof p.points === "string" && typeof p.location === "string" && ["studio", "gallery", "courtyard"].includes(p.kind))) return saved;
  } catch { /* 禁用存储或旧数据损坏时仍可进入演示。 */ }
  return SEED_PROJECTS.map(p => ({ ...p }));
}

/** 导出带演示标记的文件，仅描述前端示例，完全不访问设备。 */
export function downloadDemo(name: string, content: string, type = "application/json") {
  return exportDemoText(name, content, type);
}

export function demoDxf(height: number, thickness: number) {
  const lines = ["0", "SECTION", "2", "HEADER", "999", `DEMO ONLY - synthetic floor plan; slice=${height}m thickness=${thickness}m`, "9", "$INSUNITS", "70", "6", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  for (const [x1, y1, x2, y2] of [[-5, -3, 5, -3], [5, -3, 5, 3], [5, 3, -5, 3], [-5, 3, -5, -3], [1, -3, 1, 0], [1, 1, 1, 3]]) {
    lines.push("0", "LINE", "8", "DEMO_PLAN", "10", `${x1}`, "20", `${y1}`, "30", "0", "11", `${x2}`, "21", `${y2}`, "31", "0");
  }
  return [...lines, "0", "ENDSEC", "0", "EOF", ""].join("\n");
}
