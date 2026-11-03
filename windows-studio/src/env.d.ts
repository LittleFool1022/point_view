interface Window {
  surveyDesktop?: {
    deviceProjects(origin: string): Promise<import("./domain/device").DeviceProject[]>;
    deviceReceive(origin: string, session: string): Promise<import("./domain/source").OpenedInput>;
    keyframePage(token: string, id: string): Promise<ArrayBuffer>;
    updateKeyframePage(token: string, id: string, review: import("./domain/pairedReview").PairedReview): Promise<import("./domain/source").KeyframePage>;
    addKeyframePage(token: string, review: import("./domain/pairedReview").PairedReview): Promise<import("./domain/source").KeyframePage[]>;
    clearKeyframePages(token: string): Promise<import("./domain/source").KeyframePage[]>;
    keyframeIndex(token: string): Promise<import("./domain/pairedReview").PairedFrameReference[]>;
    semanticAssets(): Promise<{model:ArrayBuffer;wasm:ArrayBuffer;metadata:unknown}>;
    open(kind: "cloud" | "project" | "frames"): Promise<import("./domain/source").OpenedInput | undefined>;
    renderPdf(document:{html:string;widthMm:number;heightMm:number}):Promise<ArrayBuffer>;
    save(name: string, data: ArrayBuffer): Promise<boolean>;
    read(token: string, offset: number, size: number): Promise<ArrayBuffer>;
    release(token: string): Promise<void>;
    saveProject(token: string, state: unknown): Promise<{ saved: boolean; bytes?: number; sha256?: string }>;
    cancel(): Promise<void>;
    onProgress(callback: (stage: string) => void): () => void;
  };
}
