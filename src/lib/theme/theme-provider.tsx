"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  getTheme,
  resolveColor,
  resolveThemeId,
  tokensToCssVars,
  type ColorMode,
  type ColorSlot,
  type ThemeDef,
} from "./theme-registry";

interface ThemeContextValue {
  themeId: string;
  theme: ThemeDef;
  mode: ColorMode;
  tokens: ThemeDef["light"];
  setTheme: (id: string) => void;
  resolveColor: (slot: ColorSlot) => string;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function currentMode(): ColorMode {
  if (typeof window === "undefined") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function readThemeId(): string {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  try {
    return resolveThemeId(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function applyThemeToDom(themeId: string, mode: ColorMode) {
  const theme = getTheme(themeId);
  const el = document.documentElement;
  el.setAttribute("data-theme", theme.id);
  el.style.colorScheme = mode;
  const vars = tokensToCssVars(theme, mode);
  for (const name of Object.keys(vars)) el.style.setProperty(name, vars[name]);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<string>(() => readThemeId());
  const [mode, setMode] = useState<ColorMode>(() => currentMode());

  useEffect(() => {
    applyThemeToDom(themeId, mode);
  }, [themeId, mode]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setMode(currentMode());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((id: string) => {
    const theme = getTheme(id);
    setThemeId(theme.id);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    } catch {
      /* storage không khả dụng -> vẫn áp dụng trong session */
    }
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const theme = getTheme(themeId);
    return {
      themeId,
      theme,
      mode,
      tokens: mode === "dark" ? theme.dark : theme.light,
      setTheme,
      resolveColor: (slot: ColorSlot) => resolveColor(slot, theme, mode),
    };
  }, [themeId, mode, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme phải dùng bên trong <ThemeProvider>");
  return ctx;
}
