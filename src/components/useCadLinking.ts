import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCadLinkIndex, entitySegments, linkedWorldBounds, type CadLinkSelection, type CadPreviewSource } from "../cad/linking";
import type { DrawingModel } from "../cad/model";
import type { CadPreviewLink } from "./CadPreview";
import type { CloudFocusRequest } from "./PointCloudCanvas";

const NO_POINTS: number[] = [];
const NO_ENTITIES: string[] = [];

export function useCadLinking(source: CadPreviewSource | undefined, model: DrawingModel | undefined, enabled: boolean) {
  const [follow, setFollow] = useState(true);
  const [pinned, setPinned] = useState<CadLinkSelection>();
  const [hovered, setHovered] = useState<CadLinkSelection>();
  const [cloudFocus, setCloudFocus] = useState<CloudFocusRequest>();
  const [cadFocus, setCadFocus] = useState<CadPreviewLink["focusRequest"]>();
  const visibleIds = useRef<Set<string> | undefined>(undefined);
  const sequence = useRef(0);
  // 人工标注更新不改变几何或源快照，不重复构建空间索引。
  const index = useMemo(() => source && model && enabled && source.drawingId === model.drawingId
    ? createCadLinkIndex(source, model) : undefined, [source, model?.drawingId, enabled]);
  const clear = useCallback(() => {
    setPinned(undefined); setHovered(undefined); setCloudFocus(undefined); setCadFocus(undefined);
  }, []);
  useEffect(() => { clear(); }, [index, clear]);

  const filterSelection = useCallback((selection?: CadLinkSelection): CadLinkSelection | undefined => {
    if (!selection || !visibleIds.current) return selection;
    const ids = selection.entityIds.filter(id => visibleIds.current!.has(id));
    if (selection.origin === "cad" && !ids.length) return;
    return ids.length === selection.entityIds.length ? selection : { ...selection, entityIds: ids };
  }, []);
  const onVisibleEntitiesChange = useCallback((ids: string[]) => {
    visibleIds.current = new Set(ids);
    setPinned(current => filterSelection(current));
    setHovered(current => filterSelection(current));
  }, [filterSelection]);

  const moveToSelection = (selection: CadLinkSelection, fit: boolean) => {
    if (!source || !model || !enabled || !selection.pointIndices.length) return;
    const token = ++sequence.current;
    if (selection.origin === "cad" || fit) {
      const bounds = linkedWorldBounds(source, selection.pointIndices);
      if (bounds) setCloudFocus({ token, ...bounds, fit });
    }
    if ((selection.origin === "cloud" || fit) && selection.drawingPoint) {
      let radiusMm = index?.toleranceMm ?? 100;
      if (fit) for (const id of selection.entityIds) {
        const entity = model.entities.find(item => item.id === id);
        if (!entity) continue;
        for (const segment of entitySegments(entity)) for (const point of segment) radiusMm = Math.max(radiusMm, Math.hypot(point[0] - selection.drawingPoint[0], point[1] - selection.drawingPoint[1]));
      }
      setCadFocus({ token, point: selection.drawingPoint, radiusMm, fit });
    }
  };
  const select = (selection?: CadLinkSelection) => {
    setHovered(undefined);
    setPinned(selection);
    setCloudFocus(undefined); setCadFocus(undefined);
    if (follow && selection) moveToSelection(selection, false);
  };
  const effective = enabled ? hovered ?? pinned : undefined;
  const activePinned = enabled ? pinned : undefined;
  const cad: CadPreviewLink = {
    enabled: Boolean(index),
    highlightedIds: effective?.entityIds ?? NO_ENTITIES,
    pinnedId: activePinned?.entityIds[0],
    drawingPoint: effective?.origin === "cloud" ? effective.drawingPoint : undefined,
    focusRequest: enabled ? cadFocus : undefined,
    onHoverEntity: id => setHovered(filterSelection(id ? index?.forEntity(id) : undefined)),
    onSelectEntity: id => select(filterSelection(id ? index?.forEntity(id) : undefined)),
    onVisibleEntitiesChange,
  };
  const cloud = {
    enabled: Boolean(index),
    highlightedIndices: effective?.pointIndices ?? NO_POINTS,
    hovering: Boolean(enabled && hovered),
    onHoverPoint: (point?: number) => setHovered(filterSelection(point === undefined ? undefined : index?.forPoint(point))),
    onPickPoint: (point?: number) => select(filterSelection(point === undefined ? undefined : index?.forPoint(point))),
  };
  return {
    cad, cloud, cloudFocus: enabled ? cloudFocus : undefined,
    follow, setFollow: (value: boolean) => { setFollow(value); if (!value) { setCloudFocus(undefined); setCadFocus(undefined); } },
    clear, hasSelection: Boolean(enabled && (pinned || hovered)),
    canLocate: Boolean(activePinned?.pointIndices.length),
    locate: () => { if (activePinned) moveToSelection(activePinned, true); },
    status: effective?.message ?? "悬停查看关联，点击锁定；拖动浏览视图",
    kind: effective?.kind, pinned: Boolean(activePinned),
    sampleCount: index?.sampleCount ?? 0, toleranceMm: index?.toleranceMm ?? 0,
    enabled: Boolean(index),
  };
}

export type CadLinkController = ReturnType<typeof useCadLinking>;
