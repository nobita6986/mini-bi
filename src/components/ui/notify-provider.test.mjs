import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const ROOT = process.cwd();
const readRel = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") {
      return nextResolve("next/link.js", context);
    }
    if (specifier === "next/navigation") {
      return nextResolve("next/navigation.js", context);
    }
    if (specifier.startsWith("@/")) {
      const target = path.join(ROOT, "src", specifier.slice(2));
      for (const ext of ["", ".ts", ".tsx", ".js"]) {
        try {
          return nextResolve(pathToFileURL(target + ext).href, context);
        } catch {
          // continue searching extensions
        }
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
  DEFAULT_NOTIFY_DURATIONS,
  MAX_PENDING_TOASTS,
  MAX_VISIBLE_TOASTS,
  resolveNotifyDuration,
  sanitizeNotifyText,
  syncNotifyPathname,
  TOAST_ENTER_DURATION_MS,
  TOAST_EXIT_DURATION_MS,
} = await import("./notify-store.ts");

const { ToastViewport } = await import("./toast.tsx");
const { executeSessionLogout } = await import("../app-shell/user-session-control.tsx");

/**
 * Deterministic fake clock for testing per-Toast deadlines, enter/exit transitions,
 * queue promotions, and Strict Mode cleanup without real-time sleeps.
 */
function createFakeClock({ reducedMotion = false } = {}) {
  let currentTime = 0;
  let nextTimerId = 1;
  let reduced = reducedMotion;
  const timers = new Map();

  function now() {
    return currentTime;
  }

  function setTimer(cb, delayMs) {
    const id = nextTimerId++;
    const runAt = currentTime + Math.max(0, Number(delayMs) || 0);
    timers.set(id, { id, runAt, cb });
    return id;
  }

  function clearTimer(id) {
    timers.delete(id);
  }

  function advanceBy(ms) {
    const targetTime = currentTime + Math.max(0, ms);
    while (true) {
      let earliest = null;
      for (const entry of timers.values()) {
        if (entry.runAt <= targetTime) {
          if (!earliest || entry.runAt < earliest.runAt || (entry.runAt === earliest.runAt && entry.id < earliest.id)) {
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
  }

  return {
    now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    prefersReducedMotion: () => reduced,
    setReducedMotion: (next) => {
      reduced = Boolean(next);
    },
    advanceBy,
    activeTimerCount: () => timers.size,
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

describe("UIUX-S1-02 — Global NotifyProvider, Independent Timers, Enter/Exit Lifecycle, A11y & Logout Contract", () => {
  it("resolves canonical default durations for all 4 tones (success=4000, info=5000, warning=7000, error=null)", () => {
    assert.equal(DEFAULT_NOTIFY_DURATIONS.success, 4000);
    assert.equal(DEFAULT_NOTIFY_DURATIONS.info, 5000);
    assert.equal(DEFAULT_NOTIFY_DURATIONS.warning, 7000);
    assert.equal(DEFAULT_NOTIFY_DURATIONS.error, null);

    assert.equal(resolveNotifyDuration("success"), 4000);
    assert.equal(resolveNotifyDuration("info"), 5000);
    assert.equal(resolveNotifyDuration("warning"), 7000);
    assert.equal(resolveNotifyDuration("error"), null);

    assert.equal(resolveNotifyDuration("success", null), null);
    assert.equal(resolveNotifyDuration("error", 6000), 6000);
    assert.equal(resolveNotifyDuration("warning", 0), null);
  });

  it("renders all 4 tones in DOM with exact live-region semantics and without duplicate container aria-live (NT-14)", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    store.api.success({ title: "Lưu thành công", dataTestId: "t-success" });
    store.api.info({ title: "Đang xử lý", dataTestId: "t-info" });
    store.api.warning({ title: "Dữ liệu đã đổi", dataTestId: "t-warning" });

    const html1 = renderViewportHtml(store);
    // Viewport section must NOT declare aria-live or role=status/alert (prevents double announcement)
    assert.match(html1, /^<section aria-label="Thông báo hệ thống" data-testid="app-notify-viewport" data-ui-toast-viewport="true"/);
    const sectionOpenTag = html1.slice(0, html1.indexOf(">") + 1);
    assert.ok(!sectionOpenTag.includes("aria-live"), "Viewport container must not have aria-live");
    assert.ok(!sectionOpenTag.includes('role="status"'), "Viewport container must not have role=status");
    assert.ok(!sectionOpenTag.includes('role="alert"'), "Viewport container must not have role=alert");

    // Success and info use polite status; warning uses assertive alert
    assert.match(html1, /role="status" aria-live="polite" aria-atomic="true" data-testid="t-success" data-toast-tone="success" data-state="entering"/);
    assert.match(html1, /role="status" aria-live="polite" aria-atomic="true" data-testid="t-info" data-toast-tone="info" data-state="entering"/);
    assert.match(html1, /role="alert" aria-live="assertive" aria-atomic="true" data-testid="t-warning" data-toast-tone="warning" data-state="entering"/);

    // Clear and check error tone
    store.clear();
    store.api.error({ title: "Lỗi hệ thống", dataTestId: "t-error" });
    const html2 = renderViewportHtml(store);
    assert.match(html2, /role="alert" aria-live="assertive" aria-atomic="true" data-testid="t-error" data-toast-tone="error" data-state="entering"/);

    // Verify no autoFocus or focus-stealing tabIndex on toast cards
    assert.ok(!html2.includes("autofocus"), "Toast must never steal focus via autoFocus");
    assert.ok(!html2.includes("tabindex="), "Toast container must not set custom tabIndex");

    detach();
  });

  it("maintains independent auto-hide deadlines per Toast (adding Toast B at 3000ms never extends Toast A beyond 4000ms) and keeps error persistent", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    // 1. At t = 0: Create success A (4000ms deadline)
    const idA = store.api.success({ title: "Toast A", dataTestId: "toast-a" });
    assert.equal(store.getSnapshot().visible[0].phase, "entering");
    assert.equal(store.getSnapshot().visible[0].deadlineAt, 4000);

    // After 200ms (TOAST_ENTER_DURATION_MS): A transitions from entering -> open
    clock.advanceBy(TOAST_ENTER_DURATION_MS);
    assert.equal(clock.now(), 200);
    assert.equal(store.getSnapshot().visible[0].phase, "open");
    assert.match(renderViewportHtml(store), /data-testid="toast-a"[^>]*data-state="open"/);

    // 2. Advance 2800ms -> t = 3000ms
    clock.advanceBy(2800);
    assert.equal(clock.now(), 3000);

    // 3. At t = 3000ms: Create success B (4000ms -> deadline 7000ms) and persistent error E (deadline null)
    const idB = store.api.success({ title: "Toast B", dataTestId: "toast-b" });
    const idE = store.api.error({ title: "Toast Error", dataTestId: "toast-e" });

    assert.deepEqual(
      store.getSnapshot().visible.map((item) => ({ id: item.id, deadlineAt: item.deadlineAt })),
      [
        { id: idA, deadlineAt: 4000 },
        { id: idB, deadlineAt: 7000 },
        { id: idE, deadlineAt: null },
      ],
    );

    // 4. Advance 999ms -> t = 3999ms: A is still open
    clock.advanceBy(999);
    assert.equal(clock.now(), 3999);
    assert.equal(store.getSnapshot().visible.find((item) => item.id === idA)?.phase, "open");

    // Advance 1ms -> t = 4000ms (1000ms after B was added):
    // A hits its 4000ms deadline and enters the 160ms exiting state (still mounted in DOM during exit)
    clock.advanceBy(1);
    assert.equal(clock.now(), 4000);
    assert.equal(store.getSnapshot().visible.find((item) => item.id === idA)?.phase, "exiting");
    const htmlAt4000 = renderViewportHtml(store);
    assert.match(htmlAt4000, /data-testid="toast-a"[^>]*data-state="exiting"/);
    assert.match(htmlAt4000, /opacity-0 -translate-y-1 duration-\[var\(--ui-motion-toast-out,160ms\)\]/);

    // At t = 4159ms (159ms into exit): A is still in DOM completing exit
    clock.advanceBy(TOAST_EXIT_DURATION_MS - 1);
    assert.equal(clock.now(), 4159);
    assert.ok(store.getSnapshot().visible.some((item) => item.id === idA));

    // At t = 4160ms (after 160ms exit): A is completely removed from visible & DOM (did NOT survive an extra 4000ms!)
    clock.advanceBy(1);
    assert.equal(clock.now(), 4160);
    assert.ok(!store.getSnapshot().visible.some((item) => item.id === idA));
    assert.ok(!renderViewportHtml(store).includes("toast-a"));

    // 5. B keeps its own 7000ms deadline
    clock.advanceBy(2839);
    assert.equal(clock.now(), 6999);
    assert.equal(store.getSnapshot().visible.find((item) => item.id === idB)?.phase, "open");

    clock.advanceBy(1);
    assert.equal(clock.now(), 7000);
    assert.equal(store.getSnapshot().visible.find((item) => item.id === idB)?.phase, "exiting");

    clock.advanceBy(TOAST_EXIT_DURATION_MS);
    assert.equal(clock.now(), 7160);
    assert.ok(!store.getSnapshot().visible.some((item) => item.id === idB));

    // Persistent error E remains open indefinitely
    clock.advanceBy(60000);
    assert.deepEqual(
      store.getSnapshot().visible.map((item) => ({ id: item.id, phase: item.phase })),
      [{ id: idE, phase: "open" }],
    );

    detach();
  });

  it("uses the same 160ms exit transition before DOM removal on manual dismiss", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    const id = store.api.error({ title: "Không thể lưu hồ sơ", dataTestId: "manual-dismiss-toast" });
    clock.advanceBy(TOAST_ENTER_DURATION_MS);
    assert.equal(store.getSnapshot().visible[0].phase, "open");

    // User clicks manual dismiss button
    store.api.dismiss(id);

    // Immediately enters exiting state, DOM is still present
    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0].phase, "exiting");
    const exitingHtml = renderViewportHtml(store);
    assert.match(exitingHtml, /data-testid="manual-dismiss-toast"[^>]*data-state="exiting"/);

    // 159ms later: still mounted in DOM
    clock.advanceBy(TOAST_EXIT_DURATION_MS - 1);
    assert.equal(store.getSnapshot().visible.length, 1);

    // At 160ms: exit completes and DOM is removed
    clock.advanceBy(1);
    assert.equal(store.getSnapshot().visible.length, 0);
    assert.equal(renderViewportHtml(store), "");

    detach();
  });

  it("caps visible Toasts at 3, promotes queued Toasts FIFO after exit completes with fresh deadlines, and ignores stale dismiss callbacks", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    const id1 = store.api.success({ title: "Thông báo 1" });
    const id2 = store.api.info({ title: "Thông báo 2" });
    const id3 = store.api.warning({ title: "Thông báo 3" });
    const id4 = store.api.error({ title: "Thông báo 4" });
    const id5 = store.api.success({ title: "Thông báo 5" });

    assert.equal(store.getSnapshot().visible.length, MAX_VISIBLE_TOASTS);
    assert.deepEqual(store.getSnapshot().visible.map((item) => item.id), [id1, id2, id3]);
    assert.deepEqual(store.getSnapshot().queue.map((item) => item.id), [id4, id5]);

    clock.advanceBy(1000);

    // Manual dismiss of id1 starts 160ms exit; id4 stays queued until id1 finishes exiting
    store.api.dismiss(id1);
    assert.equal(store.getSnapshot().visible.find((item) => item.id === id1)?.phase, "exiting");
    assert.deepEqual(store.getSnapshot().queue.map((item) => item.id), [id4, id5]);

    // After 160ms (t = 1160): id1 is removed and id4 is promoted
    clock.advanceBy(TOAST_EXIT_DURATION_MS);
    assert.equal(clock.now(), 1160);
    assert.deepEqual(store.getSnapshot().visible.map((item) => item.id), [id2, id3, id4]);
    assert.deepEqual(store.getSnapshot().queue.map((item) => item.id), [id5]);

    // Dismissing id3 promotes id5 after 160ms (at t = 1320) with its own fresh 4000ms deadline (1320 + 4000 = 5320)
    store.api.dismiss(id3);
    clock.advanceBy(TOAST_EXIT_DURATION_MS);
    assert.equal(clock.now(), 1320);
    assert.deepEqual(store.getSnapshot().visible.map((item) => item.id), [id2, id4, id5]);
    assert.equal(store.getSnapshot().queue.length, 0);
    const promoted5 = store.getSnapshot().visible.find((item) => item.id === id5);
    assert.equal(promoted5?.visibleAt, 1320);
    assert.equal(promoted5?.deadlineAt, 5320);

    // Stale dismiss callback for already-removed id1 or wrong revision on id5 must not close id5, id2, or id4
    store.api.dismiss(id1);
    store.dismiss(id5, 999);
    store.finalizeDismiss(id5, 999);
    assert.deepEqual(store.getSnapshot().visible.map((item) => item.id), [id2, id4, id5]);

    detach();
  });

  it("enforces bounded pending queue (max 20) and prioritizes warning/error over success/info on overflow", () => {
    const store = createNotifyStore();
    for (let i = 1; i <= MAX_VISIBLE_TOASTS; i += 1) {
      store.api.success({ title: `Visible ${i}` });
    }
    store.api.success({ title: "Pending Low 1" });
    store.api.info({ title: "Pending Low 2" });
    for (let i = 3; i <= MAX_PENDING_TOASTS; i += 1) {
      store.api.warning({ title: `Pending Warn ${i}` });
    }
    assert.equal(store.getSnapshot().queue.length, MAX_PENDING_TOASTS);

    store.api.error({ title: "Critical Error Overflow" });
    const queueTitles = store.getSnapshot().queue.map((item) => item.title);
    assert.equal(queueTitles.length, MAX_PENDING_TOASTS);
    assert.ok(!queueTitles.includes("Pending Low 1"));
    assert.ok(queueTitles.includes("Critical Error Overflow"));
  });

  it("deduplicates by dedupeKey and resets only the updated Toast's deadline without affecting other Toasts (NT-08)", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    const firstId = store.api.success({
      title: "Đã duyệt yêu cầu ddb57d17.",
      dedupeKey: "cr-approve:ddb57d17",
    });
    clock.advanceBy(1000);
    const otherId = store.api.success({
      title: "Đã lưu ghi chú.",
      dedupeKey: "note-save",
    });

    // Advance to t = 2500ms and update the first Toast via same dedupeKey
    clock.advanceBy(1500);
    assert.equal(clock.now(), 2500);
    const secondId = store.api.success({
      title: "Đã duyệt yêu cầu thay đổi ddb57d17.",
      description: "Danh sách đã cập nhật.",
      dedupeKey: "cr-approve:ddb57d17",
    });

    assert.equal(firstId, secondId);
    assert.equal(store.getSnapshot().visible.length, 2);
    assert.equal(store.getSnapshot().visible[0].title, "Đã duyệt yêu cầu thay đổi ddb57d17.");
    assert.equal(store.getSnapshot().visible[0].description, "Danh sách đã cập nhật.");
    assert.equal(store.getSnapshot().visible[0].deadlineAt, 6500);
    assert.equal(store.getSnapshot().visible[1].deadlineAt, 5000);

    // At t = 4200ms (past firstId's initial 4000ms deadline): firstId is still open!
    clock.advanceBy(1700);
    assert.equal(clock.now(), 4200);
    assert.equal(store.getSnapshot().visible.find((item) => item.id === firstId)?.phase, "open");

    // At t = 5160ms: otherId (deadline 5000ms + 160ms exit) has been removed, while firstId is still open
    clock.advanceBy(960);
    assert.equal(clock.now(), 5160);
    assert.ok(!store.getSnapshot().visible.some((item) => item.id === otherId));
    assert.equal(store.getSnapshot().visible.find((item) => item.id === firstId)?.phase, "open");

    // At t = 6660ms (deadline 6500ms + 160ms exit): firstId is removed
    clock.advanceBy(1500);
    assert.equal(clock.now(), 6660);
    assert.equal(store.getSnapshot().visible.length, 0);

    detach();
  });

  it("preserves Toast lifecycle across child unmount and Strict Mode double-effect remount, and cleans up all timers on host unmount (NT-09)", () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);

    // Initial mount of NotifyProvider timer host
    let detach = bindNotifyTimerScheduler(store, clock);

    // Child component fires a Toast and then unmounts immediately
    function simulateChildActionAndUnmount() {
      const notify = store.api;
      notify.success({ title: "Đã rút yêu cầu thay đổi.", dataTestId: "child-toast" });
    }
    simulateChildActionAndUnmount();
    assert.equal(store.getSnapshot().visible.length, 1);

    // Advance 1500ms -> Simulate React Strict Mode effect unmount + remount
    clock.advanceBy(1500);
    detach();
    assert.equal(clock.activeTimerCount(), 0, "Unmounting timer host must clear all active timers");
    detach = bindNotifyTimerScheduler(store, clock);
    assert.equal(clock.activeTimerCount(), 1, "Remounting timer host schedules exactly 1 timer for the remaining deadline");

    // Advance remaining 2500ms (to t = 4000ms): Toast enters exiting right on original 4000ms deadline
    clock.advanceBy(2500);
    assert.equal(clock.now(), 4000);
    assert.equal(store.getSnapshot().visible[0]?.phase, "exiting");

    clock.advanceBy(TOAST_EXIT_DURATION_MS);
    assert.equal(store.getSnapshot().visible.length, 0);

    detach();
    assert.equal(clock.activeTimerCount(), 0);
  });

  it("skips enter/exit animations and removes DOM immediately without 160ms delay when prefers-reduced-motion is enabled (MO-07)", () => {
    const clock = createFakeClock({ reducedMotion: true });
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    const id1 = store.api.success({ title: "Reduced motion toast", dataTestId: "rm-toast" });
    // Starts directly in 'open' state with no 200ms enter timer
    assert.equal(store.getSnapshot().visible[0].phase, "open");
    assert.equal(store.getSnapshot().visible[0].enterDeadlineAt, null);
    assert.match(renderViewportHtml(store), /data-testid="rm-toast"[^>]*data-state="open"/);

    // Manual dismiss removes immediately at 0ms (no 160ms exiting phase)
    store.api.dismiss(id1);
    assert.equal(store.getSnapshot().visible.length, 0);
    assert.equal(renderViewportHtml(store), "");

    // Auto-dismiss also removes immediately at deadlineAt (t = 4000ms) with 0ms exit delay
    store.api.success({ title: "Reduced motion auto", dataTestId: "rm-auto" });
    clock.advanceBy(3999);
    assert.equal(store.getSnapshot().visible.length, 1);
    clock.advanceBy(1);
    assert.equal(store.getSnapshot().visible.length, 0);

    detach();
  });

  it("clears all visible and queued Toasts immediately when /api/auth/logout returns 204 before navigating to /login, and via /login pathname fallback (NT-10)", async () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    for (let i = 1; i <= 5; i += 1) {
      store.api.error({ title: `Thông báo phiên cũ ${i}` });
    }
    assert.equal(store.getSnapshot().visible.length, 3);
    assert.equal(store.getSnapshot().queue.length, 2);

    const callOrder = [];
    // 1. Failed logout (500) must NOT clear Toasts or navigate
    const failedOk = await executeSessionLogout({
      fetchImpl: async () => new Response(null, { status: 500 }),
      notify: {
        clear: () => {
          callOrder.push("clear");
          store.clear();
        },
      },
      router: {
        replace: (href) => callOrder.push(`replace:${href}`),
        refresh: () => callOrder.push("refresh"),
      },
    });
    assert.equal(failedOk, false);
    assert.equal(store.getSnapshot().visible.length, 3);
    assert.equal(callOrder.length, 0);

    // 2. Successful logout (204) clears Toasts BEFORE router.replace('/login')
    const successOk = await executeSessionLogout({
      fetchImpl: async () => new Response(null, { status: 204 }),
      notify: {
        clear: () => {
          callOrder.push("clear");
          store.clear();
        },
      },
      router: {
        replace: (href) => callOrder.push(`replace:${href}`),
        refresh: () => callOrder.push("refresh"),
      },
    });
    assert.equal(successOk, true);
    assert.deepEqual(callOrder, ["clear", "replace:/login", "refresh"]);
    assert.equal(store.getSnapshot().visible.length, 0);
    assert.equal(store.getSnapshot().queue.length, 0);
    assert.equal(renderViewportHtml(store), "");
    assert.equal(clock.activeTimerCount(), 0);

    // 3. Fallback when landing on /login (e.g. session expiry redirect)
    store.api.warning({ title: "Cảnh báo trước khi hết phiên" });
    assert.equal(store.getSnapshot().visible.length, 1);
    syncNotifyPathname(store, "/dashboard");
    assert.equal(store.getSnapshot().visible.length, 1);
    syncNotifyPathname(store, "/login");
    assert.equal(store.getSnapshot().visible.length, 0);

    detach();
  });

  it("sanitizes HTML tags, 12-digit CCCD, JWT tokens, and full UUIDs so PII or raw responses never leak into Toast text", () => {
    const raw =
      "<script>alert(1)</script> Lỗi xử lý CCCD 079123456789 cho yêu cầu ddb57d17-1111-4222-8333-444455556666 với token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const sanitized = sanitizeNotifyText(raw);

    assert.ok(!sanitized.includes("<script>"));
    assert.ok(!sanitized.includes("079123456789"), "must redact 12-digit CCCD");
    assert.ok(sanitized.includes("[đã ẩn]"));
    assert.ok(!sanitized.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "must redact JWT token");
    assert.ok(!sanitized.includes("ddb57d17-1111-4222-8333-444455556666"), "must shorten full UUID");
    assert.ok(sanitized.includes("ddb57d17"), "must preserve 8-char shortRef");
  });

  it("mounts a single NotifyProvider in RootLayout while keeping RootLayout and AppShell as Server Components (NT-14, MO-07, MO-08)", () => {
    const layoutSrc = readRel("src/app/layout.tsx");
    const appShellSrc = readRel("src/components/app-shell/app-shell.tsx");
    const providerSrc = readRel("src/components/ui/notify-provider.tsx");
    const storeSrc = readRel("src/components/ui/notify-store.ts");
    const toastSrc = readRel("src/components/ui/toast.tsx");

    assert.ok(!layoutSrc.includes('"use client"'), "RootLayout must remain a Server Component");
    assert.ok(!appShellSrc.includes('"use client"'), "AppShell must remain a Server Component");
    assert.match(layoutSrc, /<ThemeProvider>[\s\S]*<NotifyProvider>[\s\S]*<NuqsAdapter>/);

    assert.match(providerSrc, /<ToastViewport\s+items=\{snapshot\.visible\}\s+onDismiss=\{store\.dismiss\}\s*\/>/);
    assert.match(providerSrc, /bindNotifyTimerScheduler\(store\)/);
    assert.ok(!storeSrc.includes("from \"react\""), "notify-store.ts must not depend on React");
    assert.ok(!storeSrc.includes("renderNotifyViewportElement"), "notify-store.ts must not contain a shadow UI renderer");

    assert.match(toastSrc, /export function ToastViewport/);
    assert.match(toastSrc, /data-testid="app-notify-viewport"/);
    assert.match(toastSrc, /aria-label="Đóng thông báo"/);
    assert.match(toastSrc, /min-h-11\s+min-w-11/);
    assert.match(toastSrc, /motion-reduce:transition-none/);
    assert.match(toastSrc, /motion-reduce:transform-none/);
    assert.match(toastSrc, /motion-reduce:animate-none/);
    assert.ok(
      !toastSrc.includes("RadixToast.Provider"),
      "Toast item must not mount nested RadixToast.Provider per instance",
    );
  });

  it("enforces Chặng 1 Release Gate (UIUX-S1-08): motion tokens, reduced-motion, static Recharts, CSS chart guard, no new animation deps, and 24/24 completed action feedback inventory", () => {
    const globalsCss = readRel("src/app/globals.css");
    for (const token of [
      "--ui-motion-fast: 120ms;",
      "--ui-motion-hover: 160ms;",
      "--ui-motion-tab: 200ms;",
      "--ui-motion-reveal: 200ms;",
      "--ui-motion-toast-in: 200ms;",
      "--ui-motion-toast-out: 160ms;",
      "--ui-motion-ease: cubic-bezier(0.22, 1, 0.36, 1);",
    ]) {
      assert.ok(globalsCss.includes(token), `globals.css missing motion token ${token}`);
    }
    assert.match(globalsCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);

    // Button / Tab / Nav / Filter token verification (S1-05 & S1-06)
    const buttonSrc = readRel("src/components/ui/button.tsx");
    assert.match(buttonSrc, /duration-\[var\(--ui-motion-hover,160ms\)\]/);
    assert.match(buttonSrc, /active:duration-\[var\(--ui-motion-fast,120ms\)\]/);
    assert.doesNotMatch(buttonSrc, /transition-all/);

    const tabsSrc = readRel("src/components/dashboard/bod-dashboard-tabs.tsx");
    assert.match(tabsSrc, /duration-\[var\(--ui-motion-tab,200ms\)\]/);

    const filtersSrc = readRel("src/components/dashboard/dashboard-filters.tsx");
    assert.match(filtersSrc, /duration-\[180ms\]/);

    // Recharts data animation must remain disabled in Chặng 1 (only on components actually rendering Recharts)
    for (const chartRel of [
      "src/components/dashboard/trend-chart.tsx",
      "src/components/dashboard/recruiter-bar-chart.tsx",
      "src/components/dashboard/project-donut.tsx",
      "src/components/dashboard/provider-donut.tsx",
    ]) {
      const chartSrc = readRel(chartRel);
      assert.match(chartSrc, /from\s+["']recharts["']/);
      assert.match(chartSrc, /isAnimationActive=\{false\}/, `${chartRel} must keep isAnimationActive={false} in Chặng 1`);
      assert.doesNotMatch(chartSrc, /isAnimationActive=\{true\}/);
    }

    // CSS chart (team-bucket-chart.tsx) does not use Recharts and must not add data animation in Chặng 1
    const cssChartSrc = readRel("src/components/dashboard/team-bucket-chart.tsx");
    assert.doesNotMatch(cssChartSrc, /from\s+["']recharts["']/);
    assert.doesNotMatch(cssChartSrc, /transition-all|animate-/);

    // No new animation/toast dependencies in package.json
    const pkg = JSON.parse(readRel("package.json"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const forbiddenDep of ["framer-motion", "motion", "sonner", "react-hot-toast"]) {
      assert.ok(!(forbiddenDep in allDeps), `Forbidden dependency ${forbiddenDep} found in package.json`);
    }

    // Notification inventory must have all 40 action-feedback table rows completed and 0 migrate rows remaining in Section 3
    const inventory = readRel("docs/plans/uiux/notification-inventory.md");
    const routeInventorySection = inventory.split("## 3. Bảng Kiểm Kê Chi Tiết Toàn Bộ Route Hoạt Động")[1] ?? "";
    const completedRows = routeInventorySection.match(/\|\s*`completed(?:\s*\(UIUX-S1-[^`]+\))?`\s*\|/g) ?? [];
    const migrateRows = routeInventorySection.match(/\|\s*`migrate[^`]*`\s*\|/g) ?? [];
    assert.equal(completedRows.length, 40, "Expected all 40 action feedback rows in notification-inventory.md Section 3 to be completed");
    assert.equal(migrateRows.length, 0, "Expected 0 unmigrated action feedback entries in notification-inventory.md");
  });
});
