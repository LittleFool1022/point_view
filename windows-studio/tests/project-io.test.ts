import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurveyProject } from "../src/domain/project";
import type { SourceHandle } from "../src/domain/source";

const saveFileMock = vi.hoisted(() => vi.fn<(name: string, bytes: Uint8Array) => Promise<boolean>>());
vi.mock("../src/platform", () => ({ saveFile: saveFileMock }));

import { readOpenedProject, writeSurveyProject } from "../src/projectIo";

type Desktop = NonNullable<Window["surveyDesktop"]>;

afterEach(() => {
  saveFileMock.mockReset();
  vi.unstubAllGlobals();
});

describe("工程读写边界", () => {
  it("浏览器保存的 ZIP 可直接重新打开并保留工程内容", async () => {
    saveFileMock.mockResolvedValue(true);
    const sourceBytes = Uint8Array.from([1, 3, 5, 7, 11]).buffer;
    const project: SurveyProject = {
      source: { name: "room.pcd", bytes: sourceBytes, units: "m", synthetic: true },
      drawingStale: true,
      annotations: [],
      projection: "xy",
      settings: {},
    };

    await expect(writeSurveyProject(project)).resolves.toBe(true);
    const archive = saveFileMock.mock.calls[0]?.[1];
    expect(saveFileMock.mock.calls[0]?.[0]).toBe("测量工程.pvplan");
    expect(archive).toBeDefined();

    const restored = await readOpenedProject({ name: "测量工程.pvplan", data: archive!.slice().buffer as ArrayBuffer });
    expect(restored).toMatchObject({ drawingStale: true, annotations: [], projection: "xy", settings: {} });
    expect(restored.source).toMatchObject({ name: "room.pcd", units: "m", synthetic: true });
    expect(new Uint8Array(restored.source.bytes!)).toEqual(new Uint8Array(sourceBytes));
  });

  it("原生清单无效时释放 token，且不继续恢复关键帧", async () => {
    const native: SourceHandle = { token: "native-token", name: "room.pcd", size: 5, sha256: "a".repeat(64) };
    const release = vi.fn<Desktop["release"]>().mockResolvedValue(undefined);
    const addKeyframePage = vi.fn<Desktop["addKeyframePage"]>();
    const keyframeIndex = vi.fn<Desktop["keyframeIndex"]>();
    const desktop = { release, addKeyframePage, keyframeIndex } as unknown as Desktop;
    vi.stubGlobal("window", { surveyDesktop: desktop });

    await expect(readOpenedProject({ name: "broken.pvplan", native, project: { schema: "survey-project/3" } }))
      .rejects.toThrow("不是支持的测量工程");
    expect(release).toHaveBeenCalledExactlyOnceWith("native-token");
    expect(addKeyframePage).not.toHaveBeenCalled();
    expect(keyframeIndex).not.toHaveBeenCalled();
  });

  it("原生保存保留来源子字段、关键帧页和 drawingStale 映射", async () => {
    const native: SourceHandle = {
      token: "native-token",
      name: "room.pcd",
      size: 5,
      sha256: "a".repeat(64),
      keyframePages: [{ id: "page-2", fileName: "page-2.pvframes", bytes: 100, sha256: "b".repeat(64) }],
    };
    const deviceReceipt = {
      schema: "survey-device-receipt/1" as const,
      deviceOrigin: "scanner",
      session: "session-1",
      fileName: "room.pcd",
      bytes: 5,
      points: 1,
      sha256: native.sha256,
      receivedAt: "2026-01-01T00:00:00.000Z",
      desktopReceivedVerified: true as const,
      deviceBackupVerified: true,
      captureIntegrity: "passed" as const,
      qualityVerified: false as const,
    };
    const project: SurveyProject = {
      source: {
        name: native.name,
        native,
        units: "m",
        synthetic: false,
        clips: [{ axis: "z", rangeM: [0, 2], mode: "keep" }],
        deviceReceipt,
      },
      activeKeyframePage: "page-2",
      drawingStale: true,
      annotations: [],
      projection: "xz",
      settings: {},
    };
    const saveProject = vi.fn<Desktop["saveProject"]>().mockResolvedValue({ saved: true });
    vi.stubGlobal("window", { surveyDesktop: { saveProject } as unknown as Desktop });

    await expect(writeSurveyProject(project)).resolves.toBe(true);
    expect(saveProject).toHaveBeenCalledExactlyOnceWith("native-token", {
      source: {
        name: "room.pcd",
        units: "m",
        synthetic: false,
        clips: project.source.clips,
        deviceReceipt,
      },
      pairedReview: undefined,
      activeKeyframePage: "page-2",
      building: undefined,
      accuracy: undefined,
      renderScene: undefined,
      drawing: undefined,
      drawingStale: true,
      annotations: [],
      projection: "xz",
      settings: {},
    });
  });
});
