/**
 * P1.5-W05-S01 — Thuần: contract phía client cho UI báo cáo AI.
 *
 * KHÔNG import module server-only / "@/" — dùng chung cho client component và test.
 * Chỉ map trạng thái/mã lỗi thành nhãn tiếng Việt an toàn; KHÔNG chứa secret/PII.
 */

export const PERIOD_TYPES = ["week", "month", "quarter", "custom"] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];

export const DIMENSIONS = ["project", "recruiter", "team", "provider", "employment"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  project: "Dự án",
  recruiter: "Người tuyển",
  team: "Nhóm",
  provider: "HRP/Vendor",
  employment: "Loại hình",
};

export const ACTIVE_JOB_STATUSES = ["requested", "queued", "computing", "ai_generating", "validating"] as const;
export const FAILED_JOB_STATUSES = [
  "failed_input",
  "failed_config",
  "failed_provider_transient",
  "failed_provider_permanent",
  "failed_validation",
  "failed_budget",
  "failed_internal",
] as const;

export const JOB_STATUS_LABELS: Record<string, string> = {
  requested: "Đã nhận",
  queued: "Đang chờ",
  computing: "Đang chuẩn bị dữ liệu",
  ai_generating: "AI đang phân tích",
  validating: "Đang kiểm tra kết quả",
  draft: "Bản nháp AI",
  failed_input: "Thất bại: đầu vào không hợp lệ",
  failed_config: "Thất bại: cấu hình",
  failed_provider_transient: "Thất bại: nhà cung cấp tạm thời",
  failed_provider_permanent: "Thất bại: nhà cung cấp",
  failed_validation: "Thất bại: kết quả không đạt chuẩn",
  failed_budget: "Thất bại: ngân sách/trần",
  failed_internal: "Thất bại: lỗi hệ thống",
};

export function isActiveJobStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && (ACTIVE_JOB_STATUSES as readonly string[]).includes(status);
}

export function isFailedJobStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && (FAILED_JOB_STATUSES as readonly string[]).includes(status);
}

export function jobStatusLabel(status: string | null | undefined): string {
  return JOB_STATUS_LABELS[status ?? ""] ?? (status ?? "không xác định");
}

export const RETRYABLE_CODES = new Set([
  "AI_RATE_LIMITED",
  "AI_CONCURRENCY_LIMITED",
  "AI_PROVIDER_TRANSIENT",
  "AI_PROVIDER_TIMEOUT",
  "AI_BUDGET_LIMITED",
]);

/** Mã lỗi server → thông điệp tiếng Việt ĐÓNG + nhóm hiển thị (không echo chi tiết nội bộ). */
export function codeToMessage(code: string | null | undefined): { text: string; kind: "error" | "config" | "limit" | "unavailable" } {
  switch (code) {
    case "AI_DISABLED":
      return { text: "Báo cáo AI đang tắt.", kind: "unavailable" };
    case "AI_CONFIG_REQUIRED":
      return { text: "Chưa có cấu hình provider hoạt động.", kind: "config" };
    case "AI_SETTINGS_DISABLED":
      return { text: "Bảng cấu hình AI đang tắt.", kind: "unavailable" };
    case "AI_PROVIDER_DISABLED":
      return { text: "Nhà cung cấp AI chưa được bật.", kind: "unavailable" };
    case "AI_RATE_LIMITED":
      return { text: "Đã đạt giới hạn tần suất, thử lại sau.", kind: "limit" };
    case "AI_CONCURRENCY_LIMITED":
      return { text: "Đang có nhiều báo cáo chạy, thử lại sau.", kind: "limit" };
    case "AI_BUDGET_LIMITED":
      return { text: "Đã đạt trần ngân sách/token, thử lại sau.", kind: "limit" };
    case "AI_IDENTITY_CATALOG_REQUIRED":
      return { text: "Báo cáo người tuyển/nhóm cần danh mục định danh (P1.6).", kind: "config" };
    case "AI_JOB_NOT_FOUND":
      return { text: "Không tìm thấy báo cáo.", kind: "error" };
    case "AI_INPUT_INVALID":
      return { text: "Thông tin nhập chưa hợp lệ.", kind: "error" };
    case "AI_INTERNAL":
      return { text: "Lỗi hệ thống, thử lại sau.", kind: "error" };
    default:
      return { text: "Có lỗi khi tạo báo cáo, thử lại sau.", kind: "error" };
  }
}

export type Finding = {
  finding_id: string;
  category: string;
  subject_ref: string;
  headline: string;
  analysis: string;
  evidence_refs: string[];
  confidence: "low" | "medium" | "high";
  limitations: string[];
  recommended_action: string | null;
};

export type AnalysisView = {
  contract_version: string;
  period_ref: string;
  executive_analysis: string;
  executive_evidence_refs: string[];
  findings: Finding[];
  overall_limitations: string[];
};

export const FINDING_CATEGORY_LABELS: Record<string, string> = {
  trend: "Xu hướng",
  driver: "Yếu tố tác động",
  strength: "Điểm mạnh",
  risk: "Rủi ro",
  concentration: "Tập trung",
  provider_mix: "Phụ thuộc Vendor",
  time_pattern: "Thời điểm",
  data_quality: "Chất lượng dữ liệu",
};

export function findingCategoryLabel(category: string): string {
  return FINDING_CATEGORY_LABELS[category] ?? category;
}

export const CONFIDENCE_LABELS: Record<string, string> = {
  low: "Thấp",
  medium: "Trung bình",
  high: "Cao",
};

export function confidenceLabel(confidence: string): string {
  return CONFIDENCE_LABELS[confidence] ?? confidence;
}

export type FindingGroup = { key: string; label: string; items: Finding[] };

/** Gom finding theo nhóm hiển thị: thời điểm · cá nhân · nhóm · phụ thuộc vendor · còn lại. */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups: FindingGroup[] = [
    { key: "time", label: "Thời điểm", items: [] },
    { key: "individual", label: "Cá nhân", items: [] },
    { key: "team", label: "Nhóm", items: [] },
    { key: "vendor", label: "Phụ thuộc Vendor", items: [] },
    { key: "other", label: "Khác", items: [] },
  ];
  for (const finding of findings) {
    if (finding.category === "time_pattern") groups[0].items.push(finding);
    else if (/^recruiter_/.test(finding.subject_ref)) groups[1].items.push(finding);
    else if (/^team_/.test(finding.subject_ref)) groups[2].items.push(finding);
    else if (finding.category === "provider_mix") groups[3].items.push(finding);
    else groups[4].items.push(finding);
  }
  return groups.filter((group) => group.items.length > 0);
}

export type ReportRequestInput = {
  period_type: PeriodType;
  as_of_date: string;
  custom_from?: string;
  custom_to?: string;
  dimensions: Dimension[];
  focus?: string;
};

/** Form → body POST /api/ai/reports (khớp `validateAnalyticsRequest`). */
export function buildReportRequest(input: ReportRequestInput): Record<string, unknown> {
  const period: Record<string, unknown> = { type: input.period_type, as_of_date: input.as_of_date };
  if (input.period_type === "custom") {
    period.custom_from = input.custom_from;
    period.custom_to = input.custom_to;
  }
  const body: Record<string, unknown> = {
    period,
    scope: { dimensions: input.dimensions },
  };
  if (input.focus && input.focus.trim() !== "") {
    body.focus = input.focus.trim().slice(0, 120);
  }
  return body;
}

export type CapabilityView = {
  ai_enabled: boolean;
  config_ready: boolean;
  review: { approve: boolean; reject: boolean; regenerate: boolean; reason: string };
};

export type LifecycleLabel = "draft" | "approved" | "rejected";

export const LIFECYCLE_LABELS: Record<LifecycleLabel, string> = {
  draft: "Bản nháp AI (chưa duyệt)",
  approved: "Đã duyệt",
  rejected: "Đã từ chối",
};

export function lifecycleLabel(status: string | null | undefined): string {
  return LIFECYCLE_LABELS[(status as LifecycleLabel) ?? ""] ?? "—";
}


// ---------------------------------------------------------------------------
// R1 — Strict projection cho response UI (KHÔNG dùng type assertion tin raw JSON)
// ---------------------------------------------------------------------------

export type UiRevisionView = {
  revision_id: string;
  revision_number: number;
  lifecycle_status: string;
  contract_version: string;
  created_at: string;
  analysis: AnalysisView;
};

export type UiReportView = {
  job_id: string;
  status: string;
  error_code: string | null;
  attempts: number;
  max_attempts: number;
  revision: UiRevisionView | null;
};

export type UiReportResult = { ok: true; view: UiReportView } | { ok: false; code: "AI_INTERNAL"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAnalysis(raw: unknown): AnalysisView | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.contract_version !== "string" || raw.contract_version === "") return null;
  if (typeof raw.period_ref !== "string") return null;
  if (typeof raw.executive_analysis !== "string") return null;
  const executiveRefs = raw.executive_evidence_refs;
  if (!Array.isArray(executiveRefs) || !executiveRefs.every((value) => typeof value === "string")) return null;
  const findingsRaw = raw.findings;
  if (!Array.isArray(findingsRaw)) return null;
  const findings: Finding[] = [];
  for (const item of findingsRaw) {
    if (!isRecord(item)) return null;
    if (typeof item.finding_id !== "string" || typeof item.category !== "string" || typeof item.subject_ref !== "string") return null;
    if (typeof item.headline !== "string" || typeof item.analysis !== "string") return null;
    if (!Array.isArray(item.evidence_refs) || !item.evidence_refs.every((value) => typeof value === "string")) return null;
    if (item.confidence !== "low" && item.confidence !== "medium" && item.confidence !== "high") return null;
    if (!Array.isArray(item.limitations) || !item.limitations.every((value) => typeof value === "string")) return null;
    if (item.recommended_action !== null && item.recommended_action !== undefined && typeof item.recommended_action !== "string") return null;
    findings.push({
      finding_id: item.finding_id,
      category: item.category,
      subject_ref: item.subject_ref,
      headline: item.headline,
      analysis: item.analysis,
      evidence_refs: item.evidence_refs,
      confidence: item.confidence,
      limitations: item.limitations,
      recommended_action: (item.recommended_action ?? null) as string | null,
    });
  }
  const limitations = raw.overall_limitations;
  if (!Array.isArray(limitations) || !limitations.every((value) => typeof value === "string")) return null;
  return {
    contract_version: raw.contract_version,
    period_ref: raw.period_ref,
    executive_analysis: raw.executive_analysis,
    executive_evidence_refs: executiveRefs as string[],
    findings,
    overall_limitations: limitations as string[],
  };
}

/** Validate response GET /api/ai/reports/[jobId]/analysis. Malformed ⇒ fail-closed AI_INTERNAL. */
export function projectUiReportResponse(raw: unknown): UiReportResult {
  const fail: UiReportResult = { ok: false, code: "AI_INTERNAL", message: "Dữ liệu báo cáo từ server không hợp lệ." };
  if (!isRecord(raw) || raw.ok !== true) return fail;
  const jobId = raw.job_id;
  const status = raw.status;
  if (typeof jobId !== "string" || jobId === "") return fail;
  if (typeof status !== "string" || status === "") return fail;
  const errorCode = raw.error_code;
  if (errorCode !== null && errorCode !== undefined && typeof errorCode !== "string") return fail;
  if (typeof raw.attempts !== "number" || !Number.isSafeInteger(raw.attempts) || raw.attempts < 0) return fail;
  if (typeof raw.max_attempts !== "number" || !Number.isSafeInteger(raw.max_attempts) || raw.max_attempts < 1) return fail;

  const revisionRaw = raw.revision;
  if (revisionRaw === null || revisionRaw === undefined) {
    return {
      ok: true,
      view: {
        job_id: jobId,
        status,
        error_code: typeof errorCode === "string" ? errorCode : null,
        attempts: raw.attempts,
        max_attempts: raw.max_attempts,
        revision: null,
      },
    };
  }
  if (!isRecord(revisionRaw)) return fail;
  if (typeof revisionRaw.revision_id !== "string" || revisionRaw.revision_id === "") return fail;
  if (typeof revisionRaw.revision_number !== "number" || !Number.isSafeInteger(revisionRaw.revision_number) || revisionRaw.revision_number < 1) return fail;
  if (typeof revisionRaw.lifecycle_status !== "string" || revisionRaw.lifecycle_status === "") return fail;
  if (typeof revisionRaw.contract_version !== "string" || revisionRaw.contract_version === "") return fail;
  if (typeof revisionRaw.created_at !== "string" || revisionRaw.created_at === "") return fail;
  const analysis = parseAnalysis(revisionRaw.analysis);
  if (!analysis) return fail;
  return {
    ok: true,
    view: {
      job_id: jobId,
      status,
      error_code: typeof errorCode === "string" ? errorCode : null,
      attempts: raw.attempts,
      max_attempts: raw.max_attempts,
      revision: {
        revision_id: revisionRaw.revision_id,
        revision_number: revisionRaw.revision_number,
        lifecycle_status: revisionRaw.lifecycle_status,
        contract_version: revisionRaw.contract_version,
        created_at: revisionRaw.created_at,
        analysis,
      },
    },
  };
}

/** Validate response GET /api/ai/reports/capability. Malformed ⇒ fail-closed. */
export function projectCapabilityResponse(raw: unknown): { ok: true; capability: CapabilityView } | { ok: false; code: "AI_INTERNAL"; message: string } {
  const fail = { ok: false as const, code: "AI_INTERNAL" as const, message: "Dữ liệu capability từ server không hợp lệ." };
  if (!isRecord(raw) || raw.ok !== true) return fail;
  const aiEnabled = raw.ai_enabled;
  const configReady = raw.config_ready;
  if (typeof aiEnabled !== "boolean" || typeof configReady !== "boolean") return fail;
  const review = raw.review;
  const reviewView = {
    approve: isRecord(review) && review.approve === true,
    reject: isRecord(review) && review.reject === true,
    regenerate: isRecord(review) ? review.regenerate !== false : true,
    reason: isRecord(review) && typeof review.reason === "string" ? review.reason : "review_rpc_pending",
  };
  return { ok: true, capability: { ai_enabled: aiEnabled, config_ready: configReady, review: reviewView } };
}
