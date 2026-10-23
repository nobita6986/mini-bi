import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
    if (specifier === "next/navigation") {
      return nextResolve("next/navigation.js", context);
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
  bindNotifyTimerScheduler,
  createNotifyStore,
  resolveSafeNotifyAction,
  TOAST_ENTER_DURATION_MS,
  TOAST_EXIT_DURATION_MS,
} = await import("./notify-store.ts");

const { ToastViewport, executeToastActionClick } = await import("./toast.tsx");

function createFakeClock({ reducedMotion = false } = {}) {
  let currentTime = 0;
  let nextTimerId = 1;
  const reduced = reducedMotion;
  const timers = new Map();

  return {
    now: () => currentTime,
    setTimeout(cb, delayMs) {
      const id = nextTimerId++;
      const runAt = currentTime + Math.max(0, Number(delayMs) || 0);
      timers.set(id, { id, runAt, cb });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    prefersReducedMotion: () => reduced,
    advanceBy(ms) {
      const targetTime = currentTime + Math.max(0, ms);
      while (true) {
        let earliest = null;
        for (const entry of timers.values()) {
          if (entry.runAt <= targetTime) {
            if (
              !earliest ||
              entry.runAt < earliest.runAt ||
              (entry.runAt === earliest.runAt && entry.id < earliest.id)
            ) {
              earliest = entry;
            }
          }
        }
        if (!earliest) break;
        timers.delete(earliest.id);
        currentTime = earliest.runAt;
        earliest.cb();
      }
      currentTime = targetTime;
    },
  };
}

function renderViewportHtml(store) {
  return renderToStaticMarkup(
    createElement(ToastViewport, {
      items: store.getSnapshot().visible,
      onDismiss: store.dismiss,
    }),
  );
}

describe("UIUX-S2-05 — Advanced Toast Lifecycle, Business-Scoped Burst Grouping & Safe Retry Guard", () => {
  it("supports in-place pending -> success and pending -> error lifecycle updates without premature auto-dismiss or repeat inflation", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    const exportId = store.api.pending({
      title: "Đang xuất danh sách người lao động…",
      dedupeKey: "worker-export:active",
      dataTestId: "toast-export",
    });

    const initialItem = store.getSnapshot().visible[0];
    assert.equal(initialItem.id, exportId);
    assert.equal(initialItem.pending, true);
    assert.equal(initialItem.deadlineAt, null);
    assert.equal(initialItem.repeatCount, 1);

    const pendingHtml = renderViewportHtml(store);
    assert.match(pendingHtml, /data-testid="toast-export"/);
    assert.match(pendingHtml, /data-toast-pending="true"/);
    assert.match(pendingHtml, /data-toast-spinner="true"/);
    assert.match(pendingHtml, /aria-busy="true"/);
    assert.doesNotMatch(pendingHtml, /data-toast-repeat-badge="true"/);

    // Even after 12 seconds in flight, pending Toast stays open
    clock.advanceBy(12000);
    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0].phase, "open");

    // Settle in-place to success -> schedules canonical 4000ms auto-dismiss and removes spinner
    const updatedOk = store.api.update(exportId, {
      tone: "success",
      title: "Đã tải danh sách người lao động (.xlsx).",
    });
    assert.equal(updatedOk, true);

    const settledItem = store.getSnapshot().visible[0];
    assert.equal(settledItem.id, exportId);
    assert.equal(settledItem.tone, "success");
    assert.equal(settledItem.pending, false);
    assert.equal(settledItem.repeatCount, 1);
    assert.equal(settledItem.deadlineAt, 16000);

    const settledHtml = renderViewportHtml(store);
    assert.doesNotMatch(settledHtml, /data-toast-pending="true"/);
    assert.doesNotMatch(settledHtml, /data-toast-spinner="true"/);
    assert.doesNotMatch(settledHtml, /data-toast-repeat-badge="true"/);

    clock.advanceBy(4000 + TOAST_EXIT_DURATION_MS);
    assert.equal(store.getSnapshot().visible.length, 0);

    // Verify pending -> error settles to persistent assertive alert and sanitizes PII
    const jobToastId = store.api.pending({
      title: "Đang xử lý tác vụ…",
      dataTestId: "toast-job",
    });
    clock.advanceBy(TOAST_ENTER_DURATION_MS + 1500);
    store.api.update(jobToastId, {
      tone: "error",
      title: "Lỗi xử lý hồ sơ CCCD 079123456789 của yêu cầu ddb57d17-1111-4222-8333-444455556666",
    });

    const errItem = store.getSnapshot().visible[0];
    assert.equal(errItem.pending, false);
    assert.equal(errItem.deadlineAt, null);
    assert.ok(!errItem.title.includes("079123456789"));
    assert.ok(errItem.title.includes("[đã ẩn]"));
    assert.ok(errItem.title.includes("ddb57d17"));
    assert.match(renderViewportHtml(store), /role="alert" aria-live="assertive"/);

    clock.advanceBy(30000);
    assert.equal(store.getSnapshot().visible.length, 1);

    detach();
  });

  it("never resurrects a Toast when update() arrives after session logout / clear()", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    const pendingId = store.api.pending({
      title: "Đang xuất dữ liệu phiên cũ…",
    });
    assert.equal(store.getSnapshot().visible.length, 1);

    // User logs out -> store.clear() runs immediately
    store.clear();
    assert.equal(store.getSnapshot().visible.length, 0);

    // Late async callback from previous session resolves after clear()
    const updatedAfterClear = store.api.update(pendingId, {
      tone: "success",
      title: "Đã xuất dữ liệu phiên cũ.",
    });
    assert.equal(updatedAfterClear, false);
    assert.equal(store.getSnapshot().visible.length, 0);
    assert.equal(store.getSnapshot().queue.length, 0);

    detach();
  });

  it("groups bursts strictly by matching business dedupeKey and never merges distinct operations with identical wording", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    // Two distinct approvals with identical text but different dedupeKeys (or no dedupeKey) must NOT merge
    const idReq1 = store.api.success({
      title: "Đã duyệt yêu cầu thay đổi.",
      dedupeKey: "cr-approve:req-1",
      dataTestId: "toast-req-1",
    });
    const idReq2 = store.api.success({
      title: "Đã duyệt yêu cầu thay đổi.",
      dedupeKey: "cr-approve:req-2",
      dataTestId: "toast-req-2",
    });
    assert.notEqual(idReq1, idReq2);
    assert.equal(store.getSnapshot().visible.length, 2);
    assert.equal(store.getSnapshot().visible[0].repeatCount, 1);
    assert.equal(store.getSnapshot().visible[1].repeatCount, 1);
    assert.doesNotMatch(renderViewportHtml(store), /data-toast-repeat-badge="true"/);

    // Burst of the exact same business operation (same dedupeKey) increments repeatCount and renders ×3 badge
    store.clear();
    store.api.warning({
      title: "Thao tác quá nhanh. Vui lòng chờ giây lát.",
      dedupeKey: "rate-limit:worker-export",
      dataTestId: "toast-burst",
    });
    clock.advanceBy(500);
    store.api.warning({
      title: "Thao tác quá nhanh. Vui lòng chờ giây lát.",
      dedupeKey: "rate-limit:worker-export",
      dataTestId: "toast-burst",
    });
    clock.advanceBy(500);
    store.api.warning({
      title: "Thao tác quá nhanh. Vui lòng chờ giây lát.",
      dedupeKey: "rate-limit:worker-export",
      dataTestId: "toast-burst",
    });

    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0].repeatCount, 3);
    const burstHtml = renderViewportHtml(store);
    assert.match(burstHtml, /data-toast-repeat-count="3"/);
    assert.match(burstHtml, /data-toast-repeat-badge="true"[^>]*>×3<\/span>/);

    detach();
  });

  it("enforces safe retry callback guards, one-flight click execution, validity checks, and rejects fake Undo actions", async () => {
    // 1. Fake Undo is rejected unconditionally (no backend Undo RPC)
    const fakeUndo = resolveSafeNotifyAction({
      kind: "undo",
      label: "Hoàn tác",
      onClick: () => {},
    });
    assert.equal(fakeUndo, undefined);

    // 2. Retry without safeToRetry: true is rejected
    const unsafeRetry = resolveSafeNotifyAction({
      kind: "retry",
      label: "Thử lại",
      onClick: () => {},
    });
    assert.equal(unsafeRetry, undefined);

    // 3. Retry with stale isValid() === false is rejected at creation time
    const staleAtCreate = resolveSafeNotifyAction({
      kind: "retry",
      safeToRetry: true,
      isValid: () => false,
      label: "Thử lại",
      onClick: () => {},
    });
    assert.equal(staleAtCreate, undefined);

    // 4. Valid safe retry renders in ToastViewport and executes with one-flight + runtime validity guard
    let validNow = true;
    let calls = 0;
    let releasePromise;
    const retryAction = resolveSafeNotifyAction({
      kind: "retry",
      safeToRetry: true,
      isValid: () => validNow,
      dismissOnAction: true,
      label: "Thử tải lại",
      dataTestId: "toast-retry-btn",
      onClick: () =>
        new Promise((resolve) => {
          calls += 1;
          releasePromise = resolve;
        }),
    });
    assert.ok(retryAction);

    const store = createNotifyStore();
    store.api.error({
      title: "Không tải được báo cáo.",
      action: retryAction,
      dataTestId: "toast-retry-card",
    });
    const html = renderViewportHtml(store);
    assert.match(html, /data-testid="toast-retry-btn"/);
    assert.match(html, /data-toast-action-kind="retry"/);

    // Simulate concurrent double-click -> second click is ignored while first is in flight
    let busy = false;
    let dismissedCount = 0;
    const firstClick = executeToastActionClick({
      action: retryAction,
      isBusy: () => busy,
      setBusy: (next) => {
        busy = next;
      },
      onDismiss: () => {
        dismissedCount += 1;
      },
    });
    const secondClickWhileBusy = await executeToastActionClick({
      action: retryAction,
      isBusy: () => busy,
      setBusy: (next) => {
        busy = next;
      },
      onDismiss: () => {
        dismissedCount += 1;
      },
    });
    assert.equal(secondClickWhileBusy, false);
    assert.equal(calls, 1);

    releasePromise();
    assert.equal(await firstClick, true);
    assert.equal(busy, false);
    assert.equal(dismissedCount, 1);

    // When callback becomes stale later (validNow = false), clicking dismisses Toast without invoking onClick
    validNow = false;
    const staleClick = await executeToastActionClick({
      action: retryAction,
      isBusy: () => busy,
      setBusy: (next) => {
        busy = next;
      },
      onDismiss: () => {
        dismissedCount += 1;
      },
    });
    assert.equal(staleClick, false);
    assert.equal(calls, 1);
    assert.equal(dismissedCount, 2);
  });

  it("never persists notification history or metadata to web storage and honors reduced-motion on pending spinner", () => {
    for (const rel of [
      "src/components/ui/notify-store.ts",
      "src/components/ui/notify-provider.tsx",
      "src/components/ui/toast.tsx",
    ]) {
      const src = readRel(rel);
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "document.cookie",
      ]) {
        assert.ok(!src.includes(forbidden), `${rel} must not reference ${forbidden}`);
      }
    }

    const toastSrc = readRel("src/components/ui/toast.tsx");
    assert.match(
      toastSrc,
      /data-toast-spinner="true"[\s\S]{0,180}motion-reduce:animate-none/,
      "Pending spinner must disable animation under prefers-reduced-motion",
    );
  });
});
