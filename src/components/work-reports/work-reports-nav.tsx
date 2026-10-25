"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type WorkReportsActiveKey =
  | "my"
  | "history"
  | "assignments"
  | "groups"
  | "analytics"
  | "reviews"
  | "templates"
  | "delegations";

export type WorkReportsSubNavLink = {
  href: string;
  label: string;
  activeKey: WorkReportsActiveKey;
};

export type WorkReportsNavLink = {
  href: string;
  label: string;
  activeKey: "my-reports-root" | "management" | "reviews" | "settings" | WorkReportsActiveKey;
  matchKeys?: readonly WorkReportsActiveKey[];
  subLinks?: readonly WorkReportsSubNavLink[];
};

const DEFAULT_LINKS: readonly WorkReportsNavLink[] = [
  {
    href: "/work-reports",
    label: "Báo cáo của tôi",
    activeKey: "my-reports-root",
    matchKeys: ["my", "history"],
    subLinks: [
      { href: "/work-reports", label: "Cần làm", activeKey: "my" },
      { href: "/work-reports/my-reports", label: "Lịch sử", activeKey: "history" },
    ],
  },
];

function resolveActiveKeyFromPathname(pathname: string | null): WorkReportsActiveKey {
  if (!pathname) return "my";
  if (pathname.startsWith("/work-reports/my-reports")) return "history";
  if (pathname.startsWith("/work-reports/assignments")) return "assignments";
  if (pathname.startsWith("/work-reports/analytics")) return "analytics";
  if (pathname.startsWith("/work-reports/reviews")) return "reviews";
  if (pathname.startsWith("/work-reports/templates")) return "templates";
  if (pathname.startsWith("/work-reports/delegations")) return "delegations";
  return "my";
}

export function WorkReportsModuleNav({
  active: activeProp,
  links = DEFAULT_LINKS,
}: {
  active?: WorkReportsActiveKey;
  links?: readonly WorkReportsNavLink[];
}) {
  const pathname = usePathname();
  const baseActive = activeProp ?? resolveActiveKeyFromPathname(pathname);
  const [assignmentSubTab, setAssignmentSubTab] = useState<"assignments" | "groups">(
    baseActive === "groups" ? "groups" : "assignments",
  );

  useEffect(() => {
    if (baseActive !== "assignments" && baseActive !== "groups") return;
    const syncFromLocation = () => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      setAssignmentSubTab(params.get("tab") === "groups" ? "groups" : "assignments");
    };
    syncFromLocation();
    const handleTabEvent = (event: Event) => {
      const detail = (event as CustomEvent<"assignments" | "groups">).detail;
      if (detail === "assignments" || detail === "groups") {
        setAssignmentSubTab(detail);
      }
    };
    window.addEventListener("popstate", syncFromLocation);
    window.addEventListener("work-reports:assignment-tab", handleTabEvent);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
      window.removeEventListener("work-reports:assignment-tab", handleTabEvent);
    };
  }, [baseActive]);

  const effectiveActiveKey: WorkReportsActiveKey =
    baseActive === "assignments" || baseActive === "groups" ? assignmentSubTab : baseActive;

  const isTopItemActive = (item: WorkReportsNavLink) =>
    item.matchKeys
      ? item.matchKeys.includes(effectiveActiveKey)
      : item.activeKey === effectiveActiveKey;

  const activeTopItem = links.find(isTopItemActive);
  const subLinks = activeTopItem?.subLinks ?? [];

  return (
    <div className="mb-4 space-y-2">
      <nav
        aria-label="Báo cáo công việc"
        className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-surface p-1.5"
      >
        {links.map((item) => {
          const active = isTopItemActive(item);
          return (
            <Link
              key={item.activeKey}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 sm:min-h-9 items-center rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-[color,background-color,transform] duration-[var(--ui-motion-hover,160ms)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                active
                  ? "bg-primary text-on-primary shadow-2xs"
                  : "text-muted hover:bg-muted/10 hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {subLinks.length > 0 ? (
        <nav
          aria-label="Chuyển mục con Báo cáo công việc"
          className="flex flex-wrap gap-1.5 rounded-xl border border-border/80 bg-background/60 p-1"
        >
          {subLinks.map((sub) => {
            const isSubActive = sub.activeKey === effectiveActiveKey;
            const isAssignmentSwitch =
              (baseActive === "assignments" || baseActive === "groups") &&
              (sub.activeKey === "assignments" || sub.activeKey === "groups");

            return (
              <Link
                key={sub.activeKey}
                href={sub.href}
                aria-current={isSubActive ? "page" : undefined}
                onClick={(event) => {
                  if (isAssignmentSwitch && typeof window !== "undefined") {
                    event.preventDefault();
                    const nextKey = sub.activeKey as "assignments" | "groups";
                    setAssignmentSubTab(nextKey);
                    window.history.replaceState(null, "", sub.href);
                    window.dispatchEvent(
                      new CustomEvent("work-reports:assignment-tab", { detail: nextKey }),
                    );
                  }
                }}
                className={cn(
                  "inline-flex min-h-11 sm:min-h-8 items-center rounded-lg px-3 py-1 text-xs font-medium transition-[color,background-color,transform] duration-[var(--ui-motion-hover,160ms)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  isSubActive
                    ? "border border-primary/30 bg-primary/10 font-semibold text-primary"
                    : "text-muted hover:bg-muted/10 hover:text-foreground",
                )}
              >
                {sub.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}
