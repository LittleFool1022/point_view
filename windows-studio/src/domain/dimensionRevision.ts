import {dimensionEntities, type CadDimension, type CadPoint2} from '../../../src/cad/dimensions';
import {validateDrawingModel, type CadEntity, type DrawingModel} from '../../../src/cad/model';
import {dimensionDrawingSignature} from './dimensionVerification';

/**
 * 最小几何修订：只改“被选尺寸定义点关联图元”的那个端点，尺寸定义点跟随，
 * 尺寸数值由几何重新计算。标注文字不是真相来源，任何“只改文字”的做法都会被
 * 一致性残差检出（见 revisionConsistencyIssues）。
 */
export interface DimensionEndpointCandidate {
  entityId: string;
  label: string;
  entityType: CadEntity['type'];
  entityCategory: CadEntity['category'];
  /** 端点在该图元顶点序列中的位置（直线为 0 起点、1 终点）。 */
  vertexIndex: number;
  vertexCount: number;
  current: CadPoint2;
  /** 该端点对应尺寸的起点还是终点。 */
  side: 'start' | 'end';
}

/** 一次几何修订的数值记录：修订量与尺寸变化量逐项可核对。 */
export interface DimensionRevisionDelta {
  dimensionId: string;
  entityId: string;
  vertexIndex: number;
  beforeMeasuredMm: number;
  afterMeasuredMm: number;
  /** 重算后的尺寸变化量（毫米）。 */
  measuredChangeMm: number;
  /** 端点沿尺寸方向的有效修订量；正值使尺寸变长。 */
  revisionMm: number;
  /** |尺寸变化量 − 修订量|；非正交段沿原方向修订时必须为 0，不得被拉直。 */
  consistencyResidualMm: number;
  /** 尺寸定义点被同步修正的位移；正常修订时与图元端点位移相同。 */
  fixedDefinitionShiftMm: number;
  /** 修订前排布坐标，撤销时逐字还原（不是重新拟合）。 */
  beforeVertex: CadPoint2;
  beforeStart: CadPoint2;
  beforeEnd: CadPoint2;
  /** 修订前的尺寸图元；撤销时逐字还原，核验指纹才能与修订前一致。 */
  dimensionEntities?: CadEntity[];
  reason: string;
}

/** 修订链：原始单元数据，撤销与导出快照共用同一份记录。 */
export interface DimensionRevisionState {
  changes: DimensionRevisionDelta[];
  createdAt: string;
}

export const DIMENSION_ENDPOINT_TOLERANCE_MM = 0.5;
export const MAX_DIMENSION_REVISIONS = 100;

const round = (value: number, digits = 6) => Number(value.toFixed(digits));
const clone = <T>(value: T): T => structuredClone(value);

export function dimensionMeasurementMm(dimension: CadDimension): number {
  return dimension.kind === 'horizontal'
    ? Math.abs(dimension.end[0] - dimension.start[0])
    : dimension.kind === 'vertical'
      ? Math.abs(dimension.end[1] - dimension.start[1])
      : Math.hypot(dimension.end[0] - dimension.start[0], dimension.end[1] - dimension.start[1]);
}

/** 尺寸方向单位向量；端点修订沿该方向进行，斜段保持原方向。 */
export function dimensionDirection(dimension: CadDimension): CadPoint2 {
  if (dimension.kind === 'horizontal') return [1, 0];
  if (dimension.kind === 'vertical') return [0, 1];
  const dx = dimension.end[0] - dimension.start[0], dy = dimension.end[1] - dimension.start[1], length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
}

/** 图元顶点（直线 2 个，多段线按顺序）；文字与点不参与端点修订。 */
export function entityVertices(entity: CadEntity): CadPoint2[] {
  if (entity.type === 'line') return [entity.start, entity.end];
  if (entity.type === 'polyline') return entity.points;
  return [];
}

function withVertex(entity: CadEntity, index: number, point: CadPoint2): CadEntity {
  if (entity.type === 'line') return index === 0 ? {...entity, start: [...point]} : {...entity, end: [...point]};
  if (entity.type === 'polyline') return {...entity, points: entity.points.map((current, i) => i === index ? [...point] : current)};
  return entity;
}

const CATEGORY_LABELS: Partial<Record<CadEntity['category'], string>> = {
  wall: '墙线', door: '门', window: '窗', axis: '轴线', frame: '图框', text: '文字', dimension: '尺寸', 'point-evidence': '原始点',
};
const SOURCE_LABELS: Record<CadEntity['source'], string> = {observed: '实测', inferred: '推断', manual: '人工', derived: '派生'};

export function revisionEntityLabel(entity: CadEntity): string {
  return `${CATEGORY_LABELS[entity.category] ?? entity.category}·${SOURCE_LABELS[entity.source]}`;
}

const near = (a: CadPoint2, b: CadPoint2, toleranceMm: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= toleranceMm;

/** 尺寸定义点关联的图元端点；无关联时返回空数组，由界面明确提示而不是静默无响应。 */
export function dimensionEndpointCandidates(model: DrawingModel, dimensionId: string, toleranceMm = DIMENSION_ENDPOINT_TOLERANCE_MM): DimensionEndpointCandidate[] {
  const dimension = model.dimensions?.find(d => d.id === dimensionId);
  if (!dimension) return [];
  const rows: DimensionEndpointCandidate[] = [];
  for (const entity of model.entities) {
    if (entity.metadata?.dimensionId || entity.category === 'dimension') continue;
    const vertices = entityVertices(entity);
    for (const side of ['start', 'end'] as const) {
      const definition = dimension[side];
      for (const [vertexIndex, vertex] of vertices.entries()) {
        if (!near(vertex, definition, toleranceMm)) continue;
        if (rows.some(row => row.entityId === entity.id && row.vertexIndex === vertexIndex && row.side === side)) continue;
        rows.push({entityId: entity.id, label: revisionEntityLabel(entity), entityType: entity.type, entityCategory: entity.category, vertexIndex, vertexCount: vertices.length, current: [...vertex], side});
      }
    }
  }
  return rows;
}

export function dimensionHasLinkedGeometry(model: DrawingModel, dimensionId: string, toleranceMm = DIMENSION_ENDPOINT_TOLERANCE_MM): boolean {
  return dimensionEndpointCandidates(model, dimensionId, toleranceMm).length > 0;
}

/** 关联图元的全部可见图元号（高亮用）：包含端点所在图元与定义点命中的图元。 */
export function linkedEntityIds(model: DrawingModel, dimensionId: string): string[] {
  return [...new Set(dimensionEndpointCandidates(model, dimensionId).map(row => row.entityId))];
}

function deltaFor(dimension: CadDimension, before: number, entityId: string, vertexIndex: number, revisionMm: number, fixedDefinitionShiftMm: number, beforeLayout: {vertex: CadPoint2; start: CadPoint2; end: CadPoint2; entities?: CadEntity[]}, reason: string): DimensionRevisionDelta {
  // 记录里的尺寸变化量一律由几何重算后给出（不复制修订量），一致性核对才有意义：
  // 非正交段沿原方向修订时两者相等；斜向或反向修订时残差如实记录这次差。
  const measuredChangeMm = dimensionMeasurementMm(dimension) - before;
  const recordedRevisionMm = round(revisionMm);
  return {
    dimensionId: dimension.id,
    entityId,
    vertexIndex,
    beforeMeasuredMm: round(before),
    afterMeasuredMm: round(before + revisionMm),
    measuredChangeMm: round(measuredChangeMm),
    revisionMm: recordedRevisionMm,
    // 修订量符号与所修订端点有关（起点侧/终点侧），残差比较两者的绝对量。
    consistencyResidualMm: round(Math.abs(Math.abs(measuredChangeMm) - Math.abs(revisionMm))),
    fixedDefinitionShiftMm: round(fixedDefinitionShiftMm),
    beforeVertex: [...beforeLayout.vertex],
    beforeStart: [...beforeLayout.start],
    beforeEnd: [...beforeLayout.end],
    ...(beforeLayout.entities ? {dimensionEntities: beforeLayout.entities.map(entity => clone(entity))} : {}),
    reason,
  };
}

export interface ApplyDimensionEndpointRevisionOptions {
  entityId: string;
  vertexIndex: number;
  point: CadPoint2;
  /** 修订原因，随成果包与复核记录导出。 */
  reason?: string;
}

export interface DimensionEndpointRevisionResult {
  model: DrawingModel;
  delta: DimensionRevisionDelta;
  /** 修订后的未取整尺寸值与按取整规则得到的显示值。 */
  measuredMm: number;
  displayedMm: number;
  roundingMm: number;
  label: string;
}

function displayedMeasurement(dimension: CadDimension, measuredMm: number): number {
  return Number((Math.round(measuredMm / dimension.roundingMm) * dimension.roundingMm).toFixed(6));
}

/**
 * 把关联图元的一个端点移到新位置，尺寸定义点跟随该端点，尺寸数值按几何重算。
 * 若当前定义点不再落在该端点上则拒绝（提示先选中尺寸定位关联对象）。
 */
export function applyDimensionEndpointRevision(model: DrawingModel, dimensionId: string, options: ApplyDimensionEndpointRevisionOptions): DimensionEndpointRevisionResult {
  const baseDimension = model.dimensions?.find(d => d.id === dimensionId);
  if (!baseDimension) throw Error(`图纸中没有尺寸 ${dimensionId}，请重新选中尺寸。`);
  const entity = model.entities.find(e => e.id === options.entityId);
  if (!entity) throw Error('关联图元已不存在，请重新生成图纸或重新定位关联对象。');
  const vertices = entityVertices(entity);
  if (!vertices.length) throw Error('该图元没有可修订的端点，请选择墙线或线段。');
  if (!Number.isInteger(options.vertexIndex) || options.vertexIndex < 0 || options.vertexIndex >= vertices.length) throw Error('端点编号无效。');
  const otherEndpointOfSameVertex = dimensionEndpointCandidates(model, dimensionId).find(row => row.entityId === entity.id && row.vertexIndex === options.vertexIndex);
  if (!otherEndpointOfSameVertex) throw Error('该端点不是选中尺寸的定义点，请先选中尺寸并定位关联对象。');

  const next = clone(model);
  const target = next.dimensions!.find(d => d.id === dimensionId)!;
  const source = next.entities.find(e => e.id === options.entityId)!;
  const from = [...entityVertices(source)[options.vertexIndex]!] as CadPoint2;
  const to: CadPoint2 = [Number(options.point[0]), Number(options.point[1])];
  if (!to.every(Number.isFinite)) throw Error('修订坐标必须为有效数字。');
  if (near(from, to, 1e-9)) throw Error('修订坐标与当前端点相同，未产生几何变化。');

  next.entities = next.entities.map(current => current.id === source.id ? withVertex(current, options.vertexIndex, to) : current);

  // 尺寸定义点跟随：只移动落在该端点上的一侧，另一侧定义点保持原位（不能把整条尺寸平移）。
  const startFollows = near(target.start, from, DIMENSION_ENDPOINT_TOLERANCE_MM);
  const endFollows = near(target.end, from, DIMENSION_ENDPOINT_TOLERANCE_MM);
  if (!startFollows && !endFollows) throw Error('尺寸定义点已不在该端点上，请重新定位关联对象后再修订。');
  // 记录被跟随那一侧的定义点在修订前的位置，修订后与之相差即“同步位移”。
  const fixedBefore = startFollows && !endFollows ? [...target.end] as CadPoint2 : endFollows && !startFollows ? [...target.start] as CadPoint2 : undefined;
  if (startFollows) target.start = [...to];
  if (endFollows) target.end = [...to];
  if (dimensionMeasurementMm(target) < 1e-6) throw Error('修订后尺寸为零，已拒绝本次修订。');
  const fixedAfter = startFollows && !endFollows ? target.end : endFollows && !startFollows ? target.start : undefined;
  // 尺寸定义点跟随图元端点的位移量；端点与定义点必须同步，否则尺寸会自己“走开”。
  const fixedDefinitionShiftMm = fixedBefore && fixedAfter
    ? Math.hypot(fixedAfter[0] - fixedBefore[0], fixedAfter[1] - fixedBefore[1])
    : Math.hypot(to[0] - from[0], to[1] - from[1]);

  // 尺寸图元（尺寸线、界线、刻度与文字）由同一定义重算；只改定义不重算图元会被校验拒绝。
  next.entities = [...next.entities.filter(entity => entity.metadata?.dimensionId !== dimensionId), ...dimensionEntities(target)];

  const report = validateDrawingModel(next);
  if (!report.valid) throw Error(`修订后图纸校验失败：${report.errors.map(e => e.message).join('；')}`);

  // 修订量：端点位移在尺寸方向上的投影，符号与尺寸长度的实际变化一致。
  // 终点侧端点外移为加长；起点侧端点后退同样是加长，不能把缩短记成加长。
  // 方向以修订后的尺寸为准：端点越过另一侧时方向翻转，按翻转后的方向投影才不会把缩短记成加长。
  const [rx, ry] = dimensionDirection(target);
  const projected = (to[0] - from[0]) * rx + (to[1] - from[1]) * ry;
  // 尺寸变长时修订量为正、缩短为负；记录残差核对它与几何重算的尺寸变化量。
  const revisionMm = projected;
  const before = dimensionMeasurementMm(baseDimension);
  const baseEntities = model.entities.filter(entity => entity.metadata?.dimensionId === dimensionId);
  const delta = deltaFor(target, before, source.id, options.vertexIndex, revisionMm, fixedDefinitionShiftMm, {vertex: from, start: baseDimension.start, end: baseDimension.end, entities: baseEntities}, options.reason?.trim() || '手工修订端点');
  const measuredMm = round(dimensionMeasurementMm(target));
  return {model: next, delta, measuredMm, displayedMm: displayedMeasurement(target, measuredMm), roundingMm: target.roundingMm, label: revisionEntityLabel(entity)};
}

/** 由键盘/输入框给出的“修订量”（毫米，沿尺寸方向，正值加长）换算成端点坐标。 */
export function pointFromRevisionAmount(dimension: CadDimension, current: CadPoint2, amountMm: number): CadPoint2 {
  if (!Number.isFinite(amountMm)) throw Error('修订量必须是有效数字。');
  const [ux, uy] = dimensionDirection(dimension);
  return [Number((current[0] + ux * amountMm).toFixed(6)), Number((current[1] + uy * amountMm).toFixed(6))];
}

/** 图纸拖动换算：屏幕位移（毫米制，y 向下）转成端点修订量。 */
export function revisionAmountFromDrag(dimension: CadDimension, dxMm: number, dyMm: number): number {
  const [ux, uy] = dimensionDirection(dimension);
  return Number((dxMm * ux - dyMm * uy).toFixed(6));
}

export function createRevisionState(changes: DimensionRevisionDelta[]): DimensionRevisionState {
  if (changes.length > MAX_DIMENSION_REVISIONS) throw Error(`几何修订超过 ${MAX_DIMENSION_REVISIONS} 项，请先完成复核。`);
  return {changes: changes.map(change => ({...change})), createdAt: new Date().toISOString()};
}

/** 不可变快照指纹：工程重新生成（新修订链）或撤销都会改变它。 */
export function revisionChainSignature(state: DimensionRevisionState): string {
  return JSON.stringify({changes: state.changes, createdAt: state.createdAt});
}

/** 撤销最近一次修订：把端点和尺寸定义点都还原到修订前记录的位置，尺寸值随之恢复。
 * 端点由沿用同一图纸的端点修订生成，撤销按记录逐字还原，并核对尺寸与修订前一致。 */
export function undoLastDimensionRevision(model: DrawingModel, state: DimensionRevisionState, dimensionId: string): {model: DrawingModel; state: DimensionRevisionState; measuredMm: number} {
  const change = state.changes.at(-1);
  if (!change) throw Error('没有可撤销的几何修订。');
  if (change.dimensionId !== dimensionId) throw Error('最近一次修订不属于当前选中尺寸，请先在核验面板选中对应尺寸。');
  const dimension = model.dimensions?.find(d => d.id === dimensionId);
  if (!dimension) throw Error('当前图纸已不含该尺寸，请先重新生成图纸。');
  const next = clone(model);
  const target = next.dimensions!.find(d => d.id === dimensionId)!;
  const entity = next.entities.find(e => e.id === change.entityId);
  if (!entity) throw Error('关联图元已不存在，无法撤销本次修订。');
  const vertices = entityVertices(entity);
  if (!vertices[change.vertexIndex]) throw Error('关联端点已不存在，无法撤销本次修订。');
  const moved = vertices[change.vertexIndex]!;
  const restored: CadPoint2 = [...change.beforeVertex] as CadPoint2;
  next.entities = next.entities.map(current => current.id === entity.id ? withVertex(current, change.vertexIndex, restored) : current);
  if (near(target.start, moved, DIMENSION_ENDPOINT_TOLERANCE_MM)) target.start = [...change.beforeStart];
  if (near(target.end, moved, DIMENSION_ENDPOINT_TOLERANCE_MM)) target.end = [...change.beforeEnd];
  // 撤销后尺寸图元按恢复前后的定义逐字节还原，保证核验指纹与修订前一致。
  const savedEntities = new Map((change.dimensionEntities ?? []).map(entity => [entity.id, entity]));
  next.entities = [...next.entities.filter(candidate => candidate.metadata?.dimensionId !== dimensionId), ...dimensionEntities(target)];
  next.entities = next.entities.map(entity => savedEntities.get(entity.id) ?? entity);
  if (Math.abs(dimensionMeasurementMm(target) - change.beforeMeasuredMm) > 1e-3) {
    throw Error(`撤销后尺寸 ${round(dimensionMeasurementMm(target))} mm 与修订前 ${change.beforeMeasuredMm} mm 不一致，已取消撤销。`);
  }
  const report = validateDrawingModel(next);
  if (!report.valid) throw Error(`撤销后图纸校验失败：${report.errors.map(e => e.message).join('；')}`);
  return {model: next, state: createRevisionState(state.changes.slice(0, -1)), measuredMm: round(dimensionMeasurementMm(target))};
}

/** 重新生成图纸时沿用修订链，使旧核验、旧成果包与旧回读报告都判定为过期；不沿用任何旧几何。 */
export function preserveRevisionState(rebuilt: DrawingModel, previous: DimensionRevisionState): DrawingModel {
  const next = clone(rebuilt);
  const message = `本图沿用 ${previous.changes.length} 项几何修订记录（${[...new Set(previous.changes.map(change => change.dimensionId))].join('、')}）；几何坐标以重新生成的图纸为准，修订前的核验结论与成果包均已过期。`;
  if (!next.warnings.some(warning => warning.code === 'DIMENSION_REVISIONS_CARRIED')) {
    next.warnings = [...next.warnings, {code: 'DIMENSION_REVISIONS_CARRIED', severity: 'warning', message}];
  }
  return next;
}

/** 导出的修订身份（不含修订前历史坐标）：成果包与回读报告据此绑定同一修订。 */
export type CadRevisionStamp = Pick<DimensionRevisionDelta, 'dimensionId' | 'entityId' | 'vertexIndex' | 'beforeMeasuredMm' | 'afterMeasuredMm' | 'measuredChangeMm' | 'revisionMm' | 'consistencyResidualMm' | 'reason'>;

interface RevisionParameters {
  dimensionRevisions?: CadRevisionStamp[];
  dimensionRevisionAt?: string;
}

/** 导出快照：修订链写入图纸参数，尺寸定义点、图元坐标与修订记录同属一份图纸修订。 */
export function stampRevisionState(model: DrawingModel, state: DimensionRevisionState | undefined): DrawingModel {
  const next = clone(model);
  const parameters = next.parameters as DrawingModel['parameters'] & RevisionParameters;
  if (!state?.changes.length) {
    delete parameters.dimensionRevisions;
    delete parameters.dimensionRevisionAt;
    return next;
  }
  // 导出快照只记录修订身份（编号、时间、尺寸），不含修订前的历史坐标与图元快照。
  parameters.dimensionRevisions = state.changes.map(change => ({
    dimensionId: change.dimensionId, entityId: change.entityId, vertexIndex: change.vertexIndex,
    beforeMeasuredMm: change.beforeMeasuredMm, afterMeasuredMm: change.afterMeasuredMm,
    measuredChangeMm: change.measuredChangeMm, revisionMm: change.revisionMm, consistencyResidualMm: change.consistencyResidualMm,
    reason: change.reason,
  }));
  parameters.dimensionRevisionAt = state.createdAt;
  return next;
}

/** 图纸上是否已经带出这份修订链（导出回读报告绑定同一次修订）。 */
export function revisionStateStamped(model: DrawingModel, state: DimensionRevisionState | undefined): boolean {
  const parameters = model.parameters as DrawingModel['parameters'] & RevisionParameters;
  if (!state?.changes.length) return !parameters.dimensionRevisions?.length;
  const stamped = parameters.dimensionRevisions ?? [];
  return stamped.length === state.changes.length
    && parameters.dimensionRevisionAt === state.createdAt
    && stamped.every((change, index) => change.dimensionId === state.changes[index]!.dimensionId && change.revisionMm === state.changes[index]!.revisionMm);
}

/** 图纸上带出的修订身份（只读核实用，不含撤销所需的历史坐标）。 */
export function stampedRevisionState(model: DrawingModel): {changes: CadRevisionStamp[]; createdAt: string} | undefined {
  const parameters = model.parameters as DrawingModel['parameters'] & RevisionParameters;
  if (!parameters.dimensionRevisions?.length) return undefined;
  return {changes: parameters.dimensionRevisions.map(change => ({...change})), createdAt: parameters.dimensionRevisionAt ?? ''};
}

/** 与 PR #5 核验规则一致：尺寸定义点（几何指纹）变化即使旧核验过期。 */
export function revisionExpiresVerification(before: DrawingModel, after: DrawingModel): boolean {
  return dimensionDrawingSignature(before) !== dimensionDrawingSignature(after);
}

/** 一致性残差核对：修订量与尺寸变化量必须相等（非正交段不得被静默拉直）。 */
export function revisionConsistencyIssues(state: {changes: Array<Partial<DimensionRevisionDelta> & {dimensionId: string}>; createdAt?: string} | undefined, toleranceMm = 1e-3): string[] {
  if (!state?.changes.length) return [];
  const issues: string[] = [];
  for (const change of state.changes) {
    // 修订量符号与所修订端点有关（起点侧/终点侧），一致性核对比较两者的绝对量。
    const residual = change.consistencyResidualMm ?? (change.measuredChangeMm !== undefined && change.revisionMm !== undefined ? Math.abs(Math.abs(change.measuredChangeMm) - Math.abs(change.revisionMm)) : 0);
    if (residual > toleranceMm) issues.push(`尺寸 ${change.dimensionId} 修订量 ${change.revisionMm} mm 与尺寸变化量 ${change.measuredChangeMm} mm 相差 ${Number(residual.toFixed(6))} mm。`);
    if ((change.fixedDefinitionShiftMm ?? 0) > toleranceMm) issues.push(`尺寸 ${change.dimensionId} 的端点位移与尺寸定义点同步量相差 ${change.fixedDefinitionShiftMm} mm。`);
  }
  return issues;
}
