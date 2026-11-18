type PendingRequest = { id: number; resolve(value: unknown): void; reject(error: Error): void };
type WorkerMessage = { id: number; kind?: "progress" | "read"; stage?: string; chunkId?: number; token?: string; offset?: number; size?: number; error?: string; result?: unknown };

/** 分析 Worker 的唯一请求、原生分块读取与取消边界。 */
export class AnalysisClient {
  private worker?: Worker;
  private sequence = 0;
  private pending?: PendingRequest;

  constructor(private readonly onProgress: (stage: string) => void) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const runtime = new Worker(new URL("./pipeline/analysis.worker.ts", import.meta.url), { type: "module" });
    this.worker = runtime;
    runtime.onmessage = event => {
      if (this.worker !== runtime) return;
      const data = event.data as WorkerMessage, pending = this.pending;
      if (!pending || pending.id !== data.id) return;
      if (data.kind === "progress") { this.onProgress(data.stage ?? "分析中"); return; }
      if (data.kind === "read") {
        const { chunkId, token, offset, size } = data;
        if (!window.surveyDesktop || chunkId === undefined || token === undefined || offset === undefined || size === undefined) {
          runtime.postMessage({ action: "chunk", chunkId, error: "桌面文件读取接口不可用。" }); return;
        }
        void window.surveyDesktop.read(token, offset, size).then(buffer => {
          if (this.worker === runtime) runtime.postMessage({ action: "chunk", chunkId, buffer }, [buffer]);
        }).catch((error: unknown) => {
          if (this.worker === runtime) runtime.postMessage({ action: "chunk", chunkId, error: String(error) });
        });
        return;
      }
      this.pending = undefined;
      if (data.error) pending.reject(Error(data.error)); else pending.resolve(data.result);
    };
    runtime.onerror = () => {
      if (this.worker !== runtime) return;
      this.pending?.reject(Error("分析进程异常，请重新导入成果。"));
      this.pending = undefined; runtime.terminate(); this.worker = undefined;
    };
    return runtime;
  }

  request<T>(data: object): Promise<T> {
    const runtime = this.ensureWorker();
    if (this.pending) return Promise.reject(Error("已有分析任务正在运行。"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending = { id, resolve: value => resolve(value as T), reject };
      runtime.postMessage({ id, ...data });
    });
  }

  cancel() {
    const runtime = this.worker, pending = this.pending;
    this.worker = undefined; this.pending = undefined;
    runtime?.terminate();
    pending?.reject(Error("已取消分析，原始文件和现有工程保留；下次分析会重新读取完整源点。"));
  }

  dispose() {
    this.worker?.terminate(); this.worker = undefined; this.pending = undefined;
  }
}
