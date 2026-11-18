import { decodeProject, encodeProject, validateProjectState, type SurveyProject } from "./domain/project";
import { verifyPairedReview } from "./domain/pairedReview";
import type { OpenedInput } from "./domain/source";
import { saveFile } from "./platform";

/** 解码已打开的工程；原生读取失败时释放句柄，成功后由调用方接管。 */
export async function readOpenedProject(input: OpenedInput, canContinue: () => boolean = () => true): Promise<SurveyProject> {
  if (input.native && input.project) {
    let native = input.native;
    try { validateProjectState(input.project); }
    catch (error) { void window.surveyDesktop?.release(native.token); throw error; }

    const state = input.project as SurveyProject;
    try {
      if (state.pairedReview && !native.keyframePages?.length && window.surveyDesktop) {
        const pages = await window.surveyDesktop.addKeyframePage(native.token, state.pairedReview);
        if(!canContinue())throw Error("已取消打开工程。");
        native = { ...native, keyframePages: pages };
        state.activeKeyframePage = pages[0]!.id;
        state.pairedReviewIndex = await window.surveyDesktop.keyframeIndex(native.token);
        if(!canContinue())throw Error("已取消打开工程。");
      }
    } catch (error) {
      void window.surveyDesktop?.release(native.token);
      throw error;
    }

    const project: SurveyProject = {
      ...state,
      source: {
        name: native.name,
        native,
        units: state.source.units,
        synthetic: state.source.synthetic,
        clips: state.source.clips,
        deviceReceipt: state.source.deviceReceipt,
      },
    };
    try { if (project.pairedReview) await verifyPairedReview(project.pairedReview, project.source);if(!canContinue())throw Error("已取消打开工程。"); }
    catch (error) { void window.surveyDesktop?.release(native.token); throw error; }
    return project;
  }

  if (input.file && input.file.size > 256 * 1024 ** 2) throw Error("请在 Windows 应用中打开流式大工程。");
  const bytes = input.data ?? await input.file?.arrayBuffer();
  if (!bytes) throw Error("工程数据缺失。");
  const project=await decodeProject(bytes);if(!canContinue())throw Error("已取消打开工程。");return project;
}

/** 校验并保存工程快照；界面状态与任务生命周期仍由调用方管理。 */
export async function writeSurveyProject(project: SurveyProject, canSave: () => boolean = () => true): Promise<boolean> {
  const { source } = project;
  if (project.pairedReview) await verifyPairedReview(project.pairedReview, source);
  if(!canSave())return false;
  if (source.native && window.surveyDesktop) {
    const state = {
      source: {
        name: source.name,
        units: source.units,
        synthetic: source.synthetic,
        clips: source.clips ?? [],
        deviceReceipt: source.deviceReceipt,
      },
      pairedReview: project.pairedReview,
      activeKeyframePage: project.activeKeyframePage,
      building: project.building,
      accuracy: project.accuracy,
      renderScene: project.renderScene,
      drawing: project.drawing,
      drawingStale: project.drawingStale,
      annotations: project.annotations,
      projection: project.projection,
      settings: project.settings,
    };
    return (await window.surveyDesktop.saveProject(source.native.token, state)).saved;
  }

  const bytes = await encodeProject(project);
  return canSave()?saveFile("测量工程.pvplan", bytes):false;
}
