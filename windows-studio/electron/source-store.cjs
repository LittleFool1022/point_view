const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");

const MAGIC = Buffer.from("PVPLAN2\n");
const MAGIC3 = Buffer.from("PVPLAN3\n");
const MAX_FILE = 2 * 1024 ** 3;
const MAX_MANIFEST = 16 * 1024 ** 2;
const CHUNK = 8 * 1024 ** 2;
const MAX_ASSETS = 3 * 1024 ** 3;

const pageInfo = page => ({ id: page.id, fileName: page.fileName, bytes: page.size,
  sha256: page.sha256, originalSha256: page.originalSha256 ?? page.sha256 });
function pageList(pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 4096) throw Error("关键帧卷索引无效。");
  const ids = new Set(); let total = 0;
  for (const page of pages) {
    if (!/^page-\d{6}$/.test(page.id) || ids.has(page.id) || !Number.isSafeInteger(page.bytes)
      || page.bytes < 1 || page.bytes > MAX_MANIFEST || !/^[a-f0-9]{64}$/.test(page.sha256)
      || (page.originalSha256 !== undefined && !/^[a-f0-9]{64}$/.test(page.originalSha256))) throw Error("关键帧卷索引无效。");
    ids.add(page.id); total += page.bytes;
  }
  if (total > MAX_ASSETS) throw Error("关键帧原图超过当前3GiB工程附件容量。");
}

async function readPageBuffer(page, sourceSha256) {
  const data = Buffer.alloc(page.size), file = await fs.open(page.file, "r");
  try {
    let done = 0;
    while (done < data.length) {
      const { bytesRead } = await file.read(data, done, data.length - done, (page.offset ?? 0) + done);
      if (!bytesRead) throw Error("关键帧卷不完整。");
      done += bytesRead;
    }
  } finally { await file.close(); }
  if (createHash("sha256").update(data).digest("hex") !== page.sha256) throw Error("关键帧卷SHA256校验失败。");
  const review = JSON.parse(data.toString("utf8"));
  if (review.schema !== "survey-paired-review/1" || review.sourceSha256 !== sourceSha256
      || !Array.isArray(review.frames) || !review.frames.length || review.frames.length > 60) throw Error("关键帧卷与原件不一致。");
  for (const frame of review.frames) {
    if (typeof frame.image !== "string" || !frame.image.startsWith("data:image/jpeg;base64,")) throw Error("关键帧原图格式无效。");
    const image = Buffer.from(frame.image.slice(23), "base64");
    if (image[0] !== 255 || image[1] !== 216 || image[2] !== 255
        || createHash("sha256").update(image).digest("hex") !== frame.sha256) throw Error("关键帧原图校验失败。");
  }
  return { data, review };
}

async function copyRange(source, target, { signal, progress }) {
  const hash = createHash("sha256"); let done = 0;
  const verify = new Transform({ transform(chunk, _encoding, callback) {
    hash.update(chunk); done += chunk.length; progress(chunk.length); callback(null, chunk);
  } });
  await pipeline(createReadStream(source.file, { start: source.offset ?? 0,
    end: (source.offset ?? 0) + source.size - 1, highWaterMark: CHUNK }), verify,
  createWriteStream(target, { flags: "a" }), { signal });
  if (done !== source.size || hash.digest("hex") !== source.sha256) throw Error("保存期间原件或关键帧发生变化，未替换目标工程。");
}

// 原件始终在磁盘；token 只允许当前应用访问已选择文件的限定区间。
class SourceStore {
  constructor() { this.entries = new Map(); this.editDirectory = undefined; }
  async register(file, { offset = 0, size, name = path.basename(file), expectedHash, signal, progress = () => {}, allowTrailing = false } = {}) {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat(); size ??= stat.size - offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE
          || offset + size > stat.size || (!allowTrailing && offset + size !== stat.size)) throw Error("源文件区间无效或超过当前 2 GiB 文件容量。");
      const hash = createHash("sha256"); let done = 0;
      for await (const bytes of createReadStream(file, { start: offset, end: offset + size - 1, highWaterMark: CHUNK, signal })) {
        hash.update(bytes); done += bytes.length; progress(done, size);
      }
      const sha256 = hash.digest("hex");
      if (expectedHash && sha256 !== expectedHash.toLowerCase()) throw Error("工程源文件 SHA256 校验失败，未替换当前工程。");
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error("读取期间源文件发生变化。");
      const token = randomUUID(); this.entries.set(token, { file, handle, offset, size, name, sha256, stat, pages: [], edits: [] });
      return { token, name, size, sha256 };
    } catch (e) { await handle.close(); throw e; }
  }
  async read(token, offset, size) {
    const source = this.entries.get(token);
    if (!source) throw Error("源文件已释放，请重新打开工程。");
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 1 || size > CHUNK || offset + size > source.size) throw Error("无效的分块读取请求。");
    const stat = await source.handle.stat();
    if (stat.size !== source.stat.size || stat.mtimeMs !== source.stat.mtimeMs) throw Error("源文件已变化，请重新导入。");
    const buffer = Buffer.allocUnsafe(size); let done = 0;
    while (done < size) {
      const { bytesRead } = await source.handle.read(buffer, done, size - done, source.offset + offset + done);
      if (!bytesRead) throw Error("源文件不完整。"); done += bytesRead;
    }
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  async attachPages(token, pages) {
    const source = this.entries.get(token);
    if (!source) throw Error("源文件已释放。");
    pageList(pages);
    const next = pages.map(page => ({ ...page, size: page.bytes, offset: page.offset ?? 0 }));
    for (const page of next) await readPageBuffer(page, source.sha256);
    source.pages = next;
    return next.map(pageInfo);
  }
  async readPage(token, id) {
    const source = this.entries.get(token), page = source?.pages.find(page => page.id === id);
    if (!page) throw Error("关键帧卷不存在或已释放。");
    const { data } = await readPageBuffer(page, source.sha256);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  async writePage(source, old, review) {
    const data = Buffer.from(JSON.stringify(review), "utf8");
    if (data.length > MAX_MANIFEST) throw Error("关键帧卷超过16MiB。");
    this.editDirectory ??= await fs.mkdtemp(path.join(tmpdir(), "survey-frame-edits-"));
    const file = path.join(this.editDirectory, `${randomUUID()}.pvframes`);
    await fs.writeFile(file, data, { flag: "wx" });
    const next = { ...old, file, offset: 0, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), originalSha256: old.originalSha256 ?? old.sha256 };
    try { await readPageBuffer(next, source.sha256); }
    catch (error) { await fs.unlink(file); throw error; }
    source.edits.push(file);
    return next;
  }
  async updatePage(token, id, review) {
    const source = this.entries.get(token), index = source?.pages.findIndex(page => page.id === id);
    if (!source || index === -1) throw Error("关键帧卷不存在或已释放。");
    const old = source.pages[index], next = await this.writePage(source, old, review);
    source.pages[index] = next;
    if (source.edits.includes(old.file)) {
      await fs.unlink(old.file).catch(() => {});
      source.edits = source.edits.filter(file => file !== old.file);
    }
    return pageInfo(next);
  }
  async addPage(token, review) {
    const source = this.entries.get(token);
    if (!source || source.pages.length >= 4096) throw Error("源文件已释放或关键帧卷数已满。");
    const existing = new Set((await this.reviewIndex(token)).map(frame => frame.id));
    if (review.frames.some(frame => existing.has(frame.id))) throw Error("该原图卷已在工程中，请切换卷查看，避免覆盖已有复核。");
    const serial = Math.max(0, ...source.pages.map(page => Number(page.id.slice(5)))) + 1;
    const id = `page-${String(serial).padStart(6, "0")}`;
    const data = Buffer.from(JSON.stringify(review));
    const next = await this.writePage(source, { id, fileName: `${id}.pvframes`, sha256: createHash("sha256").update(data).digest("hex") }, review);
    try { pageList([...source.pages.map(pageInfo), pageInfo(next)]); }
    catch (error) { await fs.unlink(next.file); source.edits = source.edits.filter(file => file !== next.file); throw error; }
    source.pages.push(next);
    return source.pages.map(pageInfo);
  }
  async reviewIndex(token) {
    const source = this.entries.get(token);
    if (!source) throw Error("源文件已释放。");
    const result = [], ids = new Set();
    for (const page of source.pages) {
      const { review } = await readPageBuffer(page, source.sha256);
      for (const { image, ...frame } of review.frames) {
        if (ids.has(frame.id)) throw Error("关键帧身份在多个卷中重复。");
        ids.add(frame.id);
        result.push({ ...frame, pageId: page.id, session: review.session, sourceSha256: review.sourceSha256, model: review.model,
          captureQuality: review.captureQuality, alignmentVerified: review.alignmentVerified });
      }
    }
    return result;
  }
  async release(token) {
    const entry = this.entries.get(token); this.entries.delete(token);
    if (entry) { await entry.handle.close(); await Promise.all(entry.edits.map(file => fs.unlink(file).catch(() => {}))); }
  }
  async close() {
    await Promise.all([...this.entries.keys()].map(token => this.release(token)));
    if (this.editDirectory) await fs.rm(this.editDirectory, { recursive: true, force: true });
  }
  async openProject(file, options = {}) {
    const handle = await fs.open(file, "r"); let manifest, offset;
    try {
      const head = Buffer.alloc(12); await handle.read(head, 0, 12, 0);
      if (!head.subarray(0, 8).equals(MAGIC) && !head.subarray(0, 8).equals(MAGIC3)) return undefined;
      const paged = head.subarray(0, 8).equals(MAGIC3);
      const length = head.readUInt32LE(8);
      if (!length || length > MAX_MANIFEST) throw Error("工程清单长度无效。");
      const body = Buffer.alloc(length); const read = await handle.read(body, 0, length, 12);
      if (read.bytesRead !== length) throw Error("工程清单不完整。");
      manifest = JSON.parse(body.toString("utf8")); offset = 12 + length;
      if (manifest.schema !== (paged ? "survey-project/3" : "survey-project/2") || !/^[a-f0-9]{64}$/i.test(manifest.source?.sha256 ?? "") || typeof manifest.source.name !== "string") throw Error("工程格式无效。");
      if (paged) {
        pageList(manifest.keyframePages);
        const total = offset + manifest.source.size + manifest.keyframePages.reduce((sum, page) => sum + page.bytes, 0);
        if (total !== (await handle.stat()).size) throw Error("工程原件或关键帧卷长度不一致。");
      }
    } finally { await handle.close(); }
    const paged = manifest.schema === "survey-project/3";
    const source = await this.register(file, { ...options, offset, name: manifest.source.name, size: manifest.source.size,
      expectedHash: manifest.source.sha256, allowTrailing: paged });
    try {
      if (paged) {
        let cursor = offset + source.size;
        const pages = manifest.keyframePages.map(page => { const next = { ...page, file, offset: cursor }; cursor += page.bytes; return next; });
        source.keyframePages = await this.attachPages(source.token, pages);
        manifest.pairedReviewIndex = await this.reviewIndex(source.token);
        const active = manifest.activeKeyframePage ?? pages[0].id;
        manifest.pairedReview = JSON.parse(Buffer.from(await this.readPage(source.token, active)).toString("utf8"));
        manifest.activeKeyframePage = active;
      }
      return { name: source.name, native: source, project: manifest };
    } catch (error) { await this.release(source.token); throw error; }
  }
  async saveProject(token, file, state, { signal, progress = () => {} } = {}) {
    const source = this.entries.get(token);
    if (!source) throw Error("请重新打开源文件。");
    if ([...this.entries.values()].some(s => [s.file, ...s.pages.map(page => page.file)].some(input => path.resolve(input).toLowerCase() === path.resolve(file).toLowerCase()))) throw Error("请另存为新工程文件，不能覆盖正在使用的源文件。");
    const paged = source.pages.length > 0;
    if (paged && state.pairedReview) await this.updatePage(token, state.activeKeyframePage ?? source.pages[0].id, state.pairedReview);
    const manifest = { ...state, schema: paged ? "survey-project/3" : "survey-project/2",
      source: { ...state.source, name: source.name, size: source.size, sha256: source.sha256 } };
    if (paged) { manifest.keyframePages = source.pages.map(pageInfo); delete manifest.pairedReview; delete manifest.pairedReviewIndex; }
    const body = Buffer.from(JSON.stringify(manifest), "utf8");
    if (body.length > MAX_MANIFEST) throw Error("工程清单过大。");
    const header = Buffer.alloc(12); (paged ? MAGIC3 : MAGIC).copy(header); header.writeUInt32LE(body.length, 8);
    const temporary = `${file}.${randomUUID()}.part`;
    let created = false;
    try {
      await fs.writeFile(temporary, Buffer.concat([header, body]), { flag: "wx" }); created = true;
      let done = 0;
      const total = source.size + source.pages.reduce((sum, page) => sum + page.size, 0);
      for (const range of [source, ...source.pages]) await copyRange(range, temporary, { signal, progress: size => { done += size; progress(done, total); } });
      const stat = await source.handle.stat();
      if (stat.size !== source.stat.size || stat.mtimeMs !== source.stat.mtimeMs) throw Error("源文件已变化，未保存工程。");
      signal?.throwIfAborted(); await fs.rename(temporary, file); created = false;
      return { saved: true, bytes: header.length + body.length + total, sha256: source.sha256 };
    } finally { if (created) await fs.unlink(temporary).catch(() => {}); }
  }
}
module.exports = { SourceStore, MAX_FILE };
