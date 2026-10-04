"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTheme } from "@/lib/theme/theme-provider";
import { THEMES, type ThemeDef } from "@/lib/theme/theme-registry";

function Swatches({ theme }: { theme: ThemeDef }) {
  const colors = [theme.light.primary, theme.light.secondary, theme.light.accent];
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      {colors.map((c, i) => (
        <span key={i} className="h-3 w-3 rounded-full border border-black/10" style={{ background: c }} />
      ))}
    </span>
  );
}

// Trigger swatch dùng CSS var (SSR/client giống nhau — không hydration mismatch).
function CurrentSwatches() {
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      {["var(--primary)", "var(--secondary)", "var(--accent)"].map((c, i) => (
        <span key={i} className="h-3 w-3 rounded-full border border-black/10" style={{ background: c }} />
      ))}
    </span>
  );
}

export function ThemeSelector() {
  const { themeId, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = btnRef.current?.getBoundingClientRect();
      const menu = listRef.current;
      if (!trigger || !menu) return;
      const gutter = 8;
      const left = Math.max(gutter, Math.min(trigger.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - gutter));
      const below = window.innerHeight - trigger.bottom - gutter;
      const top = below >= menu.offsetHeight
        ? trigger.bottom + gutter
        : Math.max(gutter, trigger.top - menu.offsetHeight - gutter);
      setMenuPosition({ top, left });
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    positionMenu();
    listRef.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);

  function focusIndex(i: number) {
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    if (!nodes || nodes.length === 0) return;
    const idx = ((i % nodes.length) + nodes.length) % nodes.length;
    nodes[idx].focus();
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    if (!nodes || nodes.length === 0) return;
    const idx = Array.from(nodes).indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
    focusIndex(next);
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="theme-menu"
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          const trigger = btnRef.current?.getBoundingClientRect();
          if (trigger) {
            setMenuPosition({
              top: trigger.bottom + 8,
              left: Math.max(8, Math.min(trigger.right - 256, window.innerWidth - 264)),
            });
          }
          setOpen(true);
        }}
        className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-muted/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <CurrentSwatches />
        <span>Màu giao diện</span>
        <span aria-hidden className="text-muted">{open ? "▾" : "▸"}</span>
      </button>

      {open ? createPortal(
        <div
          id="theme-menu"
          ref={listRef}
          role="radiogroup"
          aria-label="Màu giao diện"
          onKeyDown={onListKeyDown}
          style={{ top: menuPosition.top, left: menuPosition.left }}
          className="fixed z-[100] max-h-[calc(100dvh-1rem)] w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-lg"
        >
          {THEMES.map((t) => {
            const selected = t.id === themeId;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setTheme(t.id);
                  setOpen(false);
                  btnRef.current?.focus();
                }}
                className={
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
                  (selected ? "bg-primary/10" : "hover:bg-muted/10")
                }
              >
                <Swatches theme={t} />
                <span className="flex-1">{t.name}</span>
                {selected ? <span aria-hidden className="text-primary">✓</span> : null}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
