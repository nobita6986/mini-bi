"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface BiHighlightState {
  hoveredKey: string | null;
  focusedKey: string | null;
  pinnedKey: string | null;
}

export const INITIAL_BI_HIGHLIGHT_STATE: BiHighlightState = {
  hoveredKey: null,
  focusedKey: null,
  pinnedKey: null,
};

export type BiHighlightAction =
  | { type: "hover"; key: string | null }
  | { type: "focus"; key: string | null }
  | { type: "toggle-pin"; key: string }
  | { type: "clear" };

export function reduceBiHighlightState(
  state: BiHighlightState,
  action: BiHighlightAction,
): BiHighlightState {
  switch (action.type) {
    case "hover":
      if (state.hoveredKey === action.key) return state;
      return { ...state, hoveredKey: action.key };
    case "focus":
      if (state.focusedKey === action.key) return state;
      return { ...state, focusedKey: action.key };
    case "toggle-pin":
      return {
        ...state,
        pinnedKey: state.pinnedKey === action.key ? null : action.key,
      };
    case "clear":
      if (
        state.hoveredKey === null &&
        state.focusedKey === null &&
        state.pinnedKey === null
      ) {
        return state;
      }
      return INITIAL_BI_HIGHLIGHT_STATE;
    default:
      return state;
  }
}

function toKeySet(keys: ReadonlySet<string> | ReadonlyArray<string>): ReadonlySet<string> {
  return keys instanceof Set ? keys : new Set(keys);
}

export function resolveActiveHighlightKey(
  state: BiHighlightState,
  validKeys: ReadonlySet<string> | ReadonlyArray<string>,
): string | null {
  const allowed = toKeySet(validKeys);
  if (state.hoveredKey !== null && allowed.has(state.hoveredKey)) {
    return state.hoveredKey;
  }
  if (state.focusedKey !== null && allowed.has(state.focusedKey)) {
    return state.focusedKey;
  }
  if (state.pinnedKey !== null && allowed.has(state.pinnedKey)) {
    return state.pinnedKey;
  }
  return null;
}

export function resolvePinnedHighlightKey(
  state: BiHighlightState,
  validKeys: ReadonlySet<string> | ReadonlyArray<string>,
): string | null {
  const allowed = toKeySet(validKeys);
  return state.pinnedKey !== null && allowed.has(state.pinnedKey)
    ? state.pinnedKey
    : null;
}

export function resolveDonutSliceHighlightKey(
  activeKey: string | null,
  slices: ReadonlyArray<{ key: string }>,
  validBucketKeys?: ReadonlySet<string> | ReadonlyArray<string>,
): string | null {
  if (activeKey === null) return null;
  if (slices.some((slice) => slice.key === activeKey)) {
    return activeKey;
  }
  if (validBucketKeys) {
    const allowedBuckets = toKeySet(validBucketKeys);
    if (
      allowedBuckets.has(activeKey) &&
      slices.some((slice) => slice.key === "__other__")
    ) {
      return "__other__";
    }
  }
  return null;
}

export function isBucketRowHighlighted(
  rowKey: string,
  activeKey: string | null,
  topSliceKeys?: ReadonlySet<string> | ReadonlyArray<string>,
): boolean {
  if (activeKey === null) return false;
  if (activeKey === rowKey) return true;
  if (activeKey === "__other__" && topSliceKeys) {
    const topSet = toKeySet(topSliceKeys);
    return !topSet.has(rowKey);
  }
  return false;
}

interface BiHighlightContextValue {
  state: BiHighlightState;
  validKeys: ReadonlySet<string>;
  topSliceKeys?: ReadonlySet<string>;
  onHover: (key: string | null) => void;
  onFocus: (key: string | null) => void;
  onTogglePin: (key: string) => void;
  onClear: () => void;
}

const BiHighlightContext = createContext<BiHighlightContextValue | null>(null);

export function BiHighlightScope({
  validKeys,
  topSliceKeys,
  children,
}: {
  validKeys: ReadonlyArray<string>;
  topSliceKeys?: ReadonlyArray<string>;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(
    reduceBiHighlightState,
    INITIAL_BI_HIGHLIGHT_STATE,
  );

  const validKeySet = useMemo(() => {
    const next = new Set(validKeys);
    if (topSliceKeys && validKeys.length > topSliceKeys.length) {
      next.add("__other__");
    }
    return next;
  }, [validKeys, topSliceKeys]);

  const topSliceKeySet = useMemo(
    () => (topSliceKeys ? new Set(topSliceKeys) : undefined),
    [topSliceKeys],
  );

  const onHover = useCallback((key: string | null) => {
    dispatch({ type: "hover", key });
  }, []);

  const onFocus = useCallback((key: string | null) => {
    dispatch({ type: "focus", key });
  }, []);

  const onTogglePin = useCallback((key: string) => {
    dispatch({ type: "toggle-pin", key });
  }, []);

  const onClear = useCallback(() => {
    dispatch({ type: "clear" });
  }, []);

  const value = useMemo<BiHighlightContextValue>(
    () => ({
      state,
      validKeys: validKeySet,
      topSliceKeys: topSliceKeySet,
      onHover,
      onFocus,
      onTogglePin,
      onClear,
    }),
    [state, validKeySet, topSliceKeySet, onHover, onFocus, onTogglePin, onClear],
  );

  return (
    <BiHighlightContext.Provider value={value}>
      {children}
    </BiHighlightContext.Provider>
  );
}

export function useBiHighlight(localValidKeys: ReadonlyArray<string>) {
  const ctx = useContext(BiHighlightContext);
  const [localState, localDispatch] = useReducer(
    reduceBiHighlightState,
    INITIAL_BI_HIGHLIGHT_STATE,
  );

  const localValidSet = useMemo(() => new Set(localValidKeys), [localValidKeys]);

  const fallbackOnHover = useCallback((key: string | null) => {
    localDispatch({ type: "hover", key });
  }, []);
  const fallbackOnFocus = useCallback((key: string | null) => {
    localDispatch({ type: "focus", key });
  }, []);
  const fallbackOnTogglePin = useCallback((key: string) => {
    localDispatch({ type: "toggle-pin", key });
  }, []);
  const fallbackOnClear = useCallback(() => {
    localDispatch({ type: "clear" });
  }, []);

  const effectiveState = ctx ? ctx.state : localState;
  const effectiveValidKeys = ctx ? ctx.validKeys : localValidSet;

  const activeKey = resolveActiveHighlightKey(effectiveState, effectiveValidKeys);
  const pinnedKey = resolvePinnedHighlightKey(effectiveState, effectiveValidKeys);

  const onHover = ctx ? ctx.onHover : fallbackOnHover;
  const onFocus = ctx ? ctx.onFocus : fallbackOnFocus;
  const onTogglePin = ctx ? ctx.onTogglePin : fallbackOnTogglePin;
  const onClear = ctx ? ctx.onClear : fallbackOnClear;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, itemKey?: string) => {
      if (event.key === "Escape") {
        onClear();
        return;
      }
      if (itemKey && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        onTogglePin(itemKey);
      }
    },
    [onClear, onTogglePin],
  );

  return {
    activeKey,
    pinnedKey,
    validKeys: effectiveValidKeys,
    topSliceKeys: ctx?.topSliceKeys,
    onHover,
    onFocus,
    onTogglePin,
    onClear,
    handleKeyDown,
  };
}

export function BiClearHighlightButton({
  visible,
  onClear,
  label = "Bỏ đánh dấu",
}: {
  visible: boolean;
  onClear: () => void;
  label?: string;
}) {
  if (!visible) return null;
  return (
    <div className="mt-2 flex justify-end">
      <button
        type="button"
        onClick={onClear}
        className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none hover:bg-surface-hover hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {label}
      </button>
    </div>
  );
}
