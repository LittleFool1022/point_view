const http = require("node:http");
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const path = require("node:path");
const { MAX_FILE } = require("./source-store.cjs");

function deviceOrigin(value) {
  const url = new URL(value);
  const octets = url.hostname.split(".").map(Number);
  const local = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  if (url.protocol !== "http:" || !local || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw Error("请输入设备的局域网 HTTP 地址，例如 http://10.42.0.1:8766。");
  }
  return url.origin;
}

function request(url, signal) {
  return new Promise((resolve, reject) => {
    // 使用系统直连 HTTP，不受浏览器 CORS、外网代理或重定向影响。
    const req = http.get(url, { signal, timeout: 15_000 }, response => {
      if (response.statusCode !== 200) {
        response.resume(); reject(Error(`设备请求失败（HTTP ${response.statusCode}）。`));
      } else resolve(response);
    });
    req.on("timeout", () => req.destroy(Error("设备连接超时，请检查网络。")));
    req.on("error", reject);
  });
}

function projectMetadata(project) {
  if (!project || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(project.id) || project.id.includes("..")
      || !/^tri_true_color_[A-Za-z0-9_.-]+\.pcd$/.test(project.fileName)
      || !Number.isSafeInteger(project.bytes) || project.bytes <= 0 || project.bytes > MAX_FILE
      || !Number.isSafeInteger(project.points) || project.points < 1
      || !/^[a-f0-9]{64}$/.test(project.sha256)) throw Error("设备项目清单无效或超过当前 2 GiB 容量。");
  const sets = project.keyframeSets ?? [];
  if (!Array.isArray(sets) || sets.length > 4096 || sets.some(set => !/^page-\d{6}$/.test(set.id)
    || !Number.isSafeInteger(set.bytes) || set.bytes < 1 || set.bytes > 16 * 1024 ** 2
    || !/^[a-f0-9]{64}$/.test(set.sha256) || set.fileName !== `${set.id}-${set.sha256.slice(0,16)}.pvframes`
    || !Number.isSafeInteger(set.frames) || set.frames < 1 || set.frames > 60)
    || new Set(sets.map(set => set.id)).size !== sets.length || sets.reduce((n, set) => n + set.bytes, 0) > 3 * 1024 ** 3) throw Error("设备关键帧卷清单无效。");
  return { id: project.id, fileName: project.fileName, bytes: project.bytes, points: project.points,
    sha256: project.sha256, createdAtMs: Number.isFinite(project.createdAtMs) ? project.createdAtMs : undefined,
    backupVerified: project.backupVerified === true,
    captureIntegrity: ["passed", "warning"].includes(project.captureIntegrity) ? project.captureIntegrity : "unknown",
    keyframesState: ["complete", "partial", "recording", "invalid"].includes(project.keyframesState) ? project.keyframesState : "unavailable",
    keyframeSets: sets.map(set => ({ id: set.id, fileName: set.fileName, bytes: set.bytes, sha256: set.sha256, frames: set.frames })) };
}

async function receiveFile(url, temporary, expected, { signal, progress = () => {} }) {
  try {
    const response = await request(url, signal);
    if (Number(response.headers["content-length"]) !== expected.bytes) { response.destroy(); throw Error("设备文件长度与清单不一致，未导入。"); }
    let done = 0; const hash = createHash("sha256");
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      done += chunk.length;
      if (done > expected.bytes) return callback(Error("设备文件超过声明长度，未导入。"));
      hash.update(chunk); progress(done, expected.bytes); callback(null, chunk);
    } });
    await pipeline(response, verify, createWriteStream(temporary, { flags: "wx" }), { signal });
    if (done !== expected.bytes || hash.digest("hex") !== expected.sha256) throw Error("设备文件 SHA256 校验失败，未导入。");
    signal?.throwIfAborted();
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

async function verifiedAsset(file, expected, signal) {
  try {
    if ((await fs.stat(file)).size !== expected.bytes) return false;
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of createReadStream(file, { signal, highWaterMark: 256 * 1024 })) {
      size += chunk.length;
      if (size > expected.bytes) return false;
      hash.update(chunk);
    }
    return size === expected.bytes && hash.digest("hex") === expected.sha256;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function listDeviceProjects(origin, { signal } = {}) {
  const response = await request(`${deviceOrigin(origin)}/api/v1/projects`, signal);
  const chunks = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 4 * 1024 ** 2) { response.destroy(); throw Error("设备项目清单过大。"); }
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body.ok || !Array.isArray(body.projects) || body.projects.length > 10_000) throw Error("设备项目清单无效。");
  return body.projects.map(projectMetadata);
}

async function receiveDeviceProject(origin, id, { directory, store, signal, progress = () => {} }) {
  origin = deviceOrigin(origin);
  const project = (await listDeviceProjects(origin, { signal })).find(p => p.id === id);
  if (!project) throw Error("设备项目已变化，请刷新列表。");
  const folder = path.join(directory, project.id, project.sha256);
  await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, project.fileName);
  const temporary = `${target}.${randomUUID()}.part`;
  const total = project.bytes + project.keyframeSets.reduce((sum, set) => sum + set.bytes, 0);
  let native;
  try {
    try { native = await store.register(target, { expectedHash: project.sha256, signal }); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (error.code !== "ENOENT" && !/SHA256|源文件区间/.test(error.message)) throw error;
    }
    if (!native) {
      await receiveFile(`${origin}/api/v1/projects/${encodeURIComponent(id)}/file`, temporary, project,
        { signal, progress: done => progress(done, total) });
      // 通过长度和哈希后才替换接收文件，坏包/取消不会覆盖已有成果。
      await fs.rename(temporary, target);
      native = await store.register(target, { expectedHash: project.sha256, signal });
    }
    let receivedBytes = project.bytes;
    progress(receivedBytes, total);
    const pages = [];
    for (const set of project.keyframeSets) {
      const file = path.join(folder, set.fileName), part = `${file}.${randomUUID()}.part`;
      if (!await verifiedAsset(file, set, signal)) {
        await receiveFile(`${origin}/api/v1/projects/${encodeURIComponent(id)}/keyframes/${set.id}`, part, set, { signal,
          progress: done => progress(receivedBytes + done, total) });
        try { await fs.rename(part, file); } finally { await fs.unlink(part).catch(() => {}); }
      }
      receivedBytes += set.bytes;
      progress(receivedBytes, total);
      pages.push({ ...set, file });
    }
    if (pages.length) native.keyframePages = await store.attachPages(native.token, pages);
    const deviceReceipt = { schema: "survey-device-receipt/1", deviceOrigin: origin, session: project.id,
      fileName: project.fileName, bytes: project.bytes, points: project.points, sha256: project.sha256,
      receivedAt: new Date().toISOString(), desktopReceivedVerified: true,
      deviceBackupVerified: project.backupVerified, captureIntegrity: project.captureIntegrity, qualityVerified: false,
      keyframesState: project.keyframesState, keyframeSets: project.keyframeSets };
    await fs.writeFile(path.join(folder, "receipt.json"), JSON.stringify(deviceReceipt, null, 2));
    return { name: project.fileName, native, deviceReceipt };
  } catch (error) {
    if (native) await store.release(native.token);
    throw error;
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

module.exports = { deviceOrigin, listDeviceProjects, receiveDeviceProject };
