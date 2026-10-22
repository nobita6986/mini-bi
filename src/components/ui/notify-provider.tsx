"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

import { ToastCard } from "@/components/ui/toast";
import {
  bindNotifyTimerScheduler,
  createNotifyStore,
  DEFAULT_NOTIFY_DURATIONS,
  executeSessionLogout,
  getDefaultNotifyStore,
  MAX_PENDING_TOASTS,
  MAX_VISIBLE_TOASTS,
  renderNotifyViewportElement,
  resolveNotifyDuration,
  sanitizeNotifyText,
  syncNotifyPathname,
  TOAST_ENTER_DURATION_MS,
  TOAST_EXIT_DURATION_MS,
  type NotifyActionProps,
  type NotifyApi,
  type NotifyClock,
  type NotifyItem,
  type NotifyOptions,
  type NotifyPhase,
  type NotifySnapshot,
  type NotifyStore,
  type NotifyTone,
} from "@/components/ui/notify-store";

export {
  bindNotifyTimerScheduler,
  createNotifyStore,
  DEFAULT_NOTIFY_DURATIONS,
  executeSessionLogout,
  getDefaultNotifyStore,
  MAX_PENDING_TOASTS,
  MAX_VISIBLE_TOASTS,
  renderNotifyViewportElement,
  resolveNotifyDuration,
  sanitizeNotifyText,
  syncNotifyPathname,
  TOAST_ENTER_DURATION_MS,
  TOAST_EXIT_DURATION_MS,
  type NotifyActionProps,
  type NotifyApi,
  type NotifyClock,
  type NotifyItem,
  type NotifyOptions,
  type NotifyPhase,
  type NotifySnapshot,
  type NotifyStore,
  type NotifyTone,
};

const defaultNotifyStore = getDefaultNotifyStore();
const NotifyContext = createContext<NotifyStore>(defaultNotifyStore);

export function useNotify(): NotifyApi {
  const store = useContext(NotifyContext);
  return useMemo(() => store.api, [store]);
}

export function NotifyProvider({
  children,
  store = defaultNotifyStore,
}: {
  children: ReactNode;
  store?: NotifyStore;
}): ReactElement {
  const pathname = usePathname();
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  // Fallback clear when landing on /login (after logout or session expiry)
  useEffect(() => {
    syncNotifyPathname(store, pathname);
  }, [pathname, store]);

  // Independent per-Toast deadline & enter/exit timer scheduler
  useEffect(() => {
    return bindNotifyTimerScheduler(store);
  }, [store]);

  return (
    <NotifyContext.Provider value={store}>
      {children}
      {snapshot.visible.length > 0 ? (
        <section
          aria-label="Thông báo hệ thống"
          data-testid="app-notify-viewport"
          data-ui-toast-viewport="true"
          className="pointer-events-none fixed top-[max(0.75rem,env(safe-area-inset-top))] sm:top-16 right-3 left-3 sm:left-auto sm:right-4 z-[80] flex flex-col gap-2.5 sm:w-full sm:max-w-[420px]"
        >
          {snapshot.visible.map((item) => (
            <ToastCard
              key={item.id}
              tone={item.tone}
              phase={item.phase}
              title={item.title}
              description={item.description}
              action={item.action}
              dataTestId={item.dataTestId ?? `toast-item-${item.tone}`}
              onDismiss={() => store.dismiss(item.id)}
            />
          ))}
        </section>
      ) : null}
    </NotifyContext.Provider>
  );
}
