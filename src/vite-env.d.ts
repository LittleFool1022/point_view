/// <reference types="vite/client" />

interface Window {
  pointViewDesktop?: {
    openFile(filters: Array<{ name: string; extensions: string[] }>): Promise<{ name: string; data: ArrayBuffer } | undefined>;
    openColmapDirectory(): Promise<Array<{ relativePath: string; data: ArrayBuffer }> | undefined>;
    saveFile(name: string, data: ArrayBuffer): Promise<boolean>;
    objectCapability(): Promise<{ available: boolean; reason?: string }>;
    reconstructObject(input: import("./creation/types").ReconstructionInput): Promise<import("./creation/types").ReconstructionOutput>;
    cancelObject(): Promise<void>;
    onObjectProgress(callback: (stage: string) => void): () => void;
  };
}
