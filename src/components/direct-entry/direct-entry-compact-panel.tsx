"use client";

import { useId, type ReactNode } from "react";

import styles from "./direct-entry-shell.module.css";

export type CompactPanelBadge = {
  count: number;
  label: string;
};

type DirectEntryCompactPanelProps = {
  title: string;
  loadedCount: number;
  badges?: readonly CompactPanelBadge[];
  state: "loading" | "ready" | "error";
  children: ReactNode;
};

export function DirectEntryCompactPanel({
  title,
  loadedCount,
  badges = [],
  state,
  children,
}: DirectEntryCompactPanelProps) {
  const headingId = useId();

  return (
    <details className={styles.compactPanel} aria-labelledby={headingId}>
      <summary className={styles.compactSummary}>
        <span id={headingId} className={styles.compactHeading} role="heading" aria-level={2}>
          {title}
        </span>
        <span>{loadedCount} đã tải</span>
        {badges.filter(({ count }) => count > 0).map(({ count, label }) => (
          <span key={label}>{count} {label}</span>
        ))}
        {state === "loading" && <span role="status">Đang tải…</span>}
        {state === "error" && (
          <span className={styles.compactError} role="status">Không tải được</span>
        )}
        <span className={styles.compactToggle}>
          <span className={styles.compactOpenLabel}>Mở</span>
          <span className={styles.compactCloseLabel}>Thu gọn</span>
        </span>
      </summary>
      <div className={styles.compactContent}>{children}</div>
    </details>
  );
}
