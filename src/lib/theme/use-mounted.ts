"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * true sau khi hydration (client-only). SSR + lần render đầu hydration trả false
 * để tránh hydration mismatch — KHÔNG dùng setState trong effect.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}
