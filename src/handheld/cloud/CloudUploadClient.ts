export interface CloudConfig { endpoint: string; token: string }
export interface CloudReceipt { state: "completed"; objectId: string; sha256: string; bytes: number; completedAt: string; endpoint: string }
export interface UploadFile { projectId: string; name: string; fileName: string; bytes: number; sha256: string; points: number }
interface UploadSession { uploadId: string; offset: number; chunkSize: number; receipt?: Omit<CloudReceipt, "endpoint"> }
const CONFIG_KEY = "omni-cloud-endpoint-v1";

export function validateCloudEndpoint(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("请输入完整的云服务地址"); }
  const octets = url.hostname.split(".");
  const ipv4 = octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const ip = octets.map(Number);
  const privateHost = url.hostname === "localhost" || url.hostname === "[::1]" || ipv4 &&
    (ip[0] === 127 || ip[0] === 10 || ip[0] === 192 && ip[1] === 168 || ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost))) {
    throw new Error("请填写 HTTPS 云服务地址；HTTP 仅用于本机或内网联调");
  }
  return url.href.replace(/\/+$/, "");
}
export function readCloudEndpoint(): string {
  try { const value = localStorage.getItem(CONFIG_KEY); return value ? validateCloudEndpoint(value) : ""; } catch { return ""; }
}
export function saveCloudEndpoint(endpoint: string): void { localStorage.setItem(CONFIG_KEY, validateCloudEndpoint(endpoint)); }

function errorFor(status: number): Error {
  return new Error(status === 401 || status === 403 ? "云服务认证未通过，请检查访问凭证"
    : status === 413 ? "文件超过云服务接收上限" : status === 422 ? "云端文件校验失败，请检查完整文件后重试"
    : status === 409 ? "云端进度发生变化，请点击继续上云重新同步" : "云服务暂时无法处理，请稍后继续上云");
}
function abortError() { return new DOMException("已暂停", "AbortError"); }
async function jsonRequest<T>(config: CloudConfig, suffix: string, body: unknown, signal: AbortSignal, method: "POST" | "PUT" = "POST", range?: string): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, range ? 60000 : 30000);
  try {
    const response = await fetch(`${config.endpoint}/api/v1/pointcloud-uploads${suffix}`, { method, credentials: "omit", redirect: "error", cache: "no-store",
      headers: { "Content-Type": range ? "application/octet-stream" : "application/json", ...(range ? { "Content-Range": range } : {}), ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) }, body: body instanceof Blob ? body : JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw errorFor(response.status);
    return await response.json() as T;
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof SyntaxError) throw new Error("云端响应格式不正确");
    if (error instanceof TypeError || controller.signal.aborted) throw new Error("无法连接云服务，请检查网络后继续上云");
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

/** 按服务端确认的字节更新进度；拒绝重定向，避免把点云发送到配置之外的地址。 */
async function sendChunk(config: CloudConfig, id: string, blob: Blob, offset: number, total: number, signal: AbortSignal): Promise<number> {
  const reply = await jsonRequest<{ uploadId: string; offset: number }>(config, `/${encodeURIComponent(id)}`, blob, signal, "PUT",
    `bytes ${offset}-${offset + blob.size - 1}/${total}`);
  if (reply.uploadId !== id || reply.offset !== offset + blob.size) throw new Error("云端进度确认无效，请稍后继续上云");
  return reply.offset;
}
function receiptFor(value: Omit<CloudReceipt, "endpoint">, file: UploadFile, endpoint: string): CloudReceipt {
  if (value?.state !== "completed" || value.sha256 !== file.sha256 || value.bytes !== file.bytes || typeof value.objectId !== "string" || !value.objectId
    || typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))) throw new Error("云端完成回执校验不一致，请勿删除原文件");
  return { state: "completed", objectId: value.objectId, sha256: value.sha256, bytes: value.bytes, completedAt: value.completedAt, endpoint };
}
export async function uploadPointCloud(config: CloudConfig, file: UploadFile, blob: Blob, signal: AbortSignal,
  progress: (phase: "uploading" | "verifying", percent: number) => void): Promise<CloudReceipt> {
  const active = { endpoint: validateCloudEndpoint(config.endpoint), token: config.token.trim() };
  if (!file.bytes || file.bytes !== blob.size || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error("完整文件信息无效，请重新打开项目");
  const session = await jsonRequest<UploadSession>(active, "", file, signal);
  if (session.receipt) return receiptFor(session.receipt, file, active.endpoint);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.uploadId) || !Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > blob.size
    || !Number.isSafeInteger(session.chunkSize) || session.chunkSize < 1 || session.chunkSize > 4 * 1024 * 1024) throw new Error("云端上传任务信息无效");
  let offset = session.offset;
  progress("uploading", Math.floor(offset / blob.size * 100));
  while (offset < blob.size) {
    if (signal.aborted) throw abortError();
    offset = await sendChunk(active, session.uploadId, blob.slice(offset, Math.min(blob.size, offset + session.chunkSize)), offset, blob.size, signal);
    progress("uploading", Math.min(100, Math.floor(offset / blob.size * 100)));
  }
  progress("verifying", 100);
  return receiptFor(await jsonRequest(active, `/${encodeURIComponent(session.uploadId)}/complete`, {}, signal), file, active.endpoint);
}
