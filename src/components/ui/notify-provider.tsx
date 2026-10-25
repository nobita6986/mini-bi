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

import { ToastViewport } from "@/components/ui/toast";
import { getDefaultFormSaveUploadJobManager } from "@/lib/direct-entry/form-save-upload-job-manager";
import {
  bindNotifyTimerScheduler,
  createNotifyStore,
  DEFAULT_NOTIFY_DURATIONS,
  getDefaultNotifyStore,
  MAX_PENDING_TOASTS,
  MAX_VISIBLE_TOASTS,
  resolveNotifyDuration,
  resolveSafeNotifyAction,
  sanitizeNotifyText,
  syncNotifyPathname,
  TOAST_ENTER_DURATION_MS,
  TOAST_EXIT_DURATION_MS,
  type NotifyActionKind,
  type NotifyActionProps,
  type NotifyApi,
  type NotifyClock,
  type NotifyItem,
  type NotifyOptions,
  type NotifyPhase,
  type NotifySnapshot,
  type NotifyStore,
  type NotifyTone,
  type NotifyUpdateOptions,
} from "@/components/ui/notify-store";

export {
  bindNotifyTimerScheduler,
  createNotifyStore,
  DEFAULT_NOTIFY_DURATIONS,
  getDefaultNotifyStore,
  MAX_PENDING_TOASTS,
  MAX_VISIBLE_TOASTS,
  resolveNotifyDuration,
  resolveSafeNotifyAction,
  sanitizeNotifyText,
  syncNotifyPathname,
  TOAST_ENTER_DURATION_MS,
  TOAST_EXIT_DURATION_MS,
  type NotifyActionKind,
  type NotifyActionProps,
  type NotifyApi,
  type NotifyClock,
  type NotifyItem,
  type NotifyOptions,
  type NotifyPhase,
  type NotifySnapshot,
  type NotifyStore,
  type NotifyTone,
  type NotifyUpdateOptions,
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
    getDefaultFormSaveUploadJobManager().syncSessionPathname(pathname);
  }, [pathname, store]);

  // Independent per-Toast deadline & enter/exit timer scheduler
  useEffect(() => {
    return bindNotifyTimerScheduler(store);
  }, [store]);

  return (
    <NotifyContext.Provider value={store}>
      {children}
      <ToastViewport items={snapshot.visible} onDismiss={store.dismiss} />
    </NotifyContext.Provider>
  );
}
