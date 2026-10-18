"use client";

/**
 * W2S1 - Controller DUNG CHUNG cho portrait staging.
 *
 * Dung cho ca ba be mat tao NLD dang duoc render:
 *  - bang dan Excel (`DirectEntryWorkerProfilePasteDialog`),
 *  - bang nhap truc tiep (luu nhieu dong),
 *  - quick-add / quick editor (luu mot dong).
 *
 * Moi be mat chi can cung cap `rowBindings` (khoa dong -> chu ky noi dung dong) va render slot
 * tu `slots`. Toan bo vong doi (stage -> bind -> cancel/recovery -> cleanup) nam trong reducer
 * thuan + hook nay, KHONG duoc viet lai o tung be mat.
 *
 * `bindableStageIds` la nguon DUY NHAT de dua `portrait_stage_id` vao payload batch.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  EMPTY_PORTRAIT_STAGE_LIFECYCLE,
  PORTRAIT_STAGE_ORPHAN_MESSAGE,
  cancelWorkerPortraitStage,
  portraitStageErrorMessage,
  reducePortraitStageLifecycle,
  selectBindablePortraitStages,
  selectOrphanPortraitStages,
  selectStalePortraitStages,
  stageWorkerPortrait,
  type PortraitStageAction,
  type PortraitStageCancelResult,
  type PortraitStageLifecycle,
  type PortraitStageSlot,
} from "@/lib/direct-entry/worker-portrait-stage-client";

export type WorkerPortraitStagesController = {
  /** Slot theo khoa dong (chi de hien thi). */
  slots: ReadonlyMap<string, PortraitStageSlot>;
  /** Stage_id duoc phep gui, theo khoa dong; da loc theo binding hien tai. */
  bindableStageIds: ReadonlyMap<string, string>;
  /** So stage da tao nhung chua don duoc (slot stale + orphan). */
  staleCount: number;
  /** Thong bao gan nhat cho viec stage/huy/don. */
  message: string;
  stage(rowKey: string, file: File): void;
  cancel(rowKey: string, stageId: string): void;
  /** Vo hieu hoa toan bo binding hien tai (doi du lieu / dong hop thoai). */
  invalidate(): void;
  /** Danh dau mot stage da o trang thai cuoi (da gan / da huy) de bo khoi state. */
  settle(rowKey: string, stageId: string): void;
  /** Thu don lai cac stage chua huy duoc. */
  retryCleanup(): void;
  clearMessage(): void;
};

export function useWorkerPortraitStages(input: {
  rowBindings: ReadonlyMap<string, string>;
  fetchImpl?: typeof fetch;
}): WorkerPortraitStagesController {
  const fetchImpl = input.fetchImpl ?? fetch;
  const rowBindings = input.rowBindings;
  const [state, setState] = useState<PortraitStageLifecycle>(EMPTY_PORTRAIT_STAGE_LIFECYCLE);
  const [message, setMessage] = useState("");
  const [cleanupNonce, setCleanupNonce] = useState(0);

  const dispatch = useCallback((action: PortraitStageAction) => {
    setState((current) => reducePortraitStageLifecycle(current, action));
  }, []);

  const slots = state.slots;
  const bindableStageIds = useMemo(
    () => selectBindablePortraitStages({ rowBindings, slots }),
    [rowBindings, slots],
  );
  const staleStages = useMemo(
    () => selectStalePortraitStages({ rowBindings, slots }),
    [rowBindings, slots],
  );
  const orphanStages = useMemo(() => selectOrphanPortraitStages(state), [state]);

  /** Huy stage; CHI xoa khoi state khi huy duoc hoac da xac dinh trang thai cuoi. */
  const cancelStage = useCallback(async (
    rowKey: string,
    stageId: string,
  ): Promise<PortraitStageCancelResult> => {
    const result = await cancelWorkerPortraitStage({ stageId, fetchImpl });
    dispatch({
      kind: "cancel-result",
      rowKey,
      stageId,
      confirmed: result.kind === "cancelled" || result.kind === "not-cancellable",
    });
    return result;
  }, [dispatch, fetchImpl]);

  // Don slot stale + orphan (async; khong setState dong bo trong effect).
  useEffect(() => {
    let active = true;
    void (async () => {
      for (const stale of staleStages) {
        if (!active) return;
        const result = await cancelStage(stale.rowKey, stale.stageId);
        if (!active) return;
        if (result.kind === "retry" || result.kind === "rejected") {
          setMessage(portraitStageErrorMessage(result.code));
        }
      }
      for (const orphan of orphanStages) {
        if (!active) return;
        const result = await cancelWorkerPortraitStage({ stageId: orphan.stageId, fetchImpl });
        if (!active) return;
        dispatch({
          kind: "orphan-cancel-result",
          stageId: orphan.stageId,
          confirmed: result.kind === "cancelled" || result.kind === "not-cancellable",
        });
        if (result.kind === "retry" || result.kind === "rejected") {
          setMessage(portraitStageErrorMessage(result.code));
        }
      }
    })();
    return () => { active = false; };
  }, [cancelStage, cleanupNonce, dispatch, fetchImpl, orphanStages, staleStages]);

  const stage = useCallback((rowKey: string, file: File) => {
    const binding = rowBindings.get(rowKey);
    if (binding === undefined) return;
    // Generation/request ID duy nhat cho MOI lan stage: response cu khong the ghi de upload moi.
    const requestId = crypto.randomUUID();
    setMessage("");
    dispatch({ kind: "stage-start", rowKey, binding, requestId });
    void stageWorkerPortrait({
      file,
      // Idempotency contract: key giu nguyen cho dung lan gui nay (retry dung lai cung key).
      idempotencyKey: crypto.randomUUID(),
      fetchImpl,
    }).then((result) => {
      dispatch({
        kind: "stage-result",
        rowKey,
        requestId,
        result: result.kind === "staged"
          ? { kind: "staged", stageId: result.stageId, sizeBytes: result.sizeBytes }
          : { kind: "error", code: result.code },
      });
      if (result.kind !== "staged") setMessage(portraitStageErrorMessage(result.code));
    });
  }, [dispatch, fetchImpl, rowBindings]);

  const cancel = useCallback((rowKey: string, stageId: string) => {
    setMessage("");
    void cancelStage(rowKey, stageId).then((result) => {
      setMessage(result.kind === "cancelled"
        ? PORTRAIT_STAGE_ORPHAN_MESSAGE
        : portraitStageErrorMessage(result.code));
    });
  }, [cancelStage]);

  const invalidate = useCallback(() => {
    dispatch({ kind: "invalidate" });
  }, [dispatch]);

  const settle = useCallback((rowKey: string, stageId: string) => {
    dispatch({ kind: "cancel-result", rowKey, stageId, confirmed: true });
  }, [dispatch]);

  const retryCleanup = useCallback(() => setCleanupNonce((value) => value + 1), []);
  const clearMessage = useCallback(() => setMessage(""), []);

  return {
    slots,
    bindableStageIds,
    staleCount: staleStages.length + orphanStages.length,
    message,
    stage,
    cancel,
    invalidate,
    settle,
    retryCleanup,
    clearMessage,
  };
}
