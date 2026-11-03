import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const { SourceStore } = createRequire(import.meta.url)("../electron/source-store.cjs");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function setup(large = false) {
  const root = await mkdtemp(path.join(tmpdir(), "survey-paged-project-"));
  const input = path.join(root, "input"); await mkdir(input);
  const bytes = Buffer.concat([Buffer.from("POINTS 1\nDATA binary\n"), Buffer.alloc(40, 31)]);
  const file = path.join(input, "tri_true_color_fixture.pcd"); await writeFile(file, bytes);
  const original = await readFile(new URL("./fixtures/keyframe.jpg", import.meta.url));
  // 有效JPEG的COM段扩容：不伪造大数据验收，专门检查旧16MiB清单断点。
  const comment = Buffer.alloc(60_004, 65); comment[0] = 255; comment[1] = 254; comment.writeUInt16BE(60_002, 2);
  const image = large ? Buffer.concat([original.subarray(0, 2), ...Array(100).fill(comment), original.subarray(2)]) : original;
  const store = new SourceStore(), source = await store.register(file);
  const pages = [], reviews: any[] = [];
  for (let i = 1; i <= 3; i++) {
    const id = `page-${String(i).padStart(6, "0")}`;
    const camera = { model: "opencv_rational8", width: 16, height: 16, intrinsics: [10, 10, 8, 8], distortion: Array(8).fill(0) };
    const review = { schema: "survey-paired-review/1", session: "fixture", sourceSha256: source.sha256,
      frameId: "camera_init", poseSpace: "raw", units: "m", alignmentVerified: false, captureQuality: "partial",
      model: { id: "unassigned", revision: "none" }, camera, walls: [], frames: [{ id: `${id}-frame`, name: `${id}.jpg`,
        stampNs: String(i * 1e9), sha256: hash(image), image: `data:image/jpeg;base64,${image.toString("base64")}`,
        cameraId: ["front", "left", "right"][i - 1], camera, TWorldCamera: [1, 0, 0, i, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        analyzed: false, candidates: [] }] };
    const data = Buffer.from(JSON.stringify(review));
    const pageFile = path.join(input, `${id}.pvframes`); await writeFile(pageFile, data);
    pages.push({ id, fileName: path.basename(pageFile), file: pageFile, bytes: data.length, sha256: hash(data) });
    reviews.push(review);
  }
  await store.attachPages(source.token, pages);
  return { root, input, store, source, pages, reviews, bytes };
}

describe("完整工程的多卷原图", () => {
  it("超过16MiB的原图独立流式保存，删掉外部原件后仍可换机恢复全部卷和跨卷修改", async () => {
    const f = await setup(true), restoredStore = new SourceStore();
    try {
      const edited = structuredClone(f.reviews[1]); edited.frames[0].analyzed = true;
      edited.frames[0].candidates = [{ id: "reviewed-window", label: "window", score: .8, box: [0, 0, 8, 8], wallSupportPoints: 0, wallSupportFraction: 0, decision: "retain", note: "左视复核意见" }];
      await f.store.updatePage(f.source.token, f.pages[1]!.id, edited);
      const project = path.join(f.root, "portable.pvplan");
      await f.store.saveProject(f.source.token, project, { source: { units: "m", synthetic: false }, pairedReview: f.reviews[0],
        activeKeyframePage: f.pages[0]!.id, projection: "xy", settings: {}, annotations: [] });
      expect((await stat(project)).size).toBeGreaterThan(16 * 1024 ** 2);
      const handle = await open(project, "r"), head = Buffer.alloc(12); await handle.read(head, 0, 12, 0); await handle.close();
      expect(head.subarray(0, 8).toString()).toBe("PVPLAN3\n");
      expect(head.readUInt32LE(8)).toBeLessThan(64 * 1024);
      await f.store.close(); await rm(f.input, { recursive: true });
      const restored = await restoredStore.openProject(project);
      expect(restored.native.sha256).toBe(f.source.sha256);
      expect(restored.native.keyframePages).toHaveLength(3);
      expect(Buffer.from(await restoredStore.read(restored.native.token, 0, f.bytes.length))).toEqual(f.bytes);
      const second = JSON.parse(Buffer.from(await restoredStore.readPage(restored.native.token, f.pages[1]!.id)).toString());
      expect(second.frames[0].candidates[0].note).toBe("左视复核意见");
      expect(second.frames[0].sha256).toBe(f.reviews[1].frames[0].sha256);
      expect(restored.project.pairedReviewIndex.map((frame: any) => frame.pageId)).toEqual(f.pages.map(page => page.id));
      expect(restored.project.pairedReviewIndex.every((frame: any) => frame.image === undefined)).toBe(true);
    } finally { await f.store.close(); await restoredStore.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("取消附件写入或附件在保存前损坏，均不覆盖已有工程，也不残留半包", async () => {
    const f = await setup();
    try {
      const target = path.join(f.root, "keep.pvplan"); await writeFile(target, "previous engineering work");
      const state = { source: { units: "m", synthetic: false }, projection: "xy", settings: {}, annotations: [] };
      const abort = new AbortController();
      await expect(f.store.saveProject(f.source.token, target, state, { signal: abort.signal,
        progress: (done: number) => { if (done > f.bytes.length) abort.abort(); } })).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("previous engineering work");
      await writeFile(f.pages[2]!.file, "broken frame page");
      await expect(f.store.saveProject(f.source.token, target, state)).rejects.toThrow("发生变化");
      expect(await readFile(target, "utf8")).toBe("previous engineering work");
      expect((await readdir(f.root)).some(name => name.endsWith(".part"))).toBe(false);
    } finally { await f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("拒绝错源、损坏原图和重复卷，不以外层文件哈希替代图像来源校验", async () => {
    const f = await setup();
    try {
      await expect(f.store.attachPages(f.source.token, [f.pages[0], f.pages[0]])).rejects.toThrow("索引");
      for (const broken of [{ ...f.reviews[0], sourceSha256: "a".repeat(64) },
        { ...f.reviews[0], frames: [{ ...f.reviews[0].frames[0], sha256: "b".repeat(64) }] }]) {
        await expect(f.store.updatePage(f.source.token, f.pages[0]!.id, broken)).rejects.toThrow();
      }
      expect(JSON.parse(Buffer.from(await f.store.readPage(f.source.token, f.pages[0]!.id)).toString()).frames[0].sha256).toBe(f.reviews[0].frames[0].sha256);
    } finally { await f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  });
});
