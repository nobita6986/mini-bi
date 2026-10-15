"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

import styles from "./direct-entry-shell.module.css";

type QueueTab<Value extends string> = {
  value: Value;
  label: string;
};

export function DirectEntryQueueTabs<Value extends string>({
  ariaLabel,
  panelId,
  value,
  tabs,
  onChange,
  children,
}: {
  ariaLabel: string;
  panelId: string;
  value: Value;
  tabs: readonly QueueTab<Value>[];
  onChange: (value: Value) => void;
  children: ReactNode;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = tabs.findIndex((tab) => tab.value === value);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next].value);
    tabRefs.current[next]?.focus();
  }

  return (
    <>
      <div role="tablist" aria-label={ariaLabel} className={styles.changeRequestTabs}>
        {tabs.map((tab, index) => {
          const selected = tab.value === value;
          return (
            <button
              key={tab.value}
              ref={(element) => { tabRefs.current[index] = element; }}
              id={`${panelId}-tab-${index}`}
              type="button"
              role="tab"
              aria-controls={panelId}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? styles.changeRequestTabActive : styles.changeRequestTab}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => onChange(tab.value)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" tabIndex={0}
        aria-labelledby={`${panelId}-tab-${Math.max(selectedIndex, 0)}`}>
        {children}
      </div>
    </>
  );
}
