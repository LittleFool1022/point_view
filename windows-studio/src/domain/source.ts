export interface KeyframePage { id: string; fileName: string; bytes: number; sha256: string; originalSha256?: string }
export interface SourceHandle { token: string; name: string; size: number; sha256: string; keyframePages?: KeyframePage[] }
export interface SourceInput { name: string; key?: string; bytes?: ArrayBuffer; file?: File; native?: SourceHandle; deviceReceipt?: import("./device").DeviceReceipt }
export interface OpenedInput { name: string; data?: ArrayBuffer; file?: File; native?: SourceHandle; project?: unknown; deviceReceipt?: import("./device").DeviceReceipt }
export const sourceSize = (source: SourceInput) => source.native?.size ?? source.file?.size ?? source.bytes?.byteLength ?? 0;
export const MAX_SOURCE_BYTES = 2 * 1024 ** 3;
export const PREVIEW_POINTS = 120_000;
