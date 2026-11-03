import type { SourceInput } from "./source";

export const MAX_PAIRED_BYTES = 16 * 1024 ** 2;
export interface PairedCamera {
  model: "opencv_rational8"; width: number; height: number;
  intrinsics: number[]; distortion: number[];
}
export interface PairedWall { id: string; axisM: [[number, number], [number, number]]; bottomM: number; topM: number }
export interface PairedCandidate {
  id: string; label: "door" | "window"; score: number; box: [number, number, number, number];
  wallId?: string; wallSupportPoints: number; wallSupportFraction: number;
  envelope?: { u: [number, number]; z: [number, number] };
  decision: "pending" | "retain" | "reject"; reviewedLabel?: "door" | "window"; note: string;
}
export interface PairedFrame {
  id: string; name: string; stampNs: string; sha256: string; image: string;
  /** 行优先、光学坐标 x 右 y 下 z 前，平移单位米。 */
  cameraId?: "front" | "left" | "right"; camera?: PairedCamera;
  inference?: { engine: "onnxruntime-web"; version: string; modelSha256: string; preprocessing: string; supportPolicy: string; inputSourcePoints: number };
  TWorldCamera: number[]; analyzed: boolean; candidates: PairedCandidate[];
}
export interface PairedReview {
  schema: "survey-paired-review/1"; session: string;
  sourceSha256: string; frameId: "camera_init"; poseSpace: "raw"; units: "m";
  alignmentVerified: boolean; captureQuality: "partial" | "verified";
  model: { id: string; revision: string }; camera: PairedCamera;
  walls: PairedWall[]; frames: PairedFrame[];
}
export interface PairedFocus { camera: PairedCamera; frame: PairedFrame; candidate?: PairedCandidate; wall?: PairedWall }
export type PairedFrameReference = Omit<PairedFrame, "image"> & {pageId:string; session:string; sourceSha256:string; model:PairedReview["model"];captureQuality:PairedReview["captureQuality"];alignmentVerified:boolean};
const vector = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const sha = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const pair = (v: unknown) => vector(v, 2) && v[0]! < v[1]!;
export function assertPairedReview(v: any): asserts v is PairedReview {
  const fail = () => { throw Error("关键帧附件格式无效，未替换当前工程。"); };
  if (!v || JSON.stringify(v).length > MAX_PAIRED_BYTES || v.schema !== "survey-paired-review/1" || !sha(v.sourceSha256) || typeof v.session !== "string" || v.units !== "m" || v.frameId !== "camera_init" || v.poseSpace !== "raw" || typeof v.alignmentVerified !== "boolean" || !["partial", "verified"].includes(v.captureQuality) || typeof v.model?.id !== "string" || typeof v.model?.revision !== "string") fail();
  const validCamera = (c: any) => c?.model === "opencv_rational8" && Number.isSafeInteger(c.width) && Number.isSafeInteger(c.height) && c.width > 0 && c.height > 0 && c.width <= 8192 && c.height <= 8192 && vector(c.intrinsics, 4) && c.intrinsics[0] > 0 && c.intrinsics[1] > 0 && vector(c.distortion, 8);
  if (!validCamera(v.camera)) fail();
  if (!Array.isArray(v.walls) || v.walls.length > 500 || !Array.isArray(v.frames) || !v.frames.length || v.frames.length > 60) fail();
  const walls = new Set<string>(), ids = new Set<string>();
  for (const w of v.walls) {
    if (typeof w.id !== "string" || walls.has(w.id) || !Array.isArray(w.axisM) || w.axisM.length !== 2 || !w.axisM.every((p: unknown) => vector(p, 2)) || Math.hypot(w.axisM[1][0] - w.axisM[0][0], w.axisM[1][1] - w.axisM[0][1]) < .001 || !pair([w.bottomM, w.topM])) fail();
    walls.add(w.id);
  }
  for (const f of v.frames) {
    if (![undefined, "front", "left", "right"].includes(f.cameraId) || (f.camera !== undefined && !validCamera(f.camera)) || (["left", "right"].includes(f.cameraId) && !f.camera)) fail();
    const c = f.camera ?? v.camera;
    if(f.inference && (f.inference.engine!=="onnxruntime-web" || !sha(f.inference.modelSha256) || ![f.inference.version,f.inference.preprocessing,f.inference.supportPolicy].every(x=>typeof x==='string') || !Number.isSafeInteger(f.inference.inputSourcePoints) || f.inference.inputSourcePoints<1)) fail();
    if (typeof f.id !== "string" || ids.has(f.id) || typeof f.name !== "string" || typeof f.stampNs !== "string" || typeof f.analyzed !== "boolean" || !sha(f.sha256) || typeof f.image !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(f.image) || !vector(f.TWorldCamera, 16) || !Array.isArray(f.candidates) || f.candidates.length > 100) fail();
    ids.add(f.id);
    const t = f.TWorldCamera;
    if (t[12] !== 0 || t[13] !== 0 || t[14] !== 0 || t[15] !== 1) fail();
    // 禁止把缩放矩阵或反射当相机刚体位姿使用。
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const dot = t[i] * t[j] + t[4 + i] * t[4 + j] + t[8 + i] * t[8 + j];
      if (Math.abs(dot - (i === j ? 1 : 0)) > .002) fail();
    }
    const det = t[0]*(t[5]*t[10]-t[6]*t[9])-t[1]*(t[4]*t[10]-t[6]*t[8])+t[2]*(t[4]*t[9]-t[5]*t[8]);
    if (Math.abs(det - 1) > .002) fail();
    for (const a of f.candidates) {
      if (typeof a.id !== "string" || ids.has(a.id) || !["door", "window"].includes(a.label) || ![undefined, "door", "window"].includes(a.reviewedLabel) || !Number.isFinite(a.score) || a.score < 0 || a.score > 1 || !vector(a.box, 4) || a.box[0] < 0 || a.box[1] < 0 || a.box[2] > c.width || a.box[3] > c.height || a.box[0] >= a.box[2] || a.box[1] >= a.box[3] || !["pending", "retain", "reject"].includes(a.decision) || typeof a.note !== "string" || a.note.length > 2000 || !Number.isSafeInteger(a.wallSupportPoints) || a.wallSupportPoints < 0 || !Number.isFinite(a.wallSupportFraction) || a.wallSupportFraction < 0 || a.wallSupportFraction > 1 || (a.wallId !== undefined && !walls.has(a.wallId)) || (a.envelope && (!a.wallId || !pair(a.envelope.u) || !pair(a.envelope.z)))) fail();
      ids.add(a.id);
    }
  }
}
export function cameraForFrame(review: PairedReview, frame: PairedFrame): PairedCamera {
  return frame.camera ?? review.camera;
}
export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function verifyPairedReview(review: PairedReview, source: SourceInput & { units: string; synthetic: boolean }) {
  assertPairedReview(review);
  if (source.units !== "m" || source.synthetic) throw Error("关键帧只关联原始米制实测点云。");
  const bytes = source.bytes ?? (source.native ? undefined : await source.file?.arrayBuffer());
  const hash = source.native?.sha256 ?? (bytes ? await sha256(bytes) : undefined);
  if (hash !== review.sourceSha256) throw Error("关键帧与当前点云 SHA256 不匹配，未替换当前工程。");
  for (const f of review.frames) {
    const raw = Uint8Array.from(atob(f.image.slice("data:image/jpeg;base64,".length)), c => c.charCodeAt(0));
    if (raw[0] !== 255 || raw[1] !== 216 || raw[2] !== 255 || await sha256(raw.buffer) !== f.sha256) throw Error(`原图校验失败：${f.name}`);
  }
}
/** 原始畸变图投影；不能用普通针孔模型套在原 JPEG 上。 */
export function projectPairedPoint(p: readonly number[], focus: PairedFocus): [number, number, number] | undefined {
  const t = focus.frame.TWorldCamera, dx = p[0]! - t[3]!, dy = p[1]! - t[7]!, dz = p[2]! - t[11]!;
  const z = t[2]!*dx + t[6]!*dy + t[10]!*dz;
  if (z <= .05) return;
  const x = (t[0]!*dx+t[4]!*dy+t[8]!*dz)/z, y = (t[1]!*dx+t[5]!*dy+t[9]!*dz)/z;
  const r2 = x*x+y*y, r4 = r2*r2, r6 = r4*r2, [k1,k2,p1,p2,k3,k4,k5,k6] = focus.camera.distortion as [number,number,number,number,number,number,number,number];
  const denominator = 1+k4*r2+k5*r4+k6*r6;
  if (Math.abs(denominator) < 1e-8) return;
  const radial = (1+k1*r2+k2*r4+k3*r6)/denominator, [fx,fy,cx,cy] = focus.camera.intrinsics as [number,number,number,number];
  const u = fx*(x*radial+2*p1*x*y+p2*(r2+2*x*x))+cx, v = fy*(y*radial+p1*(r2+2*y*y)+2*p2*x*y)+cy;
  return Number.isFinite(u) && Number.isFinite(v) ? [u,v,z] : undefined;
}
export function candidateContainsPoint(p: readonly number[], focus: PairedFocus): boolean {
  const { candidate: a, wall: w } = focus;
  if (!a || !w || !a.envelope) return false;
  const uv = projectPairedPoint(p, focus), b = a.box;
  if (!uv || uv[0] < b[0] || uv[0] > b[2] || uv[1] < b[1] || uv[1] > b[3]) return false;
  const dx = w.axisM[1][0]-w.axisM[0][0], dy = w.axisM[1][1]-w.axisM[0][1], length = Math.hypot(dx,dy);
  const x = p[0]!-w.axisM[0][0], y = p[1]!-w.axisM[0][1], u = (x*dx+y*dy)/length;
  return Math.abs(x*dy-y*dx)/length <= .15 && u >= a.envelope.u[0] && u <= a.envelope.u[1] && p[2]! >= a.envelope.z[0] && p[2]! <= a.envelope.z[1];
}
export function supportOutline({candidate: a, wall: w}: PairedFocus): number[][] {
  if (!a?.envelope || !w) return [];
  const dx=w.axisM[1][0]-w.axisM[0][0],dy=w.axisM[1][1]-w.axisM[0][1],length=Math.hypot(dx,dy), {u,z}=a.envelope;
  return [[u[0],z[0]],[u[1],z[0]],[u[1],z[1]],[u[0],z[1]],[u[0],z[0]]].map(([offset,height])=>[w.axisM[0][0]+dx/length*offset!,w.axisM[0][1]+dy/length*offset!,height!]);
}
