export type NotifyTone = "success" | "info" | "warning" | "error";
export type NotifyPhase = "entering" | "open" | "exiting";

export type NotifyActionProps = {
  label: string;
  onClick?: () => void;
  href?: string;
  dataTestId?: string;
};

export type NotifyOptions = {
  title: string;
  description?: string;
  dedupeKey?: string;
  durationMs?: number | null;
  action?: NotifyActionProps;
  dataTestId?: string;
};

export type NotifyItem = {
  id: string;
  tone: NotifyTone;
  title: string;
  description?: string;
  dedupeKey?: string;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
  visibleAt: number | null;
  enterDeadlineAt: number | null;
  deadlineAt: number | null;
  exitDeadlineAt: number | null;
  phase: NotifyPhase;
  revision: number;
  action?: NotifyActionProps;
  dataTestId?: string;
};

export type NotifySnapshot = {
  visible: readonly NotifyItem[];
  queue: readonly NotifyItem[];
};

export type NotifyApi = {
  success: (options: NotifyOptions) => string;
  info: (options: NotifyOptions) => string;
  warning: (options: NotifyOptions) => string;
  error: (options: NotifyOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

export type NotifyClock = {
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  prefersReducedMotion?: () => boolean;
};

export const MAX_VISIBLE_TOASTS = 3;
export const MAX_PENDING_TOASTS = 20;
export const TOAST_ENTER_DURATION_MS = 200;
export const TOAST_EXIT_DURATION_MS = 160;

export const DEFAULT_NOTIFY_DURATIONS: Readonly<Record<NotifyTone, number | null>> = Object.freeze({
  success: 4000,
  info: 5000,
  warning: 7000,
  error: null,
});

export const TOAST_TONE_STYLES: Readonly<Record<NotifyTone, string>> = Object.freeze({
  success:
    "border-l-4 border-l-emerald-500 border-border bg-surface text-foreground",
  info:
    "border-l-4 border-l-sky-500 border-border bg-surface text-foreground",
  warning:
    "border-l-4 border-l-amber-500 border-border bg-surface text-foreground",
  error:
    "border-l-4 border-l-rose-500 border-border bg-surface text-foreground",
});

export const TOAST_PHASE_CLASSES: Readonly<Record<NotifyPhase, string>> = Object.freeze({
  entering:
    "opacity-100 translate-y-0 starting:opacity-0 starting:-translate-y-2 duration-[var(--ui-motion-toast-in,200ms)]",
  open:
    "opacity-100 translate-y-0 duration-[var(--ui-motion-toast-in,200ms)]",
  exiting:
    "pointer-events-none opacity-0 -translate-y-1 duration-[var(--ui-motion-toast-out,160ms)]",
});

const MAX_TEXT_LENGTH = 320;
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F]+/g;
const CCCD_12_DIGIT_PATTERN = /\b\d{12}\b/g;
const JWT_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const FULL_UUID_PATTERN = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Chuẩn hóa chuỗi thông báo an toàn:
 * - Loại bỏ thẻ HTML và ký tự điều khiển.
 * - Che chuỗi 12 chữ số (CCCD), JWT token và rút gọn UUID đầy đủ thành shortRef 8 ký tự.
 * - Giới hạn độ dài để không lộ raw response hoặc stack trace.
 */
export function sanitizeNotifyText(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(HTML_TAG_PATTERN, " ")
    .replace(CONTROL_CHAR_PATTERN, " ")
    .replace(JWT_TOKEN_PATTERN, "[redacted]")
    .replace(CCCD_12_DIGIT_PATTERN, "[đã ẩn]")
    .replace(FULL_UUID_PATTERN, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= MAX_TEXT_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

export function resolveNotifyDuration(
  tone: NotifyTone,
  durationMs?: number | null,
): number | null {
  if (durationMs === null) return null;
  if (typeof durationMs === "number") {
    return Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs) : null;
  }
  return DEFAULT_NOTIFY_DURATIONS[tone];
}

export function resolveToastAria(tone: NotifyTone): {
  role: "alert" | "status";
  ariaLive: "assertive" | "polite";
} {
  const isUrgent = tone === "error" || tone === "warning";
  return {
    role: isUrgent ? "alert" : "status",
    ariaLive: isUrgent ? "assertive" : "polite",
  };
}

function isHighPriorityTone(tone: NotifyTone): boolean {
  return tone === "error" || tone === "warning";
}

function defaultPrefersReducedMotion(): boolean {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      return Boolean(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch {
      return false;
    }
  }
  return false;
}

export type NotifyStore = {
  getSnapshot: () => NotifySnapshot;
  subscribe: (listener: () => void) => () => void;
  enqueue: (tone: NotifyTone, options: NotifyOptions) => string;
  completeEnter: (id: string, expectedRevision?: number) => void;
  dismiss: (id: string, expectedRevision?: number) => void;
  finalizeDismiss: (id: string, expectedRevision?: number) => void;
  clear: () => void;
  now: () => number;
  prefersReducedMotion: () => boolean;
  attachTimerHost: () => () => void;
  hasTimerHost: () => boolean;
  api: NotifyApi;
};

export function createNotifyStore(
  nowOrClock?: (() => number) | NotifyClock,
): NotifyStore {
  const clock: NotifyClock =
    typeof nowOrClock === "function"
      ? { now: nowOrClock }
      : (nowOrClock ?? {});
  const nowFn = clock.now ?? (() => Date.now());
  const prefersReducedMotionFn = clock.prefersReducedMotion ?? defaultPrefersReducedMotion;

  let seq = 0;
  let activeHostCount = 0;
  let snapshot: NotifySnapshot = {
    visible: [],
    queue: [],
  };
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  function makeVisibleItem(base: NotifyItem, timestamp: number): NotifyItem {
    const reduced = prefersReducedMotionFn();
    return {
      ...base,
      visibleAt: timestamp,
      phase: reduced ? "open" : "entering",
      enterDeadlineAt: reduced ? null : timestamp + TOAST_ENTER_DURATION_MS,
      deadlineAt: base.durationMs !== null ? timestamp + base.durationMs : null,
      exitDeadlineAt: null,
    };
  }

  function enqueue(tone: NotifyTone, options: NotifyOptions): string {
    const title = sanitizeNotifyText(options.title) || "Thông báo hệ thống";
    const descriptionRaw = sanitizeNotifyText(options.description);
    const description = descriptionRaw.length > 0 ? descriptionRaw : undefined;
    const dedupeKey =
      typeof options.dedupeKey === "string" && options.dedupeKey.trim().length > 0
        ? options.dedupeKey.trim()
        : undefined;
    const durationMs = resolveNotifyDuration(tone, options.durationMs);
    const timestamp = nowFn();

    if (dedupeKey) {
      const visibleIdx = snapshot.visible.findIndex((item) => item.dedupeKey === dedupeKey);
      if (visibleIdx !== -1) {
        const existing = snapshot.visible[visibleIdx]!;
        const nextPhase: NotifyPhase =
          existing.phase === "exiting"
            ? (prefersReducedMotionFn() ? "open" : "entering")
            : existing.phase;
        const updatedItem: NotifyItem = {
          ...existing,
          tone,
          title,
          description,
          durationMs,
          updatedAt: timestamp,
          visibleAt: timestamp,
          phase: nextPhase,
          enterDeadlineAt:
            nextPhase === "entering"
              ? (existing.enterDeadlineAt ?? timestamp + TOAST_ENTER_DURATION_MS)
              : null,
          deadlineAt: durationMs !== null ? timestamp + durationMs : null,
          exitDeadlineAt: null,
          revision: existing.revision + 1,
          action: options.action,
          dataTestId: options.dataTestId ?? existing.dataTestId,
        };
        const nextVisible = [...snapshot.visible];
        nextVisible[visibleIdx] = updatedItem;
        snapshot = {
          ...snapshot,
          visible: nextVisible,
        };
        emit();
        return existing.id;
      }

      const queueIdx = snapshot.queue.findIndex((item) => item.dedupeKey === dedupeKey);
      if (queueIdx !== -1) {
        const existing = snapshot.queue[queueIdx]!;
        const updatedItem: NotifyItem = {
          ...existing,
          tone,
          title,
          description,
          durationMs,
          updatedAt: timestamp,
          revision: existing.revision + 1,
          action: options.action,
          dataTestId: options.dataTestId ?? existing.dataTestId,
        };
        const nextQueue = [...snapshot.queue];
        nextQueue[queueIdx] = updatedItem;
        snapshot = {
          ...snapshot,
          queue: nextQueue,
        };
        emit();
        return existing.id;
      }
    }

    const id = `toast-${++seq}`;
    const baseItem: NotifyItem = {
      id,
      tone,
      title,
      description,
      dedupeKey,
      durationMs,
      createdAt: timestamp,
      updatedAt: timestamp,
      visibleAt: null,
      enterDeadlineAt: null,
      deadlineAt: null,
      exitDeadlineAt: null,
      phase: "entering",
      revision: 1,
      action: options.action,
      dataTestId: options.dataTestId,
    };

    if (snapshot.visible.length < MAX_VISIBLE_TOASTS) {
      const visibleItem = makeVisibleItem(baseItem, timestamp);
      snapshot = {
        ...snapshot,
        visible: [...snapshot.visible, visibleItem],
      };
      emit();
      return id;
    }

    const nextQueue = [...snapshot.queue];
    if (nextQueue.length >= MAX_PENDING_TOASTS) {
      const lowPriorityIdx = nextQueue.findIndex((item) => !isHighPriorityTone(item.tone));
      if (lowPriorityIdx !== -1) {
        nextQueue.splice(lowPriorityIdx, 1);
      } else if (isHighPriorityTone(tone)) {
        nextQueue.shift();
      } else {
        return id;
      }
    }
    nextQueue.push(baseItem);
    snapshot = {
      ...snapshot,
      queue: nextQueue,
    };
    emit();
    return id;
  }

  function completeEnter(id: string, expectedRevision?: number) {
    const visibleIdx = snapshot.visible.findIndex((item) => item.id === id);
    if (visibleIdx === -1) return;
    const item = snapshot.visible[visibleIdx]!;
    if (expectedRevision !== undefined && item.revision !== expectedRevision) return;
    if (item.phase !== "entering") return;

    const nextVisible = [...snapshot.visible];
    nextVisible[visibleIdx] = {
      ...item,
      phase: "open",
      enterDeadlineAt: null,
    };
    snapshot = {
      ...snapshot,
      visible: nextVisible,
    };
    emit();
  }

  function finalizeDismiss(id: string, expectedRevision?: number) {
    const visibleIdx = snapshot.visible.findIndex((item) => item.id === id);
    if (visibleIdx !== -1) {
      const target = snapshot.visible[visibleIdx]!;
      if (expectedRevision !== undefined && target.revision !== expectedRevision) return;

      const nextVisible = snapshot.visible.filter((item) => item.id !== id);
      const nextQueue = [...snapshot.queue];
      const timestamp = nowFn();
      while (nextVisible.length < MAX_VISIBLE_TOASTS && nextQueue.length > 0) {
        const promoted = nextQueue.shift()!;
        nextVisible.push(
          makeVisibleItem(
            {
              ...promoted,
              updatedAt: timestamp,
            },
            timestamp,
          ),
        );
      }
      snapshot = {
        ...snapshot,
        visible: nextVisible,
        queue: nextQueue,
      };
      emit();
      return;
    }

    const queueIdx = snapshot.queue.findIndex((item) => item.id === id);
    if (queueIdx !== -1) {
      const target = snapshot.queue[queueIdx]!;
      if (expectedRevision !== undefined && target.revision !== expectedRevision) return;
      snapshot = {
        ...snapshot,
        queue: snapshot.queue.filter((item) => item.id !== id),
      };
      emit();
    }
  }

  function dismiss(id: string, expectedRevision?: number) {
    const visibleIdx = snapshot.visible.findIndex((item) => item.id === id);
    if (visibleIdx !== -1) {
      const target = snapshot.visible[visibleIdx]!;
      if (expectedRevision !== undefined && target.revision !== expectedRevision) return;
      if (target.phase === "exiting") return;

      const shouldAnimateExit = activeHostCount > 0 && !prefersReducedMotionFn();
      if (shouldAnimateExit) {
        const timestamp = nowFn();
        const nextVisible = [...snapshot.visible];
        nextVisible[visibleIdx] = {
          ...target,
          phase: "exiting",
          enterDeadlineAt: null,
          deadlineAt: null,
          exitDeadlineAt: timestamp + TOAST_EXIT_DURATION_MS,
        };
        snapshot = {
          ...snapshot,
          visible: nextVisible,
        };
        emit();
        return;
      }

      finalizeDismiss(id, target.revision);
      return;
    }

    finalizeDismiss(id, expectedRevision);
  }

  function clear() {
    if (snapshot.visible.length === 0 && snapshot.queue.length === 0) return;
    snapshot = {
      ...snapshot,
      visible: [],
      queue: [],
    };
    emit();
  }

  const api: NotifyApi = Object.freeze({
    success: (options: NotifyOptions) => enqueue("success", options),
    info: (options: NotifyOptions) => enqueue("info", options),
    warning: (options: NotifyOptions) => enqueue("warning", options),
    error: (options: NotifyOptions) => enqueue("error", options),
    dismiss: (id: string) => dismiss(id),
    clear,
  });

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueue,
    completeEnter,
    dismiss,
    finalizeDismiss,
    clear,
    now: nowFn,
    prefersReducedMotion: prefersReducedMotionFn,
    attachTimerHost: () => {
      activeHostCount += 1;
      return () => {
        activeHostCount = Math.max(0, activeHostCount - 1);
      };
    },
    hasTimerHost: () => activeHostCount > 0,
    api,
  };
}

type ScheduledTimerEntry = {
  handle: unknown;
  targetAt: number;
  revision: number;
};

/**
 * Quản lý timer độc lập theo từng Toast item đang hiển thị:
 * - Thêm Toast B không làm reset hay kéo dài timer của Toast A.
 * - Dedupe/update chỉ cập nhật lại timer của đúng Toast có revision/deadlineAt mới.
 * - Dismiss / replace / unmount dọn đúng timer tương ứng.
 * - Tương thích React Strict Mode (mount -> unmount -> remount giữ đúng phần thời gian còn lại `deadlineAt - now`).
 */
export function bindNotifyTimerScheduler(
  store: NotifyStore,
  timerEnv?: Pick<NotifyClock, "setTimeout" | "clearTimeout">,
): () => void {
  const setTimer =
    timerEnv?.setTimeout ??
    ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    timerEnv?.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const detachHost = store.attachTimerHost();
  const enterTimers = new Map<string, ScheduledTimerEntry>();
  const autoDismissTimers = new Map<string, ScheduledTimerEntry>();
  const exitTimers = new Map<string, ScheduledTimerEntry>();

  function clearMapEntry(map: Map<string, ScheduledTimerEntry>, id: string) {
    const existing = map.get(id);
    if (existing !== undefined) {
      clearTimer(existing.handle);
      map.delete(id);
    }
  }

  function syncTimers() {
    const { visible } = store.getSnapshot();
    const now = store.now();
    const visibleIds = new Set(visible.map((item) => item.id));

    for (const id of [...enterTimers.keys()]) {
      if (!visibleIds.has(id)) clearMapEntry(enterTimers, id);
    }
    for (const id of [...autoDismissTimers.keys()]) {
      if (!visibleIds.has(id)) clearMapEntry(autoDismissTimers, id);
    }
    for (const id of [...exitTimers.keys()]) {
      if (!visibleIds.has(id)) clearMapEntry(exitTimers, id);
    }

    for (const item of visible) {
      // 1. Enter transition timer (200ms)
      if (item.phase === "entering" && item.enterDeadlineAt !== null) {
        const currentEnter = enterTimers.get(item.id);
        if (
          !currentEnter ||
          currentEnter.targetAt !== item.enterDeadlineAt ||
          currentEnter.revision !== item.revision
        ) {
          clearMapEntry(enterTimers, item.id);
          const delay = Math.max(0, item.enterDeadlineAt - now);
          const revision = item.revision;
          const handle = setTimer(() => {
            enterTimers.delete(item.id);
            store.completeEnter(item.id, revision);
          }, delay);
          enterTimers.set(item.id, {
            handle,
            targetAt: item.enterDeadlineAt,
            revision,
          });
        }
      } else {
        clearMapEntry(enterTimers, item.id);
      }

      // 2. Auto-dismiss deadline timer (4s/5s/7s; null for persistent error)
      if (item.phase !== "exiting" && item.deadlineAt !== null) {
        const currentAuto = autoDismissTimers.get(item.id);
        if (
          !currentAuto ||
          currentAuto.targetAt !== item.deadlineAt ||
          currentAuto.revision !== item.revision
        ) {
          clearMapEntry(autoDismissTimers, item.id);
          const delay = Math.max(0, item.deadlineAt - now);
          const revision = item.revision;
          const handle = setTimer(() => {
            autoDismissTimers.delete(item.id);
            store.dismiss(item.id, revision);
          }, delay);
          autoDismissTimers.set(item.id, {
            handle,
            targetAt: item.deadlineAt,
            revision,
          });
        }
      } else {
        clearMapEntry(autoDismissTimers, item.id);
      }

      // 3. Exit completion timer (160ms before DOM removal)
      if (item.phase === "exiting" && item.exitDeadlineAt !== null) {
        const currentExit = exitTimers.get(item.id);
        if (
          !currentExit ||
          currentExit.targetAt !== item.exitDeadlineAt ||
          currentExit.revision !== item.revision
        ) {
          clearMapEntry(exitTimers, item.id);
          const delay = Math.max(0, item.exitDeadlineAt - now);
          const revision = item.revision;
          const handle = setTimer(() => {
            exitTimers.delete(item.id);
            store.finalizeDismiss(item.id, revision);
          }, delay);
          exitTimers.set(item.id, {
            handle,
            targetAt: item.exitDeadlineAt,
            revision,
          });
        }
      } else {
        clearMapEntry(exitTimers, item.id);
      }
    }
  }

  const unsubscribe = store.subscribe(syncTimers);
  syncTimers();

  return () => {
    unsubscribe();
    for (const id of [...enterTimers.keys()]) clearMapEntry(enterTimers, id);
    for (const id of [...autoDismissTimers.keys()]) clearMapEntry(autoDismissTimers, id);
    for (const id of [...exitTimers.keys()]) clearMapEntry(exitTimers, id);
    detachHost();
  };
}

/**
 * Fallback dọn thông báo khi điều hướng về trang `/login`.
 */
export function syncNotifyPathname(store: NotifyStore, pathname: string | null | undefined): void {
  if (pathname === "/login") {
    store.clear();
  }
}

const defaultNotifyStore = createNotifyStore();

export function getDefaultNotifyStore(): NotifyStore {
  return defaultNotifyStore;
}
