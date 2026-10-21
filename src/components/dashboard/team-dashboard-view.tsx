import type { ScopedDashboardView } from "@/lib/reporting/p3-w06c-audience-view";
import type { PeriodComparisonResult } from "@/lib/reporting/p1-period-comparison";
import type { WorkforceReportingResult } from "@/lib/reporting/wf01-workforce-snapshot";
import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { TeamReportView, type TeamReportViewConfig } from "./team-report-view";

/**
 * P3-W06C / P3-W06D-R2 - Team dashboard (audience `team`).
 *
 * The Team Leader report is now a thin adapter over the single shared
 * `TeamReportView`, so the Team Leader and the BoD "Báo cáo chi tiết nhóm" tab
 * render exactly one report implementation. The scope is stated up front and
 * every number/filter option comes from the W05A scoped payload, so the view
 * cannot widen beyond the team scope.
 */

function teamReportConfig(view: ScopedDashboardView): TeamReportViewConfig {
  return {
    eyebrow: view.eyebrow,
    title: view.title,
    description: view.description,
    scopeNote: view.scopeNote,
    emptyTitle: view.emptyTitle,
    emptyDescription: view.emptyDescription,
    noMatchesDetail: "Không có ngày/dự án/thành viên nào trong nhóm khớp bộ lọc đang chọn.",
    showMemberRanking: view.showMemberRanking,
    showProjectProviderMix: view.showProjectProviderMix,
    showRecruiterFilter: view.showRecruiterFilter,
    requireTeamSelection: false,
    kpiAriaLabel: "Chỉ số nhóm",
    kpiPrimaryLabel: "Tuyển mới trong nhóm",
    kpiPrimaryHint: "lượt tuyển ghi nhận",
    kpiSecondaryLabel: "Recruiter có phát sinh tuyển",
    kpiSecondaryHint: "trong phạm vi nhóm",
    memberTitle: "Đóng góp của thành viên nhóm",
    memberDescription: "Xếp hạng số người tuyển của từng thành viên trong phạm vi nhóm được cấp.",
    memberAriaLabel: "Đóng góp của thành viên nhóm",
    pickerHeading: "Tuyển dụng theo nhóm",
    pickerDescription: "Chọn một nhóm để xem báo cáo và các dòng chi tiết đã được máy chủ làm sạch.",
    pickerTitle: "Danh sách nhóm",
  };
}

export function TeamDashboardView({
  data,
  generatedAt,
  comparison,
  workforce,
  optionsResult,
  view,
}: {
  data: ReportingData;
  generatedAt: string;
  comparison?: PeriodComparisonResult;
  workforce?: WorkforceReportingResult;
  optionsResult: ReportingOptionsResult;
  view: ScopedDashboardView;
}) {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6">
      <TeamReportView
        data={data}
        generatedAt={generatedAt}
        comparison={comparison}
        workforce={workforce}
        optionsResult={optionsResult}
        view={teamReportConfig(view)}
      />
    </main>
  );
}
