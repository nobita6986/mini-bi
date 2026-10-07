/**
 * P3-W06C - Dashboard audience view contract (pure).
 *
 * Maps the DB-authoritative W05A audience projection to the dashboard UX the
 * user may see. Audience is NEVER inferred from UI role: it comes from the
 * scoped RPC payload.
 *
 * Fail closed: a missing or unknown audience is NOT mapped to a narrower scope.
 * It resolves to an error mode so no fact row is ever rendered under a guessed
 * scope label.
 *
 * Reuses the existing dashboard components/charts/tokens; it only decides copy
 * and which sections/filters are rendered.
 */

import type { ReportingAudience, ReportingAudienceKind } from "./p3-w05a-audience.ts";

export type DashboardAudienceKind = ReportingAudienceKind;

/**
 * Resolve the dashboard kind from the DB-authoritative audience. Returns null
 * when the audience is missing or unknown so callers render a neutral error
 * instead of labelling facts with a scope the DB never confirmed.
 */
export function resolveDashboardAudienceKind(
  audience: ReportingAudience | null,
): DashboardAudienceKind | null {
  if (!audience) return null;
  if (audience.kind === "all" || audience.kind === "team" || audience.kind === "own") {
    return audience.kind;
  }
  return null;
}

export interface ScopedDashboardView {
  kind: "team" | "own";
  /** DB-provided scope label (team display name / recruiter display name). */
  scopeLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  scopeNote: string;
  emptyTitle: string;
  emptyDescription: string;
  /** Member contribution ranking (team roster). */
  showMemberRanking: boolean;
  /** project x provider (HRP/Vendor) mix card. */
  showProjectProviderMix: boolean;
  /** Legacy-only recruiter filter. */
  showRecruiterFilter: boolean;
}

export type DashboardMode =
  | { kind: "error" }
  | { kind: "all" }
  | { kind: "team"; view: ScopedDashboardView }
  | { kind: "own"; view: ScopedDashboardView };

/**
 * Decide what the dashboard may render. A failed read, or a successful read
 * without a usable audience, is an error mode: no facts are rendered and no
 * scope is claimed.
 */
export function resolveDashboardMode(input: {
  ok: boolean;
  audience: ReportingAudience | null;
}): DashboardMode {
  if (!input.ok) return { kind: "error" };
  const audience = input.audience;
  if (!audience) return { kind: "error" };
  if (audience.kind === "all") return { kind: "all" };
  if (audience.kind === "team" || audience.kind === "own") {
    return { kind: audience.kind, view: resolveScopedDashboardView(audience) };
  }
  return { kind: "error" };
}

/**
 * Describe the scoped (team/own) dashboard. Only a DB-confirmed team/own
 * audience reaches this helper; the BoD (company-wide) view is rendered by the
 * BoD dashboard itself.
 */
export function resolveScopedDashboardView(
  audience: ReportingAudience,
): ScopedDashboardView {
  const scopeLabel = audience.label;
  if (audience.kind === "team") {
    return {
      kind: "team",
      scopeLabel,
      eyebrow: "Trưởng nhóm · Báo cáo nhóm",
      title: "Tổng quan nhóm " + scopeLabel,
      description:
        "Số người tuyển của (các) nhóm được cấp theo ngày, dự án, thành viên và loại hình làm việc. Chỉ trong phạm vi nhóm được cấp.",
      scopeNote: "Đang xem dữ liệu trong phạm vi nhóm được cấp: " + scopeLabel + ".",
      emptyTitle: "Nhóm chưa có dữ liệu tuyển dụng",
      emptyDescription:
        "Nhóm chưa có dữ liệu trong phạm vi được cấp. Hãy điều chỉnh bộ lọc hoặc tải lại trang sau.",
      showMemberRanking: true,
      showProjectProviderMix: true,
      showRecruiterFilter: true,
    };
  }
  return {
    kind: "own",
    scopeLabel,
    eyebrow: "Cá nhân · Báo cáo của tôi",
    title: "Tổng quan cá nhân",
    description:
      "Số người bạn đã tuyển theo ngày, dự án và loại hình làm việc. Chỉ dữ liệu gắn với hồ sơ tuyển dụng của bạn.",
    scopeNote: "Đang xem dữ liệu gắn với " + scopeLabel + ".",
    emptyTitle: "Bạn chưa có dữ liệu tuyển dụng",
    emptyDescription:
      "Chưa có dữ liệu gắn với hồ sơ tuyển dụng của bạn. Hãy điều chỉnh bộ lọc hoặc tải lại trang sau.",
    showMemberRanking: false,
    showProjectProviderMix: false,
    showRecruiterFilter: false,
  };
}

/**
 * Member contribution rows for the team roster: sorted desc, with share of the
 * team total. Pure so the ranking contract is testable.
 */
export interface MemberContributionRow {
  key: string;
  display: string;
  count: number;
  share: number | null;
}

export function buildMemberContributions(
  buckets: Record<string, { key: string; display: string; recruitedCount: number }>,
): MemberContributionRow[] {
  const rows = Object.values(buckets)
    .map((b) => ({ key: b.key, display: b.display, count: b.recruitedCount }))
    .sort((a, b) =>
      a.count !== b.count ? b.count - a.count : a.display.localeCompare(b.display, "vi"),
    );
  const total = rows.reduce((a, r) => a + r.count, 0);
  return rows.map((r) => ({
    key: r.key,
    display: r.display,
    count: r.count,
    share: total > 0 ? r.count / total : null,
  }));
}
