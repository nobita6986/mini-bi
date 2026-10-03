/**
 * P1.5-W05-S01-R1 — ReportView (presentational). Viet bang createElement de test render bang Node
 * (renderToStaticMarkup) ma khong can JSX loader. Dung chung cho panel va component test.
 */

import { createElement as h, type ReactNode } from "react";

import {
  confidenceLabel,
  findingCategoryLabel,
  groupFindings,
  lifecycleLabel,
  type AnalysisView,
  type Finding,
} from "../../lib/ai-report/report-contract.ts";

const card = "rounded-2xl border border-border bg-surface p-3";
const h4 = "text-sm font-semibold text-foreground";

function findingList(finding: Finding): ReactNode {
  return h(
    "li",
    { key: finding.finding_id, className: "rounded-lg border border-border/60 p-2 text-sm" },
    h(
      "div",
      { className: "flex items-center justify-between gap-2" },
      h("span", { className: "font-medium text-foreground" }, finding.headline),
      h("span", { className: "text-xs text-muted" }, findingCategoryLabel(finding.category) + " · " + confidenceLabel(finding.confidence))
    ),
    h("p", { className: "mt-1 text-foreground" }, finding.analysis),
    finding.recommended_action ? h("p", { className: "mt-1 text-muted" }, "Đề xuất: " + finding.recommended_action) : null,
    finding.limitations.length > 0 ? h("p", { className: "mt-1 text-xs text-muted" }, "Giới hạn: " + finding.limitations.join(" · ")) : null,
    h("p", { className: "mt-1 text-xs text-muted" }, "Minh chứng: " + finding.evidence_refs.join(", "))
  );
}

export function ReportView({ analysis, lifecycle }: { analysis: AnalysisView; lifecycle: string | null }) {
  return h(
    "section",
    { "aria-label": "Nội dung báo cáo", className: "flex flex-col gap-3" },
    h(
      "div",
      { className: "flex items-center justify-between gap-2" },
      h("span", { className: "inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-xs font-medium text-foreground" }, lifecycleLabel(lifecycle)),
      lifecycle === "draft" ? h("p", { className: "text-xs text-muted" }, "Bản nháp do AI tạo, chưa phải dữ liệu đã duyệt.") : null
    ),
    h(
      "div",
      { className: card },
      h("h4", { className: h4 }, "Tóm tắt điều hành"),
      h("p", { className: "mt-1 whitespace-pre-wrap text-sm text-foreground" }, analysis.executive_analysis),
      h("p", { className: "mt-2 text-xs text-muted" }, "Kỳ báo cáo: " + analysis.period_ref)
    ),
    ...groupFindings(analysis.findings).map((group) =>
      h(
        "div",
        { key: group.key, className: card },
        h("h4", { className: h4 }, group.label),
        h("ul", { className: "mt-2 space-y-2" }, group.items.map((finding) => findingList(finding)))
      )
    ),
    analysis.overall_limitations.length > 0
      ? h(
          "div",
          { className: card },
          h("h4", { className: h4 }, "Cảnh báo dữ liệu"),
          h("ul", { className: "mt-2 list-disc pl-5 text-sm text-foreground" }, analysis.overall_limitations.map((limitation, index) => h("li", { key: index }, limitation)))
        )
      : null
  );
}
