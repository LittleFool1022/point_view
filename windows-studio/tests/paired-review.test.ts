import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { demoRoom } from "../src/domain/demo";
import { encodeProject, decodeProject } from "../src/domain/project";
import { cameraForFrame, assertPairedReview, verifyPairedReview, sha256, projectPairedPoint, candidateContainsPoint, type PairedReview } from "../src/domain/pairedReview";
const { SourceStore } = createRequire(import.meta.url)("../electron/source-store.cjs");
async function fixture() {
  const source = { name: "room.pcd", bytes: demoRoom(), units: "m" as const, synthetic: false };
  const image = await readFile(new URL("./fixtures/keyframe.jpg", import.meta.url));
  const review: PairedReview = { schema: "survey-paired-review/1", session: "same-capture", sourceSha256: await sha256(source.bytes), frameId: "camera_init", poseSpace: "raw", units: "m", alignmentVerified: false, captureQuality: "partial", model: { id: "test-model", revision: "fixed" }, camera: { model: "opencv_rational8", width: 100, height: 100, intrinsics: [100,100,50,50], distortion: [0,0,0,0,0,0,0,0] }, walls: [{ id: "wall", axisM: [[0,0],[4,0]], bottomM: 0, topM: 3 }], frames: [{ id: "frame", name: "keyframe.jpg", stampNs: "123", sha256: await sha256(Uint8Array.from(image).buffer), image: `data:image/jpeg;base64,${image.toString("base64")}`, TWorldCamera: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], analyzed: true, candidates: [{ id: "candidate", label: "window", score: .8, box: [65,40,85,60], wallId: "wall", wallSupportPoints: 20, wallSupportFraction: .8, envelope: {u:[.2,.8],z:[1,3]}, decision: "retain", reviewedLabel: "door", note: "底边被遮挡" }] }] };
  return { source, review };
}
describe("同次采集关键帧与可恢复复核", () => {
  it("验证原图与点云哈希，拒绝错误源件、损坏图片及非刚体位姿", async () => {
    const {source,review}=await fixture(); await verifyPairedReview(review,source);
    await expect(verifyPairedReview({...review,sourceSha256:"a".repeat(64)},source)).rejects.toThrow("不匹配");
    const changed=structuredClone(review);changed.frames[0]!.sha256="b".repeat(64);
    await expect(verifyPairedReview(changed,source)).rejects.toThrow("原图校验失败");
    changed.frames[0]!.TWorldCamera[0]=2;expect(()=>assertPairedReview(changed)).toThrow("格式无效");
  });
  it("按光学位姿和 rational8 畸变投影，并以墙带及可见包络筛选支持点", async () => {
    const {review}=await fixture(), focus={camera:review.camera,frame:review.frames[0]!,candidate:review.frames[0]!.candidates[0],wall:review.walls[0]};
    expect(projectPairedPoint([.5,0,2],focus)).toEqual([75,50,2]);
    expect(projectPairedPoint([.5,0,-2],focus)).toBeUndefined();
    expect(candidateContainsPoint([.5,0,2],focus)).toBe(true);
    expect(candidateContainsPoint([.5,.3,2],focus)).toBe(false);
    expect(candidateContainsPoint([2,0,2],focus)).toBe(false);
    focus.camera={...focus.camera,distortion:[.1,0,0,0,0,.05,0,0]};
    expect(projectPairedPoint([.5,0,2],focus)![0]).toBeCloseTo(50+25*(1+.1*.0625)/(1+.05*.0625),8);
  });
  it("ZIP 工程完整恢复原图、人工类别修正及备注，保持旧工程兼容", async () => {
    const {source,review}=await fixture(), state={source,pairedReview:review,annotations:[],projection:"xy" as const,settings:{}};
    const restored=await decodeProject((await encodeProject(state)).buffer as ArrayBuffer);
    expect(restored.pairedReview).toEqual(review);expect(restored.source.bytes).toEqual(source.bytes);
    const old=await decodeProject((await encodeProject({...state,pairedReview:undefined})).buffer as ArrayBuffer);expect(old.pairedReview).toBeUndefined();
  });
  it("Windows 流式工程保存附件与决策，源点云哈希保持一致", async () => {
    const {source,review}=await fixture(),folder=await mkdtemp(path.join(tmpdir(),"paired-native-")),store=new SourceStore();
    try {
      const input=path.join(folder,"source.pcd"), output=path.join(folder,"project.pvplan");await writeFile(input,Buffer.from(source.bytes));
      const native=await store.register(input);await store.saveProject(native.token,output,{source:{units:"m",synthetic:false},pairedReview:review,annotations:[],projection:"xy",settings:{}});
      const restored=await store.openProject(output);expect(restored.project.pairedReview).toEqual(review);
      await verifyPairedReview(restored.project.pairedReview,{name:source.name,native:restored.native,units:"m",synthetic:false});
    } finally {await store.close();await rm(folder,{recursive:true,force:true});}
  });
  it("三目逐帧采用独立内参与光学位姿，拒绝侧视缺少标定及越界候选", async () => {
    const {review}=await fixture(), front=review.frames[0]!;
    const side={...front,id:"left-frame",cameraId:"left" as const,camera:{...review.camera,width:200,intrinsics:[200,200,100,50]},candidates:[],TWorldCamera:[0,0,1,0,0,1,0,0,-1,0,0,0,0,0,0,1]};
    review.frames.push(side);assertPairedReview(review);
    expect(projectPairedPoint([2,0,-.5],{frame:side,camera:cameraForFrame(review,side)})).toEqual([150,50,2]);
    expect(projectPairedPoint([2,0,-.5],{frame:front,camera:cameraForFrame(review,front)})).toBeUndefined();
    delete (side as any).camera;expect(()=>assertPairedReview(review)).toThrow("格式无效");
    side.camera={...review.camera,width:50};(side as any).candidates=[{...front.candidates[0]!,id:"side-candidate"}];expect(()=>assertPairedReview(review)).toThrow("格式无效");
  });
  it("三目图像身份与独立标定随工程完整保存恢复", async () => {
    const {source,review}=await fixture(),base=review.frames[0]!;
    review.frames=["front","left","right"].map((cameraId,i)=>({...base,id:`frame-${i}`,cameraId:cameraId as "front"|"left"|"right",camera:{...review.camera,intrinsics:[100+i*20,100+i*20,50,50]},candidates:[]}));
    const restored=await decodeProject((await encodeProject({source,pairedReview:review,annotations:[],projection:"xy",settings:{}})).buffer as ArrayBuffer);
    expect(restored.pairedReview).toEqual(review);
  });

});
