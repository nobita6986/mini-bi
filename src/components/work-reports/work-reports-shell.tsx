import type { ReactNode } from "react";

import { PageHeader, PageShell } from "@/components/ui/page-shell";
import {
  workReportAnalyticsPredicate,
  workReportAssignmentPredicate,
  workReportDelegationPredicate,
  workReportReviewPredicate,
  workReportTemplateManagePredicate,
  type NavActorProjection,
} from "@/lib/navigation/registry-capability";
import { WorkReportsModuleNav, type WorkReportsNavLink } from "./work-reports-nav";

export function buildWorkReportsNavLinks(actor: NavActorProjection | null): readonly WorkReportsNavLink[] {
  const links: WorkReportsNavLink[] = [
    { href: "/work-reports", label: "Cần báo cáo", activeKey: "obligations" },
    { href: "/work-reports/my-reports", label: "Lịch sử của tôi", activeKey: "my-reports" },
  ];
  if (actor) {
    if (workReportAnalyticsPredicate(actor)) links.push({ href: "/work-reports/analytics", label: "Tổng hợp & Bài nộp", activeKey: "analytics" });
    if (workReportAssignmentPredicate(actor)) links.push({ href: "/work-reports/assignments", label: "Giao báo cáo", activeKey: "assignments" });
    if (workReportTemplateManagePredicate(actor)) links.push({ href: "/work-reports/templates", label: "Quản lý mẫu", activeKey: "templates" });
    if (workReportReviewPredicate(actor)) links.push({ href: "/work-reports/reviews", label: "Duyệt báo cáo", activeKey: "reviews" });
    if (workReportDelegationPredicate(actor)) links.push({ href: "/work-reports/delegations", label: "Ủy quyền", activeKey: "delegations" });
  }
  return links;
}

export function WorkReportsShell({
  actor,
  title,
  description,
  children,
}: {
  actor: NavActorProjection | null;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageShell>
      <PageHeader eyebrow="Báo cáo công việc" title={title} description={description} />
      <WorkReportsModuleNav links={buildWorkReportsNavLinks(actor)} />
      {children}
    </PageShell>
  );
}
