import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = process.cwd();
const readRel = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

function resolveCandidatePath(basePath) {
  for (const ext of ["", ".ts", ".tsx", ".js", ".mjs"]) {
    const candidate = basePath + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") {
      return nextResolve("next/link.js", context);
    }
    if (specifier.startsWith("@/")) {
      const resolved = resolveCandidatePath(path.join(ROOT, "src", specifier.slice(2)));
      if (resolved) {
        return nextResolve(pathToFileURL(resolved).href, context);
      }
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !context.parentURL.includes("/node_modules/") &&
      !context.parentURL.includes("\\node_modules\\")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const resolved = resolveCandidatePath(path.resolve(parentDir, specifier));
      if (resolved) {
        return nextResolve(pathToFileURL(resolved).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx") || url.endsWith(".ts")) {
      const source = readFileSync(new URL(url), "utf8");
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: url,
      });
      return { format: "module", shortCircuit: true, source: outputText };
    }
    return nextLoad(url, context);
  },
});

const {
  buildAiJobRecheckRetryAction,
  isIndeterminateAiJobRunning,
  settleTrackedJobToast,
  shouldShowAiJobProgress,
  startOrRetrackAiJobToast,
  validateDownloadableExportBlob,
  validateHtmlExportDocument,
} = await import("./long-running-feedback.ts");

const {
  MIN_XLSX_ZIP_BYTES,
  hasXlsxZipSignature,
  isUsableWorkerExportBlob,
  workerExportErrorMessage,
  WORKER_EXPORT_EMPTY_FILE_MESSAGE,
} = await import("../direct-entry/worker-export-ui-model.ts");

const { codeToMessage } = await import("../ai-report/report-contract.ts");
const { createReportController } = await import("../ai-report/report-controller.ts");
const { bindNotifyTimerScheduler, createNotifyStore } = await import(
  "../../components/ui/notify-store.ts"
);
const { executeToastActionClick } = await import("../../components/ui/toast.tsx");

describe("UIUX-S2-06 — Long-Running Operation Feedback, Indeterminate Progress & Usable File Verification", () => {
  it("rejects empty, corrupt binary, or error-payload HTTP 200 Blobs and only accepts genuine ZIP/XLSX export files", async () => {
    assert.equal(await isUsableWorkerExportBlob(null, null), false);
    assert.equal(await isUsableWorkerExportBlob(new Blob([], { type: "" }), null), false);
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob(['{"error":"denied"}'], { type: "application/json" }),
        "application/json; charset=utf-8",
      ),
      false,
    );
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob(["<html><body>Error</body></html>"], { type: "text/html" }),
        "text/html",
      ),
      false,
    );
    // HTTP 200 with application/octet-stream carrying error text or arbitrary binary WITHOUT PK\x03\x04 ZIP header MUST be rejected
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob(['{"ok":false,"message":"Internal Server Error — padded beyond 30 bytes"}'], {
          type: "application/octet-stream",
        }),
        "application/octet-stream",
      ),
      false,
    );
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob([new Uint8Array(64).fill(0xff)], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
      false,
    );
    // Empty ZIP archive (PK\x05\x06) or truncated < 30B header is NOT a valid .xlsx
    const emptyZipBytes = new Uint8Array(40);
    emptyZipBytes.set([0x50, 0x4b, 0x05, 0x06], 0);
    assert.equal(hasXlsxZipSignature(emptyZipBytes), false);
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob([emptyZipBytes], { type: "application/octet-stream" }),
        "application/octet-stream",
      ),
      false,
    );
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
      false,
    );

    // Valid .xlsx ZIP Local File Header (PK\x03\x04 + >= MIN_XLSX_ZIP_BYTES)
    const validXlsxBytes = new Uint8Array(Math.max(64, MIN_XLSX_ZIP_BYTES));
    validXlsxBytes.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], 0);
    assert.equal(hasXlsxZipSignature(validXlsxBytes), true);
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob([validXlsxBytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
      true,
    );
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob([validXlsxBytes], { type: "application/octet-stream" }),
        "application/octet-stream",
      ),
      true,
    );
    assert.ok(WORKER_EXPORT_EMPTY_FILE_MESSAGE.includes("không hợp lệ hoặc rỗng"));

    // HTML offline report export validator
    assert.equal(validateHtmlExportDocument(""), false);
    assert.equal(validateHtmlExportDocument("<div>partial</div>"), false);
    const validHtml = "<!DOCTYPE html><html lang=\"vi\"><body><h1>Báo cáo</h1></body></html>";
    assert.equal(validateHtmlExportDocument(validHtml), true);
    assert.deepEqual(
      validateDownloadableExportBlob({
        blob: { size: validHtml.length, type: "text/html;charset=utf-8" },
        allowedMimeTypes: ["text/html"],
      }),
      { ok: true },
    );
    assert.deepEqual(
      validateDownloadableExportBlob({
        blob: { size: 0, type: "text/html;charset=utf-8" },
        allowedMimeTypes: ["text/html"],
      }),
      { ok: false, reason: "EMPTY_BLOB" },
    );
  });

  it("provides actionable error copy across network (0), auth (401/403), rate-limit (429), row-limit (422), and server (5xx)", () => {
    assert.match(workerExportErrorMessage(0, null), /kiểm tra kết nối mạng/i);
    assert.match(workerExportErrorMessage(401, null), /đăng nhập lại/i);
    assert.match(workerExportErrorMessage(403, null), /không có quyền/i);
    assert.match(workerExportErrorMessage(429, null), /chờ giây lát/i);
    assert.match(workerExportErrorMessage(422, { limit: 10000 }), /thu hẹp bộ lọc/i);
    assert.match(workerExportErrorMessage(503, null), /thử lại/i);
  });

  it("drives a single Toast through pending -> draft / failed_* for async AI report polling without duplicate notifications", () => {
    assert.equal(isIndeterminateAiJobRunning("requested"), true);
    assert.equal(isIndeterminateAiJobRunning("queued"), true);
    assert.equal(isIndeterminateAiJobRunning("computing"), true);
    assert.equal(isIndeterminateAiJobRunning("ai_generating"), true);
    assert.equal(isIndeterminateAiJobRunning("validating"), true);
    assert.equal(isIndeterminateAiJobRunning("draft"), false);
    assert.equal(isIndeterminateAiJobRunning("failed_provider_transient"), false);
    assert.equal(isIndeterminateAiJobRunning(null), false);

    // Progress bar stops immediately when pollState enters "error" even if last known status was "computing"
    assert.equal(shouldShowAiJobProgress("computing", "polling"), true);
    assert.equal(shouldShowAiJobProgress("computing", "error"), false);
    assert.equal(shouldShowAiJobProgress("computing", "idle"), false);
    assert.equal(shouldShowAiJobProgress("draft", "polling"), false);

    const store = createNotifyStore();
    const toastId = store.api.pending({
      title: "Đang tổng hợp báo cáo AI…",
      dedupeKey: "ai-report-job:job-101",
    });
    let tracker = { jobId: "job-101", toastId };

    // Polling while computing/ai_generating keeps the single Toast pending
    let step = settleTrackedJobToast({
      tracker,
      incomingJobId: "job-101",
      status: "ai_generating",
      errorCode: null,
      codeToText: (code) => codeToMessage(code).text,
      notify: store.api,
    });
    assert.equal(step.settled, false);
    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0].pending, true);

    // Unrelated history job poll never settles the active job's Toast
    step = settleTrackedJobToast({
      tracker: step.nextTracker,
      incomingJobId: "job-old-99",
      status: "draft",
      errorCode: null,
      codeToText: (code) => codeToMessage(code).text,
      notify: store.api,
    });
    assert.equal(step.settled, false);
    assert.equal(store.getSnapshot().visible[0].pending, true);

    // Terminal draft completion settles the exact same Toast in-place to success
    step = settleTrackedJobToast({
      tracker: step.nextTracker,
      incomingJobId: "job-101",
      status: "draft",
      errorCode: null,
      codeToText: (code) => codeToMessage(code).text,
      notify: store.api,
    });
    assert.equal(step.settled, true);
    assert.equal(step.nextTracker, null);
    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0].id, toastId);
    assert.equal(store.getSnapshot().visible[0].tone, "success");
    assert.equal(store.getSnapshot().visible[0].pending, false);
    assert.equal(store.getSnapshot().visible[0].title, "Báo cáo AI đã sẵn sàng.");

    // Terminal failure settles in-place to persistent error with mapped Vietnamese guidance
    store.clear();
    const failToastId = store.api.pending({
      title: "Đang tổng hợp báo cáo AI…",
      dedupeKey: "ai-report-job:job-102",
    });
    tracker = { jobId: "job-102", toastId: failToastId };
    const failedStep = settleTrackedJobToast({
      tracker,
      incomingJobId: "job-102",
      status: "failed_provider_transient",
      errorCode: "AI_RATE_LIMITED",
      codeToText: (code) => codeToMessage(code).text,
      notify: store.api,
    });
    assert.equal(failedStep.settled, true);
    assert.equal(failedStep.nextTracker, null);
    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0].tone, "error");
    assert.equal(store.getSnapshot().visible[0].pending, false);
    assert.equal(store.getSnapshot().visible[0].deadlineAt, null);
  });

  it("preserves the exact same Toast across pending -> transport error -> click retry -> pending -> terminal success without self-dismissing", async () => {
    let currentTime = 0;
    let nextTimerId = 1;
    const timers = new Map();
    const clock = {
      now: () => currentTime,
      setTimeout(cb, delayMs) {
        const id = nextTimerId++;
        timers.set(id, { id, runAt: currentTime + Math.max(0, Number(delayMs) || 0), cb });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
      prefersReducedMotion: () => false,
      advanceBy(ms) {
        const target = currentTime + ms;
        while (true) {
          let earliest = null;
          for (const t of timers.values()) {
            if (
              t.runAt <= target &&
              (!earliest || t.runAt < earliest.runAt || (t.runAt === earliest.runAt && t.id < earliest.id))
            ) {
              earliest = t;
            }
          }
          if (!earliest) break;
          timers.delete(earliest.id);
          currentTime = earliest.runAt;
          earliest.cb();
        }
        currentTime = target;
      },
    };

    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    const JOB_ID = "11111111-1111-4111-8111-111111111111";
    const REV_ID = "33333333-3333-4333-8333-333333333333";

    const pollQueue = [];
    const pollTasks = [];
    let tracker = null;
    let pollState = "idle";
    const mounted = true;

    const controller = createReportController({
      fetchJson: async () => {
        const nextResponse = pollQueue.shift();
        if (!nextResponse) {
          throw new Error("Unexpected poll request");
        }
        return nextResponse;
      },
      schedule: {
        set: (fn, ms) => {
          const task = { fn, ms, cancelled: false };
          pollTasks.push(task);
          return task;
        },
        clear: (task) => {
          if (task) task.cancelled = true;
        },
      },
      interval_ms: 2000,
      events: {
        onCapability: () => {},
        onJob: (id, view, err) => {
          if (err) {
            pollState = "error";
            const outcome = settleTrackedJobToast({
              tracker,
              incomingJobId: id,
              status: null,
              errorCode: null,
              transportError: err,
              retryAction: buildAiJobRecheckRetryAction({
                jobId: id,
                isMounted: () => mounted,
                onRecheck: (nextId) => {
                  pollState = "polling";
                  tracker = startOrRetrackAiJobToast({
                    currentTracker: tracker,
                    jobId: nextId,
                    title: "Đang kiểm tra lại tiến trình báo cáo AI…",
                    notify: store.api,
                  });
                  controller.startPolling(nextId);
                },
              }),
              codeToText: (code) => codeToMessage(code).text,
              notify: store.api,
            });
            tracker = outcome.nextTracker;
            return;
          }
          if (view) {
            pollState =
              view.status !== "draft" && isIndeterminateAiJobRunning(view.status)
                ? "polling"
                : "idle";
            const outcome = settleTrackedJobToast({
              tracker,
              incomingJobId: id,
              status: view.status,
              errorCode: view.error_code,
              codeToText: (code) => codeToMessage(code).text,
              notify: store.api,
            });
            tracker = outcome.nextTracker;
          }
        },
      },
    });

    async function flushNextScheduledPoll() {
      const idx = pollTasks.findIndex((t) => !t.cancelled);
      assert.notEqual(idx, -1, "Expected a scheduled poll task");
      const [task] = pollTasks.splice(idx, 1);
      await task.fn();
    }

    // 1. Start job -> single pending Toast created
    pollState = "polling";
    tracker = startOrRetrackAiJobToast({
      currentTracker: null,
      jobId: JOB_ID,
      title: "Đang tổng hợp báo cáo AI…",
      notify: store.api,
    });
    const initialToastId = tracker.toastId;
    clock.advanceBy(250);
    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0].id, initialToastId);
    assert.equal(store.getSnapshot().visible[0].pending, true);
    assert.equal(store.getSnapshot().visible[0].phase, "open");

    // 2. First poll fails due to network error -> Toast becomes error with safe "Kiểm tra lại" retry action
    pollQueue.push({
      ok: false,
      httpStatus: 0,
      code: "AI_INTERNAL",
      message: "Không kết nối được tới server.",
    });
    controller.startPolling(JOB_ID);
    await flushNextScheduledPoll();

    assert.equal(pollState, "error");
    assert.equal(tracker, null);
    assert.equal(store.getSnapshot().visible.length, 1);
    const errorToast = store.getSnapshot().visible[0];
    assert.equal(errorToast.id, initialToastId);
    assert.equal(errorToast.tone, "error");
    assert.equal(errorToast.pending, false);
    assert.ok(errorToast.action, "Error Toast must carry retry action");
    assert.equal(errorToast.action.label, "Kiểm tra lại");
    assert.equal(errorToast.action.dismissOnAction, undefined);

    // 3. User clicks "Kiểm tra lại" through runtime executeToastActionClick (with real onDismiss wired to store.dismiss)
    let actionBusy = false;
    const executed = await executeToastActionClick({
      action: errorToast.action,
      isBusy: () => actionBusy,
      setBusy: (next) => {
        actionBusy = next;
      },
      onDismiss: () => store.dismiss(errorToast.id),
    });
    assert.equal(executed, true);

    // Advance past 160ms exit animation window to prove onDismiss was NOT invoked on the revived pending Toast
    clock.advanceBy(500);
    assert.equal(pollState, "polling");
    assert.ok(tracker, "Tracker must be restored after retry click");
    assert.equal(tracker.toastId, initialToastId);
    assert.equal(store.getSnapshot().visible.length, 1);
    const revivedPendingToast = store.getSnapshot().visible[0];
    assert.equal(revivedPendingToast.id, initialToastId);
    assert.equal(revivedPendingToast.tone, "info");
    assert.equal(revivedPendingToast.pending, true);
    assert.equal(revivedPendingToast.phase, "open");
    assert.equal(revivedPendingToast.action, undefined);
    assert.equal(revivedPendingToast.repeatCount, 1);

    // 4. Subsequent poll returns active computing, then terminal draft -> settles the EXACT SAME toastId to success
    pollQueue.push({
      ok: true,
      httpStatus: 200,
      code: "AI_INTERNAL",
      record: {
        ok: true,
        job_id: JOB_ID,
        status: "computing",
        error_code: null,
        attempts: 1,
        max_attempts: 3,
        revision: null,
        review_capability: {
          approve: false,
          reject: false,
          regenerate: false,
          reason: "review_rpc_unavailable",
        },
      },
    });
    await flushNextScheduledPoll();
    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0].id, initialToastId);
    assert.equal(store.getSnapshot().visible[0].pending, true);

    pollQueue.push({
      ok: true,
      httpStatus: 200,
      code: "AI_INTERNAL",
      record: {
        ok: true,
        job_id: JOB_ID,
        status: "draft",
        error_code: null,
        attempts: 1,
        max_attempts: 3,
        revision: {
          revision_id: REV_ID,
          revision_number: 1,
          lifecycle_status: "draft",
          contract_version: "business-analysis/0.1",
          created_at: "2026-10-02T00:00:00.000Z",
          analysis: {
            contract_version: "business-analysis/0.1",
            period_ref: "week:2026-W41",
            executive_analysis: "Tuyển dụng tuần này tăng nhẹ.",
            executive_evidence_refs: ["ev_01"],
            findings: [
              {
                finding_id: "f_01",
                category: "driver",
                subject_ref: "project_01",
                headline: "Dự án A dẫn đầu",
                analysis: "Dự án A tuyển 5 người.",
                evidence_refs: ["ev_02"],
                confidence: "medium",
                limitations: [],
                recommended_action: null,
              },
            ],
            overall_limitations: ["Chất lượng dữ liệu chưa đầy đủ ở một nguồn"],
          },
        },
        review_capability: {
          approve: false,
          reject: false,
          regenerate: false,
          reason: "review_rpc_unavailable",
        },
      },
    });
    await flushNextScheduledPoll();

    assert.equal(pollState, "idle");
    assert.equal(tracker, null);
    assert.equal(store.getSnapshot().visible.length, 1);
    const settledToast = store.getSnapshot().visible[0];
    assert.equal(settledToast.id, initialToastId);
    assert.equal(settledToast.tone, "success");
    assert.equal(settledToast.pending, false);
    assert.equal(settledToast.title, "Báo cáo AI đã sẵn sàng.");
    assert.equal(settledToast.action, undefined);

    detach();
  });

  it("uses strictly indeterminate <progress> indicators (zero fake percentages) and avoids duplicate button + Toast pending across export/upload/AI modules", () => {
    const workerOpsSrc = readRel("src/components/direct-entry/worker-operations.tsx");
    const aiPanelSrc = readRel("src/components/ai-report/ai-report-panel.tsx");
    const portraitSrc = readRel("src/components/direct-entry/worker-portrait-panel.tsx");

    // 1. Every <progress> tag in long-running surfaces must be indeterminate (no value= or max= fake percentage)
    for (const [label, src] of [
      ["worker-operations.tsx", workerOpsSrc],
      ["ai-report-panel.tsx", aiPanelSrc],
      ["worker-portrait-panel.tsx", portraitSrc],
    ]) {
      const progressTags = src.match(/<progress\b[^>]*>/g) ?? [];
      assert.ok(progressTags.length >= 1, `${label} should render indeterminate <progress>`);
      for (const tag of progressTags) {
        assert.doesNotMatch(
          tag,
          /\b(?:value|max)\s*=/,
          `${label} must not render fake percentage progress (${tag})`,
        );
      }
    }

    // 2. WorkerExportDialog validates Blob usability before downloadFile / onDone, and never fires duplicate notify.pending
    const exportDialogSlice = workerOpsSrc.slice(
      workerOpsSrc.indexOf("function WorkerExportDialog("),
    );
    assert.match(exportDialogSlice, /await isUsableWorkerExportBlob\(blob,\s*response\.headers\.get\("content-type"\)\)/);
    assert.doesNotMatch(
      exportDialogSlice,
      /notify\.pending\(/,
      "WorkerExportDialog must not duplicate its modal button/progress pending state with a second pending Toast",
    );

    // 3. AiReportPanel keeps background polling/Toast across drawer close, stops progress on poll error, wires runtime retry helpers without dismissOnAction, and validates HTML + Blob before download
    assert.match(aiPanelSrc, /notify\.pending\(/);
    assert.match(aiPanelSrc, /settleTrackedJobToast\(/);
    assert.match(aiPanelSrc, /startOrRetrackAiJobToast\(/);
    assert.match(aiPanelSrc, /buildAiJobRecheckRetryAction\(/);
    assert.doesNotMatch(aiPanelSrc, /dismissOnAction\s*:\s*true/);
    assert.match(aiPanelSrc, /shouldShowAiJobProgress\(jobStatus\?\.status,\s*pollState\)/);
    assert.match(aiPanelSrc, /Kiểm tra lại trạng thái/);
    assert.doesNotMatch(
      aiPanelSrc,
      /if\s*\(!open\)\s*getController\(\)\.stopPolling\(\)/,
      "Closing drawer must not abort active server-side AI report job polling",
    );
    assert.doesNotMatch(
      aiPanelSrc,
      /if\s*\(!open\s*&&\s*activeJobToastRef\.current\)/,
      "Closing drawer must not dismiss pending Toast while job is still running",
    );
    assert.match(aiPanelSrc, /validateHtmlExportDocument\(html\)/);
    assert.match(aiPanelSrc, /validateDownloadableExportBlob\(/);
  });
});
