/**
 * P1.5-W05-S01-R2 — Controller THUẦN cho UI báo cáo AI (state machine + polling có cancellation).
 *
 * - Mỗi startPolling có generation token + AbortController riêng.
 * - stopPolling invalidate generation, abort request đang bay, clear timer.
 * - Response của poll cũ (gen lệch) TUYỆT ĐỐI không cập nhật state, không đặt timer mới,
 *   không ghi đè job vừa chọn.
 */

import {
  isActiveJobStatus,
  projectCapabilityResponse,
  projectEnqueueResponse,
  projectUiReportResponse,
  type CapabilityView,
  type UiReportView,
} from "./report-contract.ts";

export type FetchResult =
  | { ok: true; httpStatus: number; code: string; record: unknown }
  | { ok: false; httpStatus: number; code: string; message: string };

export type FetchJson = (path: string, options: { method: "GET" | "POST"; body?: Record<string, unknown>; signal?: AbortSignal }) => Promise<FetchResult>;

export type Scheduler = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

const defaultScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type ReportControllerEvents = {
  onCapability: (capability: CapabilityView | null, error: string | null) => void;
  onJob: (jobId: string, view: UiReportView | null, error: string | null) => void;
};

export const CAPABILITY_PATH = "/api/ai/reports/capability";
export const REPORTS_PATH = "/api/ai/reports";

export function analysisPath(jobId: string): string {
  return REPORTS_PATH + "/" + encodeURIComponent(jobId) + "/analysis";
}

export function createReportController(options: {
  fetchJson: FetchJson;
  schedule?: Scheduler;
  interval_ms?: number;
  events: ReportControllerEvents;
}) {
  const { fetchJson, events } = options;
  const schedule = options.schedule ?? defaultScheduler;
  const intervalMs = options.interval_ms ?? 2000;
  let generation = 0;
  let activeController: AbortController | null = null;
  let timerHandle: unknown = null;

  function clearTimer() {
    if (timerHandle !== null) { schedule.clear(timerHandle); timerHandle = null; }
  }

  function abortActive() {
    if (activeController) { activeController.abort(); activeController = null; }
  }

  async function loadCapability(): Promise<void> {
    const result = await fetchJson(CAPABILITY_PATH, { method: "GET" });
    if (!result.ok) {
      events.onCapability({ ai_enabled: false, config_ready: false, review: { approve: false, reject: false, regenerate: false, reason: result.code } }, result.message);
      return;
    }
    const projected = projectCapabilityResponse(result.record);
    if (!projected.ok) {
      events.onCapability({ ai_enabled: false, config_ready: false, review: { approve: false, reject: false, regenerate: false, reason: projected.code } }, projected.message);
      return;
    }
    events.onCapability(projected.capability, null);
  }

  async function enqueue(body: Record<string, unknown>): Promise<{ ok: true; jobId: string; status: string } | { ok: false; message: string }> {
    const result = await fetchJson(REPORTS_PATH, { method: "POST", body });
    if (!result.ok) return { ok: false, message: result.message };
    const projected = projectEnqueueResponse(result.record);
    if (!projected.ok) return { ok: false, message: projected.message };
    startPolling(projected.view.job_id);
    return { ok: true, jobId: projected.view.job_id, status: projected.view.status };
  }

  function startPolling(id: string): void {
    stopPolling();
    const gen = generation;
    const controller = new AbortController();
    activeController = controller;

    const loop = async () => {
      if (gen !== generation) return;
      const result = await fetchJson(analysisPath(id), { method: "GET", signal: controller.signal });
      if (gen !== generation || controller.signal.aborted) return;
      if (!result.ok) {
        if (gen !== generation) return;
        events.onJob(id, null, result.message);
        return;
      }
      const projected = projectUiReportResponse(result.record);
      if (gen !== generation) return;
      if (!projected.ok) { events.onJob(id, null, projected.message); return; }
      events.onJob(id, projected.view, null);
      const status = projected.view.status;
      if (status === "draft" || !isActiveJobStatus(status)) return;
      if (gen !== generation) return;
      timerHandle = schedule.set(() => { void loop(); }, intervalMs);
    };

    timerHandle = schedule.set(() => { void loop(); }, 0);
  }

  function stopPolling(): void {
    generation += 1;
    abortActive();
    clearTimer();
  }

  return { loadCapability, enqueue, startPolling, stopPolling, _generation: () => generation };
}
