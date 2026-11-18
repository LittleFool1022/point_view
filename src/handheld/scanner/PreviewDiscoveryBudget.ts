export interface IdentityConnectionResult { sourceReconnected: boolean; connectionGeneration: number }

/** 启动就绪后的发现预算；正常 session 重连也计入，最多再补一次发现。 */
export class PreviewDiscoveryBudget {
  private key = "";
  private used = 0;
  private seed?: IdentityConnectionResult;

  observe(key: string, seed: IdentityConnectionResult, generation: number, connection: string): "discover" | "check" | "wait" {
    if (key !== this.key) {
      this.key = key; this.seed = seed; this.used = seed.sourceReconnected ? 1 : 0;
    }
    if (!this.used && generation > this.seed!.connectionGeneration && ["connecting", "connected"].includes(connection)) this.used = 1;
    if (!this.used) return "discover";
    if (this.used === 1 && connection === "connected") { this.used = 2; return "check"; }
    return "wait";
  }

  created() { if (!this.used) this.used = 1; }
  matches(key: string) { return this.key === key; }
  cancel() { this.used = 2; }
}

export const previewDiscoveryKey = (epoch: number, endpoint: string, session: string, job: string) =>
  JSON.stringify([epoch, new URL(endpoint).href, session, job]);
