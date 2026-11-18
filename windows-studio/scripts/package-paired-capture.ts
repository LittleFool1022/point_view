/** 将已完成的同会话采集与分析制成桌面可直接打开的离线工程。 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { sha256, verifyPairedReview, type PairedReview } from "../src/domain/pairedReview";
import { encodeProject } from "../src/domain/project";
const [captureRoot, output, label = "桌上采集"] = process.argv.slice(2);
if (!captureRoot || !output) throw Error("用法：vite-node scripts/package-paired-capture.ts <实验目录> <输出目录>");
const root = path.resolve(captureRoot);
const readJson = async (file: string) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const capture = await readJson("capture/capture.json"), calibration = await readJson("capture/calibration.json"), analysis = await readJson("analysis/result.json");
if (capture.session !== analysis.session || capture.pcd_binding.sha256 !== analysis.pcd.sha256 || capture.pose_space !== "raw" || capture.frame_id !== "camera_init" || capture.units !== "m") throw Error("采集与分析的会话或坐标版本不一致。");
const bytes = Uint8Array.from(await readFile(capture.pcd_binding.local_path)).buffer;
if (await sha256(bytes) !== capture.pcd_binding.sha256) throw Error("PCD 原件哈希不符。");
const review: PairedReview = {
  schema: "survey-paired-review/1", session: capture.session, sourceSha256: capture.pcd_binding.sha256,
  frameId: "camera_init", poseSpace: "raw", units: "m", alignmentVerified: capture.alignment_verified === true,
  captureQuality: capture.quality_verified === true && capture.pcd_binding.control_job_state !== "warning" ? "verified" : "partial",
  model: { id: "nvidia/segformer-b0-finetuned-ade-512-512", revision: "489d5cd81a0b59fab9b7ea758d3548ebe99677da" },
  camera: calibration.cameras.front, walls: analysis.geometry.walls,
  frames: await Promise.all(capture.views.map(async (v: any, i: number) => {
    const full = path.resolve(root, "capture", v.path);
    if (!full.startsWith(path.join(root, "capture") + path.sep)) throw Error("原图路径越界。");
    const predicted = analysis.frames.find((f: any) => f.index === i);
    if (predicted && (predicted.image !== v.path || predicted.image_sha256 !== v.sha256)) throw Error("候选与原图关联不一致。");
    return { id: `frame-${i}`, name: path.basename(v.path), stampNs: v.stamp_ns, sha256: v.sha256,
      image: `data:image/jpeg;base64,${(await readFile(full)).toString("base64")}`,
      cameraId: v.camera ?? "front", camera: calibration.cameras[v.camera ?? "front"],
      TWorldCamera: v.T_world_camera.flat(), analyzed: !!predicted,
      candidates: (predicted?.candidates ?? []).map((a: any) => ({ id: a.id, label: a.label, score: a.score, box: a.box,
        wallId: a.best_wall ?? undefined, wallSupportPoints: a.wall_support_points, wallSupportFraction: a.wall_support_fraction,
        envelope: a.measured_support_envelope ? { u: a.measured_support_envelope.u_range_m, z: a.measured_support_envelope.z_range_m } : undefined,
        decision: "pending", note: "" })) };
  }))
};
const source = { name: capture.pcd_binding.fileName, bytes, units: "m" as const, synthetic: false };
await verifyPairedReview(review, source);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, `${label}-关键帧.pvframes`), JSON.stringify(review));
await writeFile(path.join(output, `${label}-联合复核.pvplan`), await encodeProject({ source, pairedReview: review, annotations: [], projection: "xy", settings: {} }));
console.log(JSON.stringify({ session: review.session, frames: review.frames.length, analyzed: review.frames.filter(f => f.analyzed).length, candidates: review.frames.reduce((n,f) => n+f.candidates.length,0), sourceSha256: review.sourceSha256, output }));
