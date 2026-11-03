import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeProject, decodeProject, validateProjectState } from "../src/domain/project";
const require = createRequire(import.meta.url);
const { SourceStore } = require("../electron/source-store.cjs");
const { deviceOrigin, listDeviceProjects, receiveDeviceProject } = require("../electron/device-receiver.cjs");

async function fixture(mode: "good" | "bad-hash" | "truncated" | "slow" | "bad-page", run: (context: any) => Promise<void>, withPages = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "survey-device-")), store = new SourceStore();
  const points = 65_536;
  const bytes = Buffer.concat([Buffer.from(`VERSION .7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH ${points}\nHEIGHT 1\nPOINTS ${points}\nDATA binary\n`), Buffer.alloc(points * 16, 39)]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const project:any = { id: "real_sample", fileName: "tri_true_color_fixture.pcd", bytes: bytes.length, points, sha256: hash, captureIntegrity: "warning", backupVerified: false };
  const stats={fileRequests:0,pageRequests:0,mode};
  const image=await readFile(new URL("./fixtures/keyframe.jpg",import.meta.url));
  const pageBuffers:Buffer[]=[];
  if(withPages){
    project.keyframesState="complete";
    project.keyframeSets=[1,2,3].map(n=>{
      const id=`page-${String(n).padStart(6,"0")}`,camera={model:"opencv_rational8",width:16,height:16,intrinsics:[10,10,8,8],distortion:Array(8).fill(0)};
      const data=Buffer.from(JSON.stringify({schema:"survey-paired-review/1",session:project.id,sourceSha256:project.sha256,frameId:"camera_init",poseSpace:"raw",units:"m",alignmentVerified:false,captureQuality:"partial",model:{id:"unassigned",revision:"none"},camera,walls:[],frames:[{id:`${id}-frame`,name:`${id}.jpg`,stampNs:String(n*1e9),sha256:createHash("sha256").update(image).digest("hex"),image:`data:image/jpeg;base64,${image.toString("base64")}`,cameraId:["front","left","right"][n-1],camera,TWorldCamera:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],analyzed:false,candidates:[]}]}));
      pageBuffers.push(data);const sha256=createHash("sha256").update(data).digest("hex");
      return{id,fileName:`${id}-${sha256.slice(0,16)}.pvframes`,bytes:data.length,sha256,frames:1};
    });
  }
  const server = createServer((req, res) => {
    if (req.url === "/api/v1/projects") { res.end(JSON.stringify({ ok: true, projects: [project] })); return; }
    if(req.url?.startsWith("/api/v1/projects/real_sample/keyframes/")){
      const index=project.keyframeSets?.findIndex((p:any)=>req.url?.endsWith(p.id));
      if(index===undefined||index<0){res.writeHead(404);res.end();return;}
      stats.pageRequests++;const payload=Buffer.from(pageBuffers[index]!);res.setHeader("Content-Length",payload.length);
      if(stats.mode==="bad-page"&&index===1)payload[payload.length-1]^=1;
      res.end(payload);return;
    }
    if (req.url !== "/api/v1/projects/real_sample/file") { res.writeHead(404); res.end(); return; }
    stats.fileRequests++;res.setHeader("Content-Length", bytes.length);
    if (mode === "bad-hash") { const bad = Buffer.from(bytes); bad[bad.length - 1] ^= 1; res.end(bad); }
    else if (mode === "truncated") { res.write(bytes.subarray(0, 4096)); setTimeout(() => res.destroy(), 15); }
    else if (mode === "slow") {
      let sent = 0;
      const timer = setInterval(() => { res.write(bytes.subarray(sent, sent + 16_384)); sent += 16_384; if (sent >= bytes.length) { clearInterval(timer); res.end(); } }, 10);
      res.on("close", () => clearInterval(timer));
    } else res.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const target = path.join(directory, project.id, hash, project.fileName);
  const stopServer=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
  try { await run({ directory, store, bytes, project, origin, target, stats, stopServer }); }
  finally { await store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}

describe("设备完整文件接收", () => {
  it("完整接收所有三目卷，断开HTTP并删除缓存后工程仍保留全部原图",async()=>{
    await fixture("good",async({directory,store,project,origin,stats,stopServer})=>{
      const received=await receiveDeviceProject(origin,project.id,{directory,store});
      expect(received.native.keyframePages).toHaveLength(3);
      expect(stats.pageRequests).toBe(3);
      const first=JSON.parse(Buffer.from(await store.readPage(received.native.token,received.native.keyframePages[0].id)).toString());
      const output=path.join(directory,"all-frames.pvplan");
      await store.saveProject(received.native.token,output,{source:{units:"m",synthetic:false,deviceReceipt:received.deviceReceipt},pairedReview:first,activeKeyframePage:received.native.keyframePages[0].id,projection:"xy",settings:{},annotations:[]});
      await store.close();await stopServer();await rm(path.join(directory,project.id),{recursive:true});
      const restoredStore=new SourceStore();
      try{
        const opened=await restoredStore.openProject(output);validateProjectState(opened.project);
        expect(opened.native.keyframePages).toHaveLength(3);
        expect(opened.project.pairedReviewIndex.map((f:any)=>f.cameraId)).toEqual(["front","left","right"]);
        expect(opened.project.source.deviceReceipt.keyframeSets).toHaveLength(3);
      }finally{await restoredStore.close();}
    },true);
  });
  it("原图卷坏包不入库；重试复用已校验PCD和前卷，不重复传输",async()=>{
    await fixture("bad-page",async({directory,store,project,origin,stats,target})=>{
      await expect(receiveDeviceProject(origin,project.id,{directory,store})).rejects.toThrow("SHA256");
      expect(store.entries.size).toBe(0);expect(stats.fileRequests).toBe(1);expect(stats.pageRequests).toBe(2);
      expect((await readdir(path.dirname(target))).some(name=>name.endsWith(".part"))).toBe(false);
      stats.mode="good";
      const received=await receiveDeviceProject(origin,project.id,{directory,store});
      expect(received.native.keyframePages).toHaveLength(3);
      expect(stats.fileRequests).toBe(1);expect(stats.pageRequests).toBe(4);
    },true);
  });
  it("真实 HTTP 流式接收原字节，保留告警；回执随流式和兼容工程离线恢复", async () => {
    await fixture("good", async ({ directory, store, bytes, project, origin }) => {
      const projects = await listDeviceProjects(origin);
      expect(projects[0].captureIntegrity).toBe("warning");
      let transferred = 0;
      const received = await receiveDeviceProject(origin, project.id, { directory, store, progress: (done: number) => { transferred = done; } });
      expect(transferred).toBe(bytes.length);
      expect(received.native.sha256).toBe(project.sha256);
      expect(received.native.size).toBe(bytes.length);
      expect(received.deviceReceipt.desktopReceivedVerified).toBe(true);
      expect(received.deviceReceipt.deviceBackupVerified).toBe(false);
      expect(received.deviceReceipt.qualityVerified).toBe(false);
      const state = { source: { units: "m", synthetic: false, deviceReceipt: received.deviceReceipt }, annotations: [], settings: {}, projection: "xy" };
      const output = path.join(directory, "offline.pvplan");
      await store.saveProject(received.native.token, output, state);
      const restored = await store.openProject(output);
      validateProjectState(restored.project);
      expect(restored.project.source.deviceReceipt).toEqual(received.deviceReceipt);
      expect(Buffer.from(await store.read(restored.native.token, bytes.length - 32, 32))).toEqual(bytes.subarray(-32));
      const portable = await encodeProject({ ...state, source: { ...state.source, units: "m", name: received.name, bytes: Uint8Array.from(bytes).buffer } } as any);
      expect((await decodeProject(portable.slice().buffer as ArrayBuffer)).source.deviceReceipt).toEqual(received.deviceReceipt);
      expect(() => validateProjectState({ ...restored.project, source: { ...restored.project.source, sha256: "f".repeat(64) } })).toThrow("回执");
    });
  });
  for (const mode of ["bad-hash", "truncated", "slow"] as const) it(`${mode} 不替换已有文件、不残留半包或注册源句柄`, async () => {
    await fixture(mode, async ({ directory, store, bytes, project, origin, target }) => {
      const previous=Buffer.from("previous incompatible cache");await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, previous);
      const abort = new AbortController(); let progress = 0;
      await expect(receiveDeviceProject(origin, project.id, { directory, store, signal: abort.signal,
        progress: (done: number) => { progress = done; if (mode === "slow") abort.abort(); } })).rejects.toThrow();
      if (mode === "slow") expect(progress).toBeGreaterThan(0);
      expect(await readFile(target)).toEqual(previous);
      expect((await readdir(path.dirname(target))).some(name => name.endsWith(".part"))).toBe(false);
      expect(store.entries.size).toBe(0);
    });
  });
  it("设备连接只接受局域网 HTTP 根地址", () => {
    expect(deviceOrigin("http://10.42.0.1:8766")).toBe("http://10.42.0.1:8766");
    for (const origin of ["https://example.org", "http://8.8.8.8", "http://10.42.0.1/api", "http://a:b@10.42.0.1"]) expect(() => deviceOrigin(origin)).toThrow();
  });
});
