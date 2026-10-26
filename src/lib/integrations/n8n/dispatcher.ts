import "server-only";

import { createProjectTeamScopeRepository } from "../../admin/project-team-scope-repository.ts";
import { createServiceAttendanceAdminReportRepository } from "../../attendance/attendance-report-repository.ts";
import {
  isCccdReviewStatusFilter,
  type CccdReviewStatusFilter,
} from "../../direct-entry/cccd-review-contract.ts";
import { createCccdReviewRepository } from "../../direct-entry/cccd-review-repository.ts";
import { createDuplicateCccdReportRepository } from "../../direct-entry/duplicate-cccd-report-repository.ts";
import { createLaborTypeCatalogRepository } from "../../direct-entry/labor-type-catalog-repository.ts";
import { createPersonnelCatalogRepository } from "../../direct-entry/personnel-catalog-repository.ts";
import { createProjectAdminRepository } from "../../direct-entry/project-admin-repository.ts";
import { createTeamCatalogRepository } from "../../direct-entry/team-catalog-repository.ts";
import { createVendorCatalogRepository } from "../../direct-entry/vendor-catalog-repository.ts";
import { createWorkerDirectoryRepository } from "../../direct-entry/worker-directory-repository.ts";
import { createWorkerEpisodeLookupRepository } from "../../direct-entry/worker-episode-lookup-repository.ts";
import { createDirectEntryWriteRepository } from "../../direct-entry/write-repository.ts";
import type { DirectEntryActor } from "../../auth/direct-entry-v2.ts";
import type { ReportingBucket, ReportingData } from "../../reporting/p1-reporting.ts";
import type { fetchReporting as FetchP1ReportingFn } from "../../reporting/p1-reporting-server.ts";
import { P2_W04A_CUTOVER_DATE } from "../../reporting/p2-w04a-cutover.ts";
import type { CutoverFetchResult } from "../../reporting/p2-w04a-reporting-server.ts";
import type { fetchPipelineCheck as FetchPipelineCheckFn } from "../../reporting/pipeline-check-server.ts";
import type { WorkforceReportingResult } from "../../reporting/wf01-workforce-snapshot.ts";
import {
  vendorFinanceHttpStatusForError,
  type VendorFinanceBalanceFilter,
  type VendorFinanceEntryType,
} from "../../vendor-finance/vendor-finance-contract.ts";
import { createVendorFinanceRepository } from "../../vendor-finance/vendor-finance-repository.ts";
import {
  createAnalyticsRepository,
  type WorkReportAnalyticsFinality,
  type WorkReportAnalyticsGroupBy,
} from "../../work-reports/analytics-repository.ts";
import { createAssignmentRepository } from "../../work-reports/assignment-repository.ts";
import {
  createReportReaderRepository,
  WORK_REPORT_READABLE_STATES,
  type WorkReportReadableState,
} from "../../work-reports/report-reader-repository.ts";
import { createSubmissionRepository } from "../../work-reports/submission-repository.ts";
import { createWorkReportTemplateRepository } from "../../work-reports/template-repository.ts";
import { createOffboardingReportRepository } from "../../workforce/offboarding-report-repository.ts";
import { runWithSupabaseAbortSignal } from "../../supabase/server.ts";

import {
  N8N_BOD_READONLY_PRINCIPAL,
  resolveN8nBodServiceActor,
  type N8nInternalActorRef,
} from "./auth.ts";
import {
  currentHoChiMinhBusinessDate,
  N8N_BOD_BUSINESS_TIMEZONE,
  N8N_BOD_CATALOG_VERSION,
} from "./catalog.ts";
import {
  applyResidualFiltersAndSort,
  decodeN8nCursor,
  encodeN8nCursor,
  findEqFilterBoolean,
  findEqFilterString,
  findSearchFilterString,
  parseAndValidateN8nQuerySpec,
  projectAndRedactRows,
  type ValidatedN8nQuerySpec,
} from "./query-contract.ts";

export const MAX_N8N_REQUEST_BODY_BYTES = 65536;
export const MAX_N8N_RESPONSE_BYTES = 1048576;
export const DEFAULT_N8N_QUERY_TIMEOUT_MS = 15000;

export type N8nCompletenessStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "EMPTY"
  | "DEGRADED";

export type N8nQuerySuccessEnvelope = {
  ok: true;
  catalog_version: typeof N8N_BOD_CATALOG_VERSION;
  principal: typeof N8N_BOD_READONLY_PRINCIPAL;
  dataset: string;
  domain: string;
  mode: "aggregate" | "detail" | "both";
  source: {
    canonical_name: string;
    kind: "rpc" | "read_model";
    cutoff_date: string | null;
    subledger_grain: string | null;
  };
  generated_at: string;
  business_timezone: typeof N8N_BOD_BUSINESS_TIMEZONE;
  as_of_date: string;
  date_range: {
    from: string | null;
    to: string | null;
  };
  completeness: {
    status: N8nCompletenessStatus;
    is_complete: boolean;
    missing_or_warnings: readonly string[];
    notes: readonly string[];
  };
  summary: Record<string, unknown> | null;
  row_count: number;
  rows: readonly Record<string, unknown>[];
  pagination: {
    page_size: number;
    has_more: boolean;
    next_cursor: string | null;
    total_matching: number | null;
  };
  sensitivity: {
    requested_sensitive_fields: readonly string[];
    redacted_sensitive_fields: readonly string[];
    media_policy: "METADATA_ONLY_NO_BULK_MEDIA";
  };
};

export type N8nQueryErrorEnvelope = {
  ok: false;
  catalog_version: typeof N8N_BOD_CATALOG_VERSION;
  principal: typeof N8N_BOD_READONLY_PRINCIPAL;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type N8nAdapterExecutionResult = {
  as_of_date: string;
  date_range: { from: string | null; to: string | null };
  summary: Record<string, unknown> | null;
  rows: readonly Record<string, unknown>[];
  has_more: boolean;
  next_cursor: string | null;
  total_matching: number | null;
  warnings?: readonly string[];
  notes?: readonly string[];
  degraded?: boolean;
};

export type N8nDatasetAdapter = (
  spec: ValidatedN8nQuerySpec,
  context: {
    actor: N8nInternalActorRef;
    businessDate: string;
    signal?: AbortSignal;
  },
) => Promise<
  | { ok: true; data: N8nAdapterExecutionResult }
  | {
      ok: false;
      status: 400 | 403 | 404 | 422 | 503;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    }
>;

export type N8nCutoverReportingCaller = (
  params: Record<string, string | string[] | undefined>,
  actor: N8nInternalActorRef,
) => Promise<CutoverFetchResult>;

export type N8nWorkforceReportingCaller = (input: {
  actor: N8nInternalActorRef;
  from?: string;
  to?: string;
  asOf?: string;
  projectId?: string;
  recruiterId?: string;
  providerType?: string;
  projectPageSize?: number;
}) => Promise<WorkforceReportingResult>;

export type N8nDispatcherDependencies = {
  now?: () => Date;
  timeoutMs?: number;
  resolveActor?: () => Promise<
    | { ok: true; actor: N8nInternalActorRef }
    | { ok: false; code: string; message: string }
  >;
  customAdapters?: Readonly<Record<string, N8nDatasetAdapter>>;
  fetchDirectEntryCutoverReporting?: N8nCutoverReportingCaller;
  fetchP1Reporting?: typeof FetchP1ReportingFn;
  fetchWorkforceSnapshotReporting?: N8nWorkforceReportingCaller;
  fetchPipelineCheck?: typeof FetchPipelineCheckFn;
  offboardingRepo?: ReturnType<typeof createOffboardingReportRepository>;
  workerDirectoryRepo?: ReturnType<typeof createWorkerDirectoryRepository>;
  workerWriteRepo?: ReturnType<typeof createDirectEntryWriteRepository>;
  workerEpisodeLookupRepo?: ReturnType<
    typeof createWorkerEpisodeLookupRepository
  >;
  duplicateCccdRepo?: ReturnType<typeof createDuplicateCccdReportRepository>;
  attendanceRepo?: ReturnType<
    typeof createServiceAttendanceAdminReportRepository
  >;
  vendorFinanceRepo?: ReturnType<typeof createVendorFinanceRepository>;
  cccdReviewRepo?: ReturnType<typeof createCccdReviewRepository>;
  projectAdminRepo?: ReturnType<typeof createProjectAdminRepository>;
  teamCatalogRepo?: ReturnType<typeof createTeamCatalogRepository>;
  projectTeamScopeRepo?: ReturnType<typeof createProjectTeamScopeRepository>;
  personnelCatalogRepo?: ReturnType<typeof createPersonnelCatalogRepository>;
  vendorCatalogRepo?: ReturnType<typeof createVendorCatalogRepository>;
  laborTypeCatalogRepo?: ReturnType<typeof createLaborTypeCatalogRepository>;
  workReportTemplateRepo?: ReturnType<typeof createWorkReportTemplateRepository>;
  workReportAssignmentRepo?: ReturnType<typeof createAssignmentRepository>;
  workReportReaderRepo?: ReturnType<typeof createReportReaderRepository>;
  workReportSubmissionRepo?: ReturnType<typeof createSubmissionRepository>;
  workReportAnalyticsRepo?: ReturnType<typeof createAnalyticsRepository>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskTail4(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 4) return null;
  return `••••••••${trimmed.slice(-4)}`;
}

function extractTriStateString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    isRecord(value) &&
    value.state === "provided" &&
    typeof value.value === "string"
  ) {
    return value.value;
  }
  return null;
}

function paginateInMemoryRows(
  rows: readonly Record<string, unknown>[],
  spec: ValidatedN8nQuerySpec,
): {
  slice: Record<string, unknown>[];
  has_more: boolean;
  next_cursor: string | null;
  total_matching: number;
} {
  const offset =
    spec.cursor?.kind === "offset" && typeof spec.cursor.offset === "number"
      ? spec.cursor.offset
      : 0;
  const slice = rows.slice(offset, offset + spec.page_size);
  const nextOffset = offset + slice.length;
  const hasMore = nextOffset < rows.length;
  const nextCursor = hasMore
    ? encodeN8nCursor({
        dataset: spec.dataset,
        kind: "offset",
        offset: nextOffset,
      })
    : null;
  return {
    slice,
    has_more: hasMore,
    next_cursor: nextCursor,
    total_matching: rows.length,
  };
}

function filterSummaryMeasures(
  summary: Record<string, unknown> | null,
  spec: ValidatedN8nQuerySpec,
): Record<string, unknown> | null {
  if (!summary) return null;
  if (spec.mode === "detail" && spec.measures.length === 0) {
    return null;
  }
  return summary;
}

function extractReportingRowsAndKpis(
  data: ReportingData,
  dimSet: ReadonlySet<string>,
  options?: { maskDateOnOrAfter?: string },
): {
  rows: Record<string, unknown>[];
  recruitedTotal: number;
  hrpCount: number;
  vendorCount: number;
  hrpShare: number | null;
  vendorShare: number | null;
  knownCoverage: number | null;
  coverageRatio: number | null;
} {
  const maskCutoff = options?.maskDateOnOrAfter;
  const includeAllDims = dimSet.size === 0;
  const rows: Record<string, unknown>[] = [];

  let maskedDateDeduction = 0;
  for (const [reportDate, rawCount] of Object.entries(data.byDate)) {
    const isMasked = Boolean(maskCutoff && reportDate >= maskCutoff);
    if (isMasked) {
      maskedDateDeduction += rawCount;
    }
    const count = isMasked ? 0 : rawCount;
    if (includeAllDims || dimSet.has("date")) {
      rows.push({
        row_kind: "by_date",
        report_date: reportDate,
        dimension: "date",
        key: reportDate,
        label: reportDate,
        recruited_total: count,
        hrp_count: null,
        vendor_count: null,
        hrp_share: null,
        vendor_share: null,
        share_of_total:
          data.recruitedTotal - maskedDateDeduction > 0
            ? count / (data.recruitedTotal - maskedDateDeduction)
            : null,
        previous_recruited_total: null,
        delta: null,
        delta_pct: null,
      });
    }
  }

  const effectiveTotal = Math.max(0, data.recruitedTotal - maskedDateDeduction);
  const scaleFactor =
    data.recruitedTotal > 0 ? effectiveTotal / data.recruitedTotal : 1;
  const hrpCount = Math.round(
    (data.byProvider.hrp?.recruitedCount ?? 0) * scaleFactor,
  );
  const vendorCount = Math.round(
    (data.byProvider.vendor?.recruitedCount ?? 0) * scaleFactor,
  );
  const knownTotal = hrpCount + vendorCount;
  const hrpShare = knownTotal > 0 ? hrpCount / knownTotal : null;
  const vendorShare = knownTotal > 0 ? vendorCount / knownTotal : null;
  const knownCoverage =
    effectiveTotal > 0 ? knownTotal / effectiveTotal : null;

  const mixByProject = new Map(
    data.projectProviderMix.map((m) => [m.projectKey, m]),
  );

  const bucketGroups: Array<{
    dim: string;
    rowKind: string;
    buckets: Record<string, ReportingBucket>;
  }> = [
    { dim: "project", rowKind: "by_project", buckets: data.byProject },
    { dim: "recruiter", rowKind: "by_recruiter", buckets: data.byRecruiter },
    { dim: "team", rowKind: "by_team", buckets: data.byTeam },
    {
      dim: "labor_type",
      rowKind: "by_labor_type",
      buckets: data.byEmployment,
    },
    {
      dim: "provider_type",
      rowKind: "by_provider",
      buckets: data.byProvider,
    },
  ];

  for (const g of bucketGroups) {
    if (!includeAllDims && !dimSet.has(g.dim)) continue;
    for (const bucket of Object.values(g.buckets)) {
      const scaledCount = Math.round(bucket.recruitedCount * scaleFactor);
      const projMix =
        g.dim === "project" ? mixByProject.get(bucket.key) : undefined;
      rows.push({
        row_kind: g.rowKind,
        report_date: null,
        dimension: g.dim,
        key: bucket.key,
        label: bucket.display,
        recruited_total: scaledCount,
        hrp_count: projMix
          ? Math.round(projMix.hrpCount * scaleFactor)
          : null,
        vendor_count: projMix
          ? Math.round(projMix.vendorCount * scaleFactor)
          : null,
        hrp_share: projMix?.hrpShare ?? null,
        vendor_share: projMix?.vendorShare ?? null,
        share_of_total:
          effectiveTotal > 0 ? scaledCount / effectiveTotal : null,
        previous_recruited_total: null,
        delta: null,
        delta_pct: null,
      });
    }
  }

  return {
    rows,
    recruitedTotal: effectiveTotal,
    hrpCount,
    vendorCount,
    hrpShare,
    vendorShare,
    knownCoverage,
    coverageRatio: data.coverage.coverageRatio,
  };
}

function toDirectEntryActor(actor: N8nInternalActorRef): DirectEntryActor {
  return {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    display_name: N8N_BOD_READONLY_PRINCIPAL,
    enabled: true,
    capabilities: [],
    scopes: [],
    self_recruiter_suggestion: null,
    session: {
      provider: "supabase",
      verification: "getUser",
      authenticated_at: null,
    },
  };
}

function createDefaultAdapters(
  deps: N8nDispatcherDependencies,
): Record<string, N8nDatasetAdapter> {
  const callCutoverReporting: N8nCutoverReportingCaller =
    deps.fetchDirectEntryCutoverReporting ??
    (async (params, actor) => {
      const mod = await import("../../reporting/p2-w04a-reporting-server.ts");
      return mod.fetchCutoverReporting(params, toDirectEntryActor(actor));
    });
  const callP1Reporting: typeof FetchP1ReportingFn =
    deps.fetchP1Reporting ??
    (async (params) => {
      const mod = await import("../../reporting/p1-reporting-server.ts");
      return mod.fetchReporting(params);
    });
  const callWorkforceReporting: N8nWorkforceReportingCaller =
    deps.fetchWorkforceSnapshotReporting ??
    (async (input) => {
      const [
        { resolveWorkforceDeepReportingForActor },
        { createServiceSupabaseClient },
      ] = await Promise.all([
        import("../../reporting/wf01-workforce-snapshot.ts"),
        import("../../supabase/server.ts"),
      ]);
      const sb = createServiceSupabaseClient();
      const normalizedProvider:
        | "hrp"
        | "vendor"
        | "__unknown__"
        | "__invalid__"
        | undefined =
        input.providerType === "hrp" ||
        input.providerType === "vendor" ||
        input.providerType === "__unknown__" ||
        input.providerType === "__invalid__"
          ? input.providerType
          : input.providerType
            ? "__invalid__"
            : undefined;
      return resolveWorkforceDeepReportingForActor({
        actor: input.actor,
        filters: {
          from: input.from,
          to: input.asOf ?? input.to,
          project: input.projectId,
          recruiter: input.recruiterId,
          provider: normalizedProvider,
        },
        projectLimit: input.projectPageSize,
        callWorkforceRpc: (args) =>
          sb.rpc("direct_entry_workforce_scoped_reporting", args),
      });
    });
  const callPipelineCheck: typeof FetchPipelineCheckFn =
    deps.fetchPipelineCheck ??
    (async () => {
      const mod = await import("../../reporting/pipeline-check-server.ts");
      return mod.fetchPipelineCheck();
    });

  const offboardingRepo =
    deps.offboardingRepo ?? createOffboardingReportRepository();
  const workerDirectoryRepo =
    deps.workerDirectoryRepo ?? createWorkerDirectoryRepository();
  const workerWriteRepo =
    deps.workerWriteRepo ?? createDirectEntryWriteRepository();
  const workerEpisodeLookupRepo =
    deps.workerEpisodeLookupRepo ?? createWorkerEpisodeLookupRepository();
  const duplicateCccdRepo =
    deps.duplicateCccdRepo ?? createDuplicateCccdReportRepository();
  const attendanceRepo =
    deps.attendanceRepo ?? createServiceAttendanceAdminReportRepository();
  const vendorFinanceRepo =
    deps.vendorFinanceRepo ?? createVendorFinanceRepository();
  const cccdReviewRepo = deps.cccdReviewRepo ?? createCccdReviewRepository();
  const projectAdminRepo =
    deps.projectAdminRepo ?? createProjectAdminRepository();
  const teamCatalogRepo = deps.teamCatalogRepo ?? createTeamCatalogRepository();
  const projectTeamScopeRepo =
    deps.projectTeamScopeRepo ?? createProjectTeamScopeRepository();
  const personnelCatalogRepo =
    deps.personnelCatalogRepo ?? createPersonnelCatalogRepository();
  const vendorCatalogRepo =
    deps.vendorCatalogRepo ?? createVendorCatalogRepository();
  const laborTypeCatalogRepo =
    deps.laborTypeCatalogRepo ?? createLaborTypeCatalogRepository();
  const workReportTemplateRepo =
    deps.workReportTemplateRepo ?? createWorkReportTemplateRepository();
  const workReportAssignmentRepo =
    deps.workReportAssignmentRepo ?? createAssignmentRepository();
  const workReportReaderRepo =
    deps.workReportReaderRepo ?? createReportReaderRepository();
  const workReportSubmissionRepo =
    deps.workReportSubmissionRepo ?? createSubmissionRepository();
  const workReportAnalyticsRepo =
    deps.workReportAnalyticsRepo ?? createAnalyticsRepository();

  return {
    // -----------------------------------------------------------------------
    // 1. RECRUITMENT
    // -----------------------------------------------------------------------
    async recruitment_cutover_summary(spec, { actor, businessDate }) {
      const result = await callCutoverReporting(
        {
          from: spec.date_range?.from,
          to: spec.date_range?.to,
          project: findEqFilterString(spec.filters, "project_key") ?? undefined,
          recruiter:
            findEqFilterString(spec.filters, "recruiter_key") ?? undefined,
          team: findEqFilterString(spec.filters, "team_key") ?? undefined,
          employment:
            findEqFilterString(spec.filters, "labor_type_key") ?? undefined,
          provider:
            findEqFilterString(spec.filters, "provider_type") ?? undefined,
        },
        actor,
      );

      if (!result.ok) {
        return {
          ok: false,
          status: 503,
          code: result.code,
          message: result.message,
        };
      }

      const dimSet = new Set(spec.dimensions);
      const extracted = extractReportingRowsAndKpis(result.data, dimSet);

      const pushed = new Set([
        "project_key",
        "recruiter_key",
        "team_key",
        "labor_type_key",
        "employment_status_key",
        "provider_type",
      ]);
      const filteredRows = applyResidualFiltersAndSort(
        extracted.rows,
        spec,
        pushed,
      );
      const paged = paginateInMemoryRows(filteredRows, spec);

      const comp =
        result.comparison && result.comparison.status === "ready"
          ? {
              previous_date_from: result.comparison.window.previousFrom,
              previous_date_to: result.comparison.window.previousTo,
              previous_recruited_total: result.comparison.previousTotal,
              recruited_delta: result.comparison.deltaAbs,
              recruited_delta_pct: result.comparison.deltaPct,
            }
          : null;

      return {
        ok: true,
        data: {
          as_of_date: result.data.applied.to ?? businessDate,
          date_range: {
            from: result.data.applied.from ?? null,
            to: result.data.applied.to ?? null,
          },
          summary: {
            cutoff_date: P2_W04A_CUTOVER_DATE,
            recruited_total: extracted.recruitedTotal,
            hrp_count: extracted.hrpCount,
            vendor_count: extracted.vendorCount,
            hrp_share: extracted.hrpShare,
            vendor_share: extracted.vendorShare,
            known_coverage: extracted.knownCoverage,
            coverage_ratio: extracted.coverageRatio,
            comparison: comp,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
          notes: [
            `Nguồn Direct Entry có hiệu lực từ ngày cutover ${P2_W04A_CUTOVER_DATE}. Không cộng trùng với nguồn legacy.`,
          ],
        },
      };
    },

    async recruitment_legacy_summary(spec, { businessDate }) {
      const maskPostCutover =
        findEqFilterBoolean(spec.filters, "mask_post_cutover") ?? true;
      const result = await callP1Reporting({
        from: spec.date_range?.from,
        to: spec.date_range?.to,
        project: findEqFilterString(spec.filters, "project_key") ?? undefined,
        recruiter:
          findEqFilterString(spec.filters, "recruiter_key") ?? undefined,
        employment:
          findEqFilterString(spec.filters, "labor_type_key") ?? undefined,
      });

      if (!result.ok) {
        return {
          ok: false,
          status: 503,
          code: result.code,
          message: result.message,
        };
      }

      const dimSet = new Set(spec.dimensions);
      const extracted = extractReportingRowsAndKpis(result.data, dimSet, {
        maskDateOnOrAfter: maskPostCutover ? P2_W04A_CUTOVER_DATE : undefined,
      });

      const pushed = new Set([
        "project_key",
        "recruiter_key",
        "labor_type_key",
        "employment_status_key",
        "mask_post_cutover",
      ]);
      const filteredRows = applyResidualFiltersAndSort(
        extracted.rows,
        spec,
        pushed,
      );
      const paged = paginateInMemoryRows(filteredRows, spec);

      const warnings: string[] = [];
      if (!maskPostCutover) {
        warnings.push(
          `mask_post_cutover=false: Dữ liệu nguồn legacy từ ngày ${P2_W04A_CUTOVER_DATE} trở đi chỉ dùng để kiểm toán lịch sử đồng bộ; TUYỆT ĐỐI KHÔNG cộng với dữ liệu Direct Entry.`,
        );
      }

      return {
        ok: true,
        data: {
          as_of_date: result.data.applied.to ?? businessDate,
          date_range: {
            from: result.data.applied.from ?? null,
            to: result.data.applied.to ?? null,
          },
          summary: {
            cutoff_date: P2_W04A_CUTOVER_DATE,
            mask_post_cutover: maskPostCutover,
            recruited_total: extracted.recruitedTotal,
            hrp_count: extracted.hrpCount,
            vendor_count: extracted.vendorCount,
            hrp_share: extracted.hrpShare,
            vendor_share: extracted.vendorShare,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
          warnings,
        },
      };
    },

    async recruitment_cutover_reconciliation(spec, { actor, businessDate }) {
      const [cutoverRes, legacyRes] = await Promise.all([
        callCutoverReporting(
          {
            from: spec.date_range?.from,
            to: spec.date_range?.to,
          },
          actor,
        ),
        callP1Reporting({
          from: spec.date_range?.from,
          to: spec.date_range?.to,
        }),
      ]);

      if (!cutoverRes.ok) {
        return {
          ok: false,
          status: 503,
          code: cutoverRes.code,
          message: cutoverRes.message,
        };
      }
      if (!legacyRes.ok) {
        return {
          ok: false,
          status: 503,
          code: legacyRes.code,
          message: legacyRes.message,
        };
      }

      const legacyMasked = extractReportingRowsAndKpis(
        legacyRes.data,
        new Set(),
        { maskDateOnOrAfter: P2_W04A_CUTOVER_DATE },
      );
      const legacyUnmaskedTotal = legacyRes.data.recruitedTotal;
      const legacyBeforeCutoff = legacyMasked.recruitedTotal;
      const legacyMaskedOut = Math.max(
        0,
        legacyUnmaskedTotal - legacyBeforeCutoff,
      );
      const directEntryAfterCutoff = cutoverRes.data.recruitedTotal;
      const directEntryBeforeCutoffBlocker = 0;
      const combinedNonOverlappingTotal =
        legacyBeforeCutoff + directEntryAfterCutoff;

      const row: Record<string, unknown> = {
        cutoff_date: P2_W04A_CUTOVER_DATE,
        date_from: cutoverRes.data.applied.from ?? null,
        date_to: cutoverRes.data.applied.to ?? null,
        legacy_before_cutoff_total: legacyBeforeCutoff,
        legacy_on_or_after_cutoff_masked_total: legacyMaskedOut,
        direct_entry_before_cutoff_blocker_total:
          directEntryBeforeCutoffBlocker,
        direct_entry_on_or_after_cutoff_total: directEntryAfterCutoff,
        combined_non_overlapping_total: combinedNonOverlappingTotal,
        has_overlap_blocker: directEntryBeforeCutoffBlocker > 0,
      };

      return {
        ok: true,
        data: {
          as_of_date: cutoverRes.data.applied.to ?? businessDate,
          date_range: {
            from: cutoverRes.data.applied.from ?? null,
            to: cutoverRes.data.applied.to ?? null,
          },
          summary: row,
          rows: [row],
          has_more: false,
          next_cursor: null,
          total_matching: 1,
          notes: [
            `Tổng tuyển dụng chuẩn không trùng = legacy_before_cutoff_total (${legacyBeforeCutoff}) + direct_entry_on_or_after_cutoff_total (${directEntryAfterCutoff}) = ${combinedNonOverlappingTotal}.`,
          ],
        },
      };
    },

    // -----------------------------------------------------------------------
    // 2. WORKFORCE
    // -----------------------------------------------------------------------
    async workforce_analytics(spec, { actor, businessDate }) {
      const report = await callWorkforceReporting({
        actor,
        from: spec.date_range?.from,
        to: spec.date_range?.to,
        asOf: spec.as_of_date ?? undefined,
        projectId: findEqFilterString(spec.filters, "project_id") ?? undefined,
        recruiterId:
          findEqFilterString(spec.filters, "recruiter_id") ?? undefined,
        providerType:
          findEqFilterString(spec.filters, "provider_type") ?? undefined,
        projectPageSize: spec.page_size,
      });

      if (report.status !== "ready") {
        return {
          ok: false,
          status: 503,
          code: "WORKFORCE_REPORTING_UNAVAILABLE",
          message:
            report.reason ?? "Không thể truy vấn báo cáo phân tích lực lượng lao động.",
        };
      }

      const rawRows: Record<string, unknown>[] = [];
      const dimSections = [
        ["by_project", report.dimensions.byProject.buckets],
        ["by_team", report.dimensions.byTeam.buckets],
        ["by_recruiter", report.dimensions.byRecruiter.buckets],
        ["by_provider", report.dimensions.byProvider.buckets],
      ] as const;

      for (const [sectionName, buckets] of dimSections) {
        for (const b of buckets) {
          rawRows.push({
            section: sectionName,
            key: b.key,
            label: b.display,
            provider_type: sectionName === "by_provider" ? b.key : null,
            snapshot_total: b.eligibleEpisodeCount,
            working_on_count: b.onCount,
            waiting_unconfirmed_count: b.unconfirmedCount,
            left_off_count: b.offCount,
            active_pool_count: b.onCount + b.unconfirmedCount,
            inflow_on_total: b.everOnEpisodeCount,
            outflow_to_off_count:
              b.exitedFromOnCount + b.exitedWithoutOnEpisodeCount,
            net_working_change: b.onCount - b.exitedFromOnCount,
            off_event_count: null,
            share_of_categorized: null,
            eligible_cohort_size: b.checkpoints.d30.maturedCount,
            retained_count: b.checkpoints.d30.retainedCount,
            retention_rate: b.checkpoints.d30.retentionRate,
          });
        }
      }

      for (const cat of report.leaveReasons.byCategory) {
        rawRows.push({
          section: "leave_reason_categories",
          key: cat.key,
          label: cat.label,
          provider_type: null,
          snapshot_total: null,
          working_on_count: null,
          waiting_unconfirmed_count: null,
          left_off_count: cat.episodeCount,
          active_pool_count: null,
          inflow_on_total: null,
          outflow_to_off_count: null,
          net_working_change: null,
          off_event_count: cat.episodeCount,
          share_of_categorized: cat.shareOfOffRate,
          eligible_cohort_size: null,
          retained_count: null,
          retention_rate: null,
        });
      }

      for (const [horizonKey, cohort] of [
        ["D7", report.retention.checkpoints.d7],
        ["D30", report.retention.checkpoints.d30],
        ["D90", report.retention.checkpoints.d90],
      ] as const) {
        rawRows.push({
          section: "retention_cohorts",
          key: horizonKey,
          label: `Retention ${horizonKey} (${cohort.checkpointDays} ngày)`,
          provider_type: null,
          snapshot_total: cohort.maturedCount + cohort.immatureCount,
          working_on_count: cohort.retainedCount,
          waiting_unconfirmed_count: cohort.immatureCount,
          left_off_count: cohort.exitedCount,
          active_pool_count: null,
          inflow_on_total: null,
          outflow_to_off_count: null,
          net_working_change: null,
          off_event_count: null,
          share_of_categorized: null,
          eligible_cohort_size: cohort.maturedCount,
          retained_count: cohort.retainedCount,
          retention_rate: cohort.retentionRate,
        });
      }

      const pushed = new Set(["project_id", "recruiter_id", "provider_type"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);

      const sectionFilter = findEqFilterString(spec.filters, "section");
      const projPage = report.dimensions.byProject.pagination;
      const useProjectRpcCursor =
        sectionFilter === "by_project" &&
        Boolean(projPage?.hasMore && projPage?.nextCursor);

      const dateFrom = report.transitions.applicable
        ? report.transitions.fromDate
        : spec.date_range?.from ?? null;
      const dateTo = report.transitions.applicable
        ? report.transitions.toDate
        : spec.date_range?.to ?? null;

      if (useProjectRpcCursor && projPage?.nextCursor) {
        return {
          ok: true,
          data: {
            as_of_date: report.snapshot.asOfDate || businessDate,
            date_range: { from: dateFrom, to: dateTo },
            summary: {
              snapshot: report.snapshot,
              transitions: report.transitions,
              balance: report.balance,
              waiting: report.waiting,
              duration: report.duration,
              retention: report.retention,
              leave_reasons: report.leaveReasons,
            },
            rows: filteredRows,
            has_more: true,
            next_cursor: encodeN8nCursor({
              dataset: spec.dataset,
              kind: "token",
              token: projPage.nextCursor,
            }),
            total_matching: projPage.totalCount,
          },
        };
      }

      const paged = paginateInMemoryRows(filteredRows, spec);
      return {
        ok: true,
        data: {
          as_of_date: report.snapshot.asOfDate || businessDate,
          date_range: { from: dateFrom, to: dateTo },
          summary: {
            snapshot: report.snapshot,
            transitions: report.transitions,
            balance: report.balance,
            waiting: report.waiting,
            duration: report.duration,
            retention: report.retention,
            leave_reasons: report.leaveReasons,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
        },
      };
    },

    async workforce_offboarding(spec, { actor }) {
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const outcome = await offboardingRepo.list({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        page,
        page_size: spec.page_size,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: outcome.kind === "invalid" ? 400 : 503,
          code: `OFFBOARDING_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn báo cáo lao động nghỉ việc >= 3 ngày.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.items.map(
        (item) => ({
          employee_code: item.employee_code,
          display_name: item.display_name,
          project_id: item.project_id,
          project_display: item.project_display,
          recruiter_id: item.recruiter_id,
          recruiter_display: item.recruiter_display,
          off_effective_date: item.off_effective_date,
          days_since_off: item.days_since_off,
          phone: item.phone ?? null,
        }),
      );

      const searchFilter = findSearchFilterString(
        spec.filters,
        "search",
      )?.toLowerCase();
      const preFiltered = searchFilter
        ? rawRows.filter(
            (r) =>
              String(r.employee_code).toLowerCase().includes(searchFilter) ||
              String(r.display_name).toLowerCase().includes(searchFilter),
          )
        : rawRows;

      const pushed = new Set(["search"]);
      const filteredRows = applyResidualFiltersAndSort(
        preFiltered,
        spec,
        pushed,
      );
      const hasMore = outcome.data.has_more;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: spec.date_range ?? { from: null, to: null },
          summary: {
            total_workers: outcome.data.total,
            threshold_days: 3,
          },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total,
        },
      };
    },

    // -----------------------------------------------------------------------
    // 3. WORKERS
    // -----------------------------------------------------------------------
    async workers_directory(spec, { actor }) {
      const cursorToken =
        spec.cursor?.kind === "token" ? spec.cursor.token ?? null : null;
      const empStatusRaw = findEqFilterString(
        spec.filters,
        "employment_status",
      )?.toUpperCase();
      const employmentStatus =
        empStatusRaw === "ON" ||
        empStatusRaw === "OFF" ||
        empStatusRaw === "UNCONFIRMED"
          ? empStatusRaw
          : null;

      const outcome = await workerDirectoryRepo.listWorkers({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        scope: "all",
        project_id: findEqFilterString(spec.filters, "project_id"),
        recruiter_id: findEqFilterString(spec.filters, "recruiter_id"),
        employment_status: employmentStatus,
        search: findSearchFilterString(spec.filters, "search"),
        cursor: cursorToken,
        page_size: spec.page_size,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: outcome.kind === "invalid" ? 400 : 503,
          code: `WORKER_DIRECTORY_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh bạ hồ sơ người lao động.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.items.map(
        (item) => ({
          entry_id: item.entry_id,
          entry_version: item.entry_version,
          submission_state: item.submission_state,
          employee_code: item.employee_code,
          display_name: item.display_name,
          project_id: item.project_id,
          project_display: item.project_display,
          first_work_date: item.first_work_date,
          labor_type: item.labor_type,
          labor_type_display: item.labor_type_display,
          employment_status: item.employment_status,
          recruiter_id: item.recruiter_id,
          recruiter_display: item.recruiter_display,
          payment_state: item.payment?.state ?? null,
          bank_id: item.payment?.bank_id ?? null,
          account_number: item.payment?.account_number ?? null,
          account_holder_name: item.payment?.account_holder_name ?? null,
        }),
      );

      const pushed = new Set([
        "project_id",
        "recruiter_id",
        "employment_status",
        "search",
      ]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const nextCursor =
        outcome.data.has_more && outcome.data.next_cursor
          ? encodeN8nCursor({
              dataset: spec.dataset,
              kind: "token",
              token: outcome.data.next_cursor,
            })
          : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: spec.date_range ?? { from: null, to: null },
          summary: outcome.data.summary,
          rows: filteredRows,
          has_more: outcome.data.has_more,
          next_cursor: nextCursor,
          total_matching: outcome.data.summary.total_workers,
        },
      };
    },

    async workers_profile_detail(spec, { actor, businessDate }) {
      const entryId = findEqFilterString(spec.filters, "entry_id");
      if (!entryId) {
        return {
          ok: false,
          status: 400,
          code: "MISSING_REQUIRED_FILTER",
          message: "Bắt buộc truyền filter entry_id.",
        };
      }

      const outcome = await workerWriteRepo.readEntry({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        entry_id: entryId,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status:
            outcome.kind === "not-found"
              ? 404
              : outcome.kind === "invalid"
                ? 400
                : 503,
          code: `WORKER_DETAIL_${outcome.kind.toUpperCase()}`,
          message:
            outcome.kind === "not-found"
              ? "Không tìm thấy hồ sơ đợt làm việc theo entry_id."
              : "Không thể đọc chi tiết hồ sơ đợt làm việc.",
        };
      }

      const raw = isRecord(outcome.data) ? outcome.data : {};
      const wd = isRecord(raw.worker_details) ? raw.worker_details : {};
      const payment = isRecord(raw.payment) ? raw.payment : null;
      const emp = isRecord(raw.employment_status)
        ? raw.employment_status
        : null;
      const portrait = isRecord(raw.worker_portrait)
        ? raw.worker_portrait
        : null;
      const docs = Array.isArray(raw.documents) ? raw.documents : [];

      const nationalId = extractTriStateString(wd.national_id);
      const accountNumber =
        payment && typeof payment.account_number === "string"
          ? payment.account_number
          : null;

      const row: Record<string, unknown> = {
        entry_id: typeof raw.entry_id === "string" ? raw.entry_id : entryId,
        submission_id:
          typeof raw.submission_id === "string" ? raw.submission_id : null,
        version: typeof raw.version === "number" ? raw.version : null,
        employee_code:
          typeof raw.employee_code === "string" ? raw.employee_code : null,
        display_name:
          typeof wd.display_name === "string" ? wd.display_name : null,
        project_id: typeof raw.project_id === "string" ? raw.project_id : null,
        recruiter_id:
          typeof raw.recruiter_id === "string" ? raw.recruiter_id : null,
        team_id: typeof raw.team_id === "string" ? raw.team_id : null,
        provider_type:
          typeof raw.provider_type === "string" ? raw.provider_type : null,
        labor_type: typeof raw.labor_type === "string" ? raw.labor_type : null,
        labor_type_display:
          typeof raw.labor_type_display === "string"
            ? raw.labor_type_display
            : null,
        first_work_date:
          typeof raw.first_work_date === "string" ? raw.first_work_date : null,
        employment_status:
          emp && typeof emp.status === "string" ? emp.status : null,
        employment_status_effective_date:
          emp && typeof emp.effective_date === "string"
            ? emp.effective_date
            : null,
        gender: extractTriStateString(wd.gender),
        date_of_birth: extractTriStateString(wd.date_of_birth),
        national_id_masked: maskTail4(nationalId),
        national_id: nationalId,
        national_id_issued_at: extractTriStateString(wd.national_id_issued_at),
        national_id_issued_place: extractTriStateString(
          wd.national_id_issued_place,
        ),
        phone: extractTriStateString(wd.phone),
        address: extractTriStateString(wd.address),
        general_note:
          typeof raw.general_note === "string" ? raw.general_note : null,
        payment_state:
          payment && typeof payment.state === "string" ? payment.state : null,
        bank_id:
          payment && typeof payment.bank_id === "string"
            ? payment.bank_id
            : null,
        bank_name:
          payment && typeof payment.bank_name === "string"
            ? payment.bank_name
            : null,
        account_number_masked: maskTail4(accountNumber),
        account_number: accountNumber,
        account_holder_name:
          payment && typeof payment.account_holder_name === "string"
            ? payment.account_holder_name
            : null,
        portrait_status:
          portrait && typeof portrait.status === "string"
            ? portrait.status
            : "MISSING",
        document_count: docs.length,
      };

      return {
        ok: true,
        data: {
          as_of_date: businessDate,
          date_range: { from: null, to: null },
          summary: {
            entry_id: row.entry_id,
            employee_code: row.employee_code,
            employment_status: row.employment_status,
            document_count: docs.length,
          },
          rows: [row],
          has_more: false,
          next_cursor: null,
          total_matching: 1,
        },
      };
    },

    async workers_episodes_lookup(spec, { actor }) {
      const projectId = findEqFilterString(spec.filters, "project_id") ?? "default";
      const nationalId = findEqFilterString(spec.filters, "national_id");
      const displayName = findSearchFilterString(spec.filters, "display_name");

      const outcome = await workerEpisodeLookupRepo.lookup({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        project_id: projectId,
        display_name: displayName,
        national_id: nationalId,
        page_size: 50,
        offset: 0,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: outcome.kind === "invalid" ? 400 : 503,
          code: `WORKER_EPISODE_LOOKUP_${outcome.kind.toUpperCase()}`,
          message:
            "Không thể tra cứu lịch sử đợt làm việc (kiểm tra project_id và national_id hoặc display_name).",
        };
      }

      const rawRows: Record<string, unknown>[] = [];
      for (const w of outcome.data.workers) {
        for (const ep of w.episodes) {
          rawRows.push({
            entry_id: ep.entry_id,
            employee_code: ep.employee_code,
            display_name: ep.display_name,
            project_id: ep.project_id,
            project_display: ep.project_display,
            first_work_date: ep.first_work_date,
            latest_employment_status: ep.latest_status,
            worker_episode_count: w.episode_count,
            active_episode_exists: w.active_episode_exists,
            rehire_allowed: w.rehire_allowed,
          });
        }
      }

      const pushed = new Set(["project_id", "national_id", "display_name"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const paged = paginateInMemoryRows(filteredRows, spec);

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: {
            match_mode: outcome.data.match,
            project_id: outcome.data.project_id,
            matched_worker_count: outcome.data.workers.length,
            returned_episode_count: paged.slice.length,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
        },
      };
    },

    async workers_duplicate_cccd(spec, { actor }) {
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const outcome = await duplicateCccdRepo.report({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        page,
        page_size: spec.page_size,
        managed_only: false,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: outcome.kind === "invalid" ? 400 : 503,
          code: `DUPLICATE_CCCD_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn báo cáo trùng CCCD.",
        };
      }

      const rawRows: Record<string, unknown>[] = [];
      for (const group of outcome.data.groups) {
        for (const ep of group.episodes) {
          rawRows.push({
            cccd_last4: group.cccd_last4,
            canonical_cccd_masked: `••••••••${group.cccd_last4}`,
            cccd_length: group.cccd_length,
            group_episode_count: group.profile_count,
            active_profile_count: group.active_profile_count,
            project_count: group.project_count,
            entry_id: ep.entry_id,
            entry_version: ep.entry_version,
            employee_code: ep.employee_code,
            display_name: ep.display_name,
            project_display: ep.project_display,
            first_work_date: ep.first_work_date,
            latest_status: ep.latest_status,
            active: ep.active,
          });
        }
      }

      const filteredRows = applyResidualFiltersAndSort(rawRows, spec);
      const hasMore = outcome.data.has_more;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: {
            total_duplicate_groups: outcome.data.total_groups,
            total_duplicate_episodes: outcome.data.total_entries,
          },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total_entries,
        },
      };
    },

    // -----------------------------------------------------------------------
    // 4. ATTENDANCE
    // -----------------------------------------------------------------------
    async attendance_checkins(spec, { actor, businessDate }) {
      const dateFrom = spec.date_range?.from ?? businessDate;
      const dateTo = spec.date_range?.to ?? businessDate;
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const employeeId = findEqFilterString(spec.filters, "app_user_id");
      const searchQuery =
        findSearchFilterString(spec.filters, "employee_code") ??
        findSearchFilterString(spec.filters, "display_name");

      const outcome = await attendanceRepo.getAdminReport({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        from_date: dateFrom,
        to_date: dateTo,
        page,
        page_size: spec.page_size,
        search: searchQuery,
        employee_id: employeeId,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status:
            outcome.code === "ATTENDANCE_REPORT_QUERY_INVALID" ? 400 : 503,
          code: outcome.code,
          message:
            outcome.code === "ATTENDANCE_REPORT_QUERY_INVALID"
              ? "Tham số khoảng ngày hoặc bộ lọc chấm công không hợp lệ (tối đa 93 ngày)."
              : "Không thể truy vấn báo cáo chấm công.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.report.items.map(
        (r) => ({
          checkin_id: r.checkin_id,
          app_user_id: employeeId,
          employee_code: r.personnel_code,
          display_name: r.employee_display_name,
          business_date: r.business_date,
          sequence_in_day: r.sequence_in_day,
          captured_at: r.captured_at,
          captured_at_local: r.captured_at_local,
          received_at: r.received_at,
          time_source: r.time_source,
          time_verified: r.time_verified,
          sync_delay_seconds: r.sync_delay_seconds,
          distance_meters: r.distance_meters,
          distance_status: r.distance_status,
          hq_version_used: r.hq_version_used,
          latitude: r.latitude,
          longitude: r.longitude,
          accuracy_meters: r.accuracy_meters,
          address_hint: r.address_hint,
          note: r.note,
        }),
      );

      const pushed = new Set(["app_user_id", "business_date"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = outcome.report.pagination.has_more;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.report.filters.to_date,
          date_range: {
            from: outcome.report.filters.from_date,
            to: outcome.report.filters.to_date,
          },
          summary: {
            ...outcome.report.overview,
            current_hq: outcome.report.current_hq,
          },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.report.pagination.total_rows,
        },
      };
    },

    // -----------------------------------------------------------------------
    // 5. VENDOR FINANCE (Strict Sub-Ledger Grain: Project + Responsible Accountant)
    // -----------------------------------------------------------------------
    async vendor_finance_monthly_report(spec, { actor, businessDate }) {
      const monthFilter =
        findEqFilterString(spec.filters, "month") ??
        (spec.date_range?.from
          ? spec.date_range.from.slice(0, 7)
          : businessDate.slice(0, 7));

      const accountantRef =
        findEqFilterString(spec.filters, "accountant_ref") ??
        findEqFilterString(spec.filters, "responsible_accountant_user_id");

      const outcome = await vendorFinanceRepo.getMonthlyReport({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        month: monthFilter,
        project_id: findEqFilterString(spec.filters, "project_id"),
        accountant_ref: accountantRef,
        vendor_id: findEqFilterString(spec.filters, "vendor_id"),
      });

      if (!outcome.ok) {
        const status = vendorFinanceHttpStatusForError(outcome.code);
        return {
          ok: false,
          status: status === 400 ? 400 : status === 404 ? 404 : 503,
          code: outcome.code,
          message: "Không thể truy vấn báo cáo tháng tài chính Vendor.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.rows.map((r) => ({
        month: outcome.data.filters.month,
        ledger_scope: "PROJECT_ACCOUNTANT",
        project_id: r.project_id,
        project_display_name: r.project_display_name,
        project_active: r.project_active,
        accountant_ref: r.accountant_ref,
        responsible_accountant_user_id: r.accountant_ref,
        responsible_accountant_display_name:
          r.responsible_accountant_display_name,
        is_currently_assigned: r.is_currently_assigned,
        vendor_id: r.vendor_id,
        vendor_display_name: r.vendor_display_name,
        vendor_active: r.vendor_active,
        balance_before_month_minor: r.balance_before_month_minor,
        opening_payable_in_month_minor: r.opening_payable_in_month_minor,
        opening_advance_in_month_minor: r.opening_advance_in_month_minor,
        obligations_in_month_minor: r.obligations_in_month_minor,
        paid_in_month_minor: r.paid_in_month_minor,
        advanced_in_month_minor: r.advanced_in_month_minor,
        paid_and_advanced_in_month_minor: r.paid_and_advanced_in_month_minor,
        net_change_in_month_minor: r.net_change_in_month_minor,
        closing_balance_minor: r.closing_balance_minor,
        closing_direction: r.closing_direction,
        closing_payable_minor: r.closing_payable_minor,
        closing_advance_minor: r.closing_advance_minor,
        current_balance_minor: r.current_balance_minor,
        in_month_entry_count: r.in_month_entry_count,
        total_entry_count: r.total_entry_count,
      }));

      for (const leg of outcome.data.legacy_unallocated_rows) {
        rawRows.push({
          month: outcome.data.filters.month,
          ledger_scope: "LEGACY_UNALLOCATED",
          project_id: null,
          project_display_name: null,
          project_active: null,
          accountant_ref: null,
          responsible_accountant_user_id: null,
          responsible_accountant_display_name: null,
          is_currently_assigned: false,
          vendor_id: leg.vendor_id,
          vendor_display_name: leg.vendor_display_name,
          vendor_active: leg.vendor_active,
          balance_before_month_minor: leg.balance_before_month_minor,
          opening_payable_in_month_minor: "0",
          opening_advance_in_month_minor: "0",
          obligations_in_month_minor: leg.obligations_in_month_minor,
          paid_in_month_minor: "0",
          advanced_in_month_minor: "0",
          paid_and_advanced_in_month_minor: leg.paid_and_advanced_in_month_minor,
          net_change_in_month_minor: "0",
          closing_balance_minor: leg.closing_balance_minor,
          closing_direction: leg.closing_direction,
          closing_payable_minor:
            leg.closing_direction === "PAYABLE" ? leg.closing_balance_minor : "0",
          closing_advance_minor:
            leg.closing_direction === "ADVANCE"
              ? leg.closing_balance_minor.replace(/^-/, "")
              : "0",
          current_balance_minor: leg.closing_balance_minor,
          in_month_entry_count: leg.in_month_entry_count,
          total_entry_count: leg.in_month_entry_count,
        });
      }

      const pushed = new Set([
        "month",
        "project_id",
        "accountant_ref",
        "responsible_accountant_user_id",
        "vendor_id",
      ]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const paged = paginateInMemoryRows(filteredRows, spec);

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: {
            from: `${outcome.data.filters.month}-01`,
            to: null,
          },
          summary: {
            month: outcome.data.filters.month,
            subledger_policy:
              "STRICT_PROJECT_ACCOUNTANT_SUBLEDGER_NO_CROSS_ACCOUNTANT_NETTING",
            subledger_row_count: filteredRows.length,
            totals: outcome.data.totals,
            project_accountant_summaries:
              outcome.data.project_accountant_summaries,
            legacy_unallocated_rows: outcome.data.legacy_unallocated_rows,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
          notes: [
            "Số liệu giữ nguyên theo từng sổ phụ (Dự án + Kế toán phụ trách + Vendor). Summary nhóm theo từng cặp (project_id, accountant_ref) và tuyệt đối không cấn trừ số dư giữa các kế toán khác nhau.",
          ],
        },
      };
    },

    async vendor_finance_subledgers(spec, { actor }) {
      const accountantRef =
        findEqFilterString(spec.filters, "accountant_ref") ??
        findEqFilterString(spec.filters, "responsible_accountant_user_id");
      const balanceFilterRaw = findEqFilterString(
        spec.filters,
        "balance_state",
      )?.toLowerCase();
      const balanceFilter: VendorFinanceBalanceFilter =
        balanceFilterRaw === "payable" ||
        balanceFilterRaw === "advance" ||
        balanceFilterRaw === "nonzero" ||
        balanceFilterRaw === "uninitialized"
          ? balanceFilterRaw
          : "all";

      const includeInactive =
        findEqFilterBoolean(spec.filters, "include_inactive") ?? true;
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;

      const outcome = await vendorFinanceRepo.listVendors({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        search: findSearchFilterString(spec.filters, "search"),
        active: includeInactive ? "all" : "active",
        balance_filter: balanceFilter,
        project_id: findEqFilterString(spec.filters, "project_id"),
        accountant_ref: accountantRef,
        ledger_scope: null,
        page,
        page_size: Math.min(100, spec.page_size),
      });

      if (!outcome.ok) {
        const status = vendorFinanceHttpStatusForError(outcome.code);
        return {
          ok: false,
          status: status === 400 ? 400 : 503,
          code: outcome.code,
          message: "Không thể truy vấn danh sách sổ phụ tài chính Vendor.",
        };
      }

      const rawRows: Record<string, unknown>[] = [];
      for (const vendor of outcome.data.vendors) {
        for (const sub of vendor.sub_ledgers) {
          const curBal = sub.current_balance_minor;
          const isNeg = curBal.startsWith("-");
          const payableMinor =
            sub.balance_direction === "PAYABLE" ? curBal : "0";
          const advanceMinor =
            sub.balance_direction === "ADVANCE"
              ? isNeg
                ? curBal.slice(1)
                : curBal
              : "0";
          rawRows.push({
            vendor_id: vendor.vendor_id,
            vendor_display_name: vendor.display_name,
            vendor_active: vendor.active,
            ledger_scope: sub.ledger_scope,
            project_id: sub.project_id,
            project_display_name: sub.project_display_name,
            accountant_ref: sub.accountant_ref,
            responsible_accountant_user_id: sub.accountant_ref,
            responsible_accountant_display_name:
              sub.responsible_accountant_display_name,
            has_opening_entry: sub.has_opening_entry,
            entry_count: sub.entry_count,
            current_balance_minor: sub.current_balance_minor,
            payable_minor: payableMinor,
            advance_minor: advanceMinor,
            balance_direction: sub.balance_direction,
            balance_state: sub.balance_direction,
            last_reconciled_as_of_date: sub.last_reconciled_as_of_date,
          });
        }
      }

      const pushed = new Set([
        "project_id",
        "accountant_ref",
        "responsible_accountant_user_id",
        "include_inactive",
        "search",
      ]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);

      // Group summary strictly by (ledger_scope, project_id, accountant_ref) — never cross-netting accountants!
      const bySubledgerContext = new Map<
        string,
        {
          ledger_scope: string;
          project_id: string | null;
          project_display_name: string | null;
          accountant_ref: string | null;
          responsible_accountant_user_id: string | null;
          responsible_accountant_display_name: string | null;
          vendor_subledger_count: number;
          payable_minor_total: string;
          advance_minor_total: string;
        }
      >();

      const payableAcc = new Map<string, bigint>();
      const advanceAcc = new Map<string, bigint>();

      for (const r of filteredRows) {
        const key = `${String(r.ledger_scope)}|${String(r.project_id ?? "")}|${String(r.accountant_ref ?? "")}`;
        const existing = bySubledgerContext.get(key) ?? {
          ledger_scope: String(r.ledger_scope),
          project_id: (r.project_id as string | null) ?? null,
          project_display_name:
            (r.project_display_name as string | null) ?? null,
          accountant_ref: (r.accountant_ref as string | null) ?? null,
          responsible_accountant_user_id:
            (r.accountant_ref as string | null) ?? null,
          responsible_accountant_display_name:
            (r.responsible_accountant_display_name as string | null) ?? null,
          vendor_subledger_count: 0,
          payable_minor_total: "0",
          advance_minor_total: "0",
        };
        existing.vendor_subledger_count += 1;
        const pNext =
          (payableAcc.get(key) ?? BigInt(0)) +
          BigInt(String(r.payable_minor ?? "0"));
        const aNext =
          (advanceAcc.get(key) ?? BigInt(0)) +
          BigInt(String(r.advance_minor ?? "0"));
        payableAcc.set(key, pNext);
        advanceAcc.set(key, aNext);
        existing.payable_minor_total = pNext.toString();
        existing.advance_minor_total = aNext.toString();
        bySubledgerContext.set(key, existing);
      }

      const hasMore = outcome.data.has_more;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: {
            subledger_policy:
              "STRICT_PROJECT_ACCOUNTANT_SUBLEDGER_NO_CROSS_ACCOUNTANT_NETTING",
            subledger_count: filteredRows.length,
            by_project_accountant: [...bySubledgerContext.values()],
          },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: filteredRows.length,
          notes: [
            "Mỗi dòng là một sổ phụ (ledger_scope, project_id, accountant_ref, vendor_id). Không gộp bù trừ số dư giữa các kế toán khác nhau.",
          ],
        },
      };
    },

    async vendor_finance_entries(spec, { actor }) {
      const vendorId = findEqFilterString(spec.filters, "vendor_id");
      if (!vendorId) {
        return {
          ok: false,
          status: 400,
          code: "MISSING_REQUIRED_FILTER",
          message: "Bắt buộc truyền filter vendor_id.",
        };
      }

      const accountantRef =
        findEqFilterString(spec.filters, "accountant_ref") ??
        findEqFilterString(spec.filters, "responsible_accountant_user_id");
      const entryTypeRaw = findEqFilterString(
        spec.filters,
        "entry_type",
      )?.toUpperCase();
      const beforeCursorSeq =
        spec.cursor?.kind === "token" && spec.cursor.token
          ? Number.parseInt(spec.cursor.token, 10)
          : null;
      const monthFilter =
        findEqFilterString(spec.filters, "month") ??
        (spec.date_range?.from ? spec.date_range.from.slice(0, 7) : null);

      const outcome = await vendorFinanceRepo.listVendorEntries({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        vendor_id: vendorId,
        project_id: findEqFilterString(spec.filters, "project_id"),
        accountant_ref: accountantRef,
        entry_type: (entryTypeRaw as VendorFinanceEntryType | undefined) ?? null,
        month: monthFilter,
        page_size: Math.min(100, spec.page_size),
        before_sequence:
          beforeCursorSeq !== null && Number.isSafeInteger(beforeCursorSeq)
            ? beforeCursorSeq
            : null,
      });

      if (!outcome.ok) {
        const status = vendorFinanceHttpStatusForError(outcome.code);
        return {
          ok: false,
          status: status === 404 ? 404 : status === 400 ? 400 : 503,
          code: outcome.code,
          message: "Không thể truy vấn sổ cái bút toán Vendor.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.entries.map(
        (e) => ({
          entry_id: e.entry_id,
          vendor_id: e.vendor_id,
          ledger_scope: e.ledger_scope,
          project_id: e.project_id,
          project_display_name_snapshot: e.project_display_name_snapshot,
          accountant_ref: e.accountant_ref,
          responsible_accountant_user_id: e.accountant_ref,
          responsible_accountant_display_name_snapshot:
            e.responsible_accountant_display_name,
          cursor_sequence: e.cursor_sequence,
          vendor_sequence: e.vendor_sequence,
          document_no: e.document_no,
          document_kind: e.document_kind,
          entry_type: e.entry_type,
          amount_minor: e.amount_minor,
          balance_delta_minor: e.balance_delta_minor,
          balance_before_minor: e.balance_before_minor,
          balance_after_minor: e.balance_after_minor,
          effective_date: e.effective_date,
          business_date: e.effective_date,
          reverses_entry_id: e.reverses_entry_id,
          reversed_by_entry_id: e.reversed_by_entry_id,
          created_by_display_name: e.created_by_display_name,
          created_at: e.created_at,
          has_evidence: e.evidence !== null,
          reason: e.reason,
        }),
      );

      const pushed = new Set([
        "vendor_id",
        "project_id",
        "accountant_ref",
        "entry_type",
        "month",
      ]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const lastEntry =
        outcome.data.entries[outcome.data.entries.length - 1] ?? null;
      const nextCursor =
        outcome.data.has_more && lastEntry
          ? encodeN8nCursor({
              dataset: spec.dataset,
              kind: "token",
              token: String(lastEntry.cursor_sequence),
            })
          : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: spec.date_range ?? { from: null, to: null },
          summary: {
            vendor_id: outcome.data.vendor_id,
            returned_entries: filteredRows.length,
            has_more: outcome.data.has_more,
          },
          rows: filteredRows,
          has_more: outcome.data.has_more,
          next_cursor: nextCursor,
          total_matching: null,
        },
      };
    },

    async vendor_finance_reconciliations(spec, { actor }) {
      const vendorId = findEqFilterString(spec.filters, "vendor_id");
      if (!vendorId) {
        return {
          ok: false,
          status: 400,
          code: "MISSING_REQUIRED_FILTER",
          message: "Bắt buộc truyền filter vendor_id.",
        };
      }

      const accountantRef =
        findEqFilterString(spec.filters, "accountant_ref") ??
        findEqFilterString(spec.filters, "responsible_accountant_user_id");
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;

      const outcome = await vendorFinanceRepo.listVendorReconciliations({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        vendor_id: vendorId,
        project_id: findEqFilterString(spec.filters, "project_id"),
        accountant_ref: accountantRef,
        page,
        page_size: Math.min(100, spec.page_size),
      });

      if (!outcome.ok) {
        const status = vendorFinanceHttpStatusForError(outcome.code);
        return {
          ok: false,
          status: status === 404 ? 404 : status === 400 ? 400 : 503,
          code: outcome.code,
          message: "Không thể truy vấn lịch sử đối soát Vendor.",
        };
      }

      const rawRows: Record<string, unknown>[] =
        outcome.data.reconciliations.map((rec) => ({
          reconciliation_id: rec.reconciliation_id,
          vendor_id: rec.vendor_id,
          ledger_scope: rec.ledger_scope,
          project_id: rec.project_id,
          project_display_name_snapshot: rec.project_display_name_snapshot,
          accountant_ref: rec.accountant_ref,
          responsible_accountant_user_id: rec.accountant_ref,
          responsible_accountant_display_name_snapshot:
            rec.responsible_accountant_display_name,
          as_of_date: rec.as_of_date,
          ledger_sequence_at_reconciliation:
            rec.ledger_sequence_at_reconciliation,
          system_balance_minor: rec.system_balance_minor,
          confirmed_balance_minor: rec.confirmed_balance_minor,
          difference_minor: rec.difference_minor,
          created_by_display_name: rec.created_by_display_name,
          created_at: rec.created_at,
          has_evidence: rec.evidence !== null,
          reason: rec.reason,
        }));

      const pushed = new Set(["vendor_id", "project_id", "accountant_ref"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = outcome.data.has_more;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: {
            vendor_id: outcome.data.vendor_id,
            total_reconciliations: outcome.data.total,
          },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total,
        },
      };
    },

    // -----------------------------------------------------------------------
    // 6. DATA QUALITY
    // -----------------------------------------------------------------------
    async data_quality_pipeline(spec, { businessDate }) {
      const pipeline = await callPipelineCheck();

      if (!pipeline.ok) {
        return {
          ok: false,
          status: 503,
          code: pipeline.code,
          message: pipeline.message,
        };
      }

      const issuesByDriveFile = new Map<string, string[]>();
      for (const issue of pipeline.data.issues) {
        const list = issuesByDriveFile.get(issue.driveFileId) ?? [];
        if (list.length < 10) {
          list.push(issue.errorCode);
        }
        issuesByDriveFile.set(issue.driveFileId, list);
      }

      const rawRows: Record<string, unknown>[] = pipeline.data.sources.map(
        (src) => {
          const run = src.latestRun;
          const errCodes = issuesByDriveFile.get(src.driveFileId) ?? [];
          return {
            source_id: src.id,
            drive_file_id: src.driveFileId,
            file_name: src.fileName,
            sheet_name: src.sheetName,
            active: src.active,
            last_seen_at: src.lastSeenAt,
            last_successful_sync_at: src.lastSuccessfulSyncAt,
            latest_run_id: run?.runId ?? null,
            latest_run_status: run?.status ?? null,
            latest_run_finished_at: run?.finishedAt ?? null,
            rows_read: run?.rowsRead ?? null,
            rows_valid: run?.rowsValid ?? null,
            rows_warned: run?.rowsWarned ?? null,
            rows_rejected: run?.rowsRejected ?? null,
            recent_error_count: errCodes.length,
            recent_error_codes: errCodes,
          };
        },
      );

      const filteredRows = applyResidualFiltersAndSort(rawRows, spec);
      const paged = paginateInMemoryRows(filteredRows, spec);

      return {
        ok: true,
        data: {
          as_of_date: businessDate,
          date_range: { from: null, to: null },
          summary: {
            active_source_count: pipeline.data.overview.sourcesActive,
            total_source_count: pipeline.data.overview.sourcesTotal,
            recent_sync_error_count: pipeline.data.issues.length,
            latest_run_status: pipeline.data.overview.latestRunStatus,
            totals: pipeline.data.overview.totals,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
        },
      };
    },

    async data_quality_cccd_reconciliation(spec, { actor, businessDate }) {
      const statusRaw =
        findEqFilterString(spec.filters, "status_filter")?.toUpperCase() ??
        "NEEDS_REVIEW";
      const statusFilter: CccdReviewStatusFilter = isCccdReviewStatusFilter(
        statusRaw,
      )
        ? statusRaw
        : "NEEDS_REVIEW";

      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const offset = (page - 1) * spec.page_size;

      const outcome = await cccdReviewRepo.listReviewQueue({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        status_filter: statusFilter,
        limit: spec.page_size,
        offset,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: outcome.kind === "invalid" ? 400 : 503,
          code: `CCCD_REVIEW_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn hàng đợi đối soát QR CCCD.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.rows.map(
        (item) => ({
          entry_id: item.entry_id,
          submission_id: item.submission_id,
          submission_state: item.submission_state,
          employee_code: item.employee_code,
          display_name: item.display_name,
          project_id: item.project_id,
          project_name: item.project_name,
          recruiter_id: item.recruiter_id,
          recruiter_name: item.recruiter_name,
          team_id: item.team_id,
          team_name: item.team_name,
          provider_type: item.provider_type,
          labor_type: item.labor_type,
          first_work_date: item.first_work_date,
          reconciliation_status: item.reconciliation_status,
          qr_status: item.qr.status,
          qr_error_code: item.qr.error_code,
          entered_national_id_masked: item.entered.national_id_masked,
          qr_national_id_masked: item.qr.national_id_masked,
          entered_national_id: item.entered.national_id,
          qr_national_id: item.qr.national_id,
          entered_phone: item.entered.phone,
          entered_address: item.entered.address,
          qr_display_name: item.qr.candidate_data?.display_name ?? null,
          qr_address: item.qr.candidate_data?.address ?? null,
          resolved_action: item.resolved_action,
          resolved_at: item.resolved_at,
          resolution_reason: item.resolution_reason,
          updated_at: item.updated_at,
        }),
      );

      const pushed = new Set(["status_filter"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = offset + spec.page_size < outcome.data.total_count;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: businessDate,
          date_range: spec.date_range ?? { from: null, to: null },
          summary: outcome.data.summary,
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total_count,
        },
      };
    },

    // -----------------------------------------------------------------------
    // 7. BUSINESS CATALOGS
    // -----------------------------------------------------------------------
    async catalog_projects(spec, { actor }) {
      const includeInactive =
        findEqFilterBoolean(spec.filters, "include_inactive") ?? true;
      const outcome = await projectAdminRepo.listProjects({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        include_inactive: includeInactive,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: 503,
          code: `CATALOG_PROJECTS_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh mục dự án.",
        };
      }

      const search = findSearchFilterString(spec.filters, "search")?.toLowerCase();
      let rawRows: Record<string, unknown>[] = outcome.data.projects.map(
        (p) => ({
          project_id: p.project_id,
          display_name: p.display_name,
          active: p.active,
          version: p.version,
          active_assignment_count: p.active_assignment_count,
          revision_count: p.revision_count,
        }),
      );

      if (search) {
        rawRows = rawRows.filter(
          (r) =>
            String(r.project_id).toLowerCase().includes(search) ||
            String(r.display_name).toLowerCase().includes(search),
        );
      }

      const pushed = new Set(["include_inactive", "search"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const paged = paginateInMemoryRows(filteredRows, spec);

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: {
            total_projects: paged.total_matching,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
        },
      };
    },

    async catalog_teams(spec, { actor }) {
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const includeInactive =
        findEqFilterBoolean(spec.filters, "include_inactive") ?? true;

      const outcome = await teamCatalogRepo.listTeams({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        search: findSearchFilterString(spec.filters, "search"),
        include_inactive: includeInactive,
        page,
        page_size: spec.page_size,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: 503,
          code: `CATALOG_TEAMS_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh mục nhóm.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.teams.map((t) => ({
        team_id: t.team_id,
        code: t.code,
        display_name: t.display_name,
        active: t.active,
        version: t.version,
        revision_count: t.revision_count,
      }));

      const pushed = new Set(["include_inactive", "search"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = page * spec.page_size < outcome.data.total;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: { total_teams: outcome.data.total },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total,
        },
      };
    },

    async catalog_project_team_scopes(spec, { actor }) {
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const includeHistory =
        findEqFilterBoolean(spec.filters, "include_history") ?? false;

      const outcome = await projectTeamScopeRepo.listScopes({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        project_id: findEqFilterString(spec.filters, "project_id"),
        team_id: findEqFilterString(spec.filters, "team_id"),
        search: findSearchFilterString(spec.filters, "search"),
        include_history: includeHistory,
        page,
        page_size: spec.page_size,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: 503,
          code: `CATALOG_PROJECT_TEAM_SCOPES_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh mục phân quyền Dự án - Nhóm.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.mappings.map(
        (m) => ({
          mapping_id: m.mapping_id,
          project_id: m.project_id,
          project_display_name: m.project_display_name,
          team_id: m.team_id,
          team_code: m.team_code,
          team_display_name: m.team_display_name,
          valid_from: m.valid_from,
          valid_to: m.valid_to,
          effective: m.effective,
          state: m.state,
          status: m.state,
        }),
      );

      const pushed = new Set([
        "project_id",
        "team_id",
        "include_history",
        "search",
      ]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = page * spec.page_size < outcome.data.total;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: { total_mappings: outcome.data.total },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total,
        },
      };
    },

    async catalog_recruiters(spec, { actor }) {
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const includeInactive =
        findEqFilterBoolean(spec.filters, "include_inactive") ?? true;

      const outcome = await personnelCatalogRepo.listPersonnel({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        search: findSearchFilterString(spec.filters, "search"),
        include_inactive: includeInactive,
        page,
        page_size: spec.page_size,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: 503,
          code: `CATALOG_RECRUITERS_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh mục nhân sự tuyển dụng.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.personnel.map(
        (p) => ({
          recruiter_id: p.recruiter_id,
          personnel_code: p.personnel_code,
          display_name: p.display_name,
          personnel_position: p.personnel_position,
          active: p.active,
          hrp_valid_from: p.hrp_valid_from,
          team_names: p.team_names,
          version: p.version,
        }),
      );

      const pushed = new Set(["include_inactive", "search"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = page * spec.page_size < outcome.data.total;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: { total_recruiters: outcome.data.total },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total,
        },
      };
    },

    async catalog_vendors(spec, { actor }) {
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const includeInactive =
        findEqFilterBoolean(spec.filters, "include_inactive") ?? true;

      const outcome = await vendorCatalogRepo.listVendors({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        search: findSearchFilterString(spec.filters, "search"),
        include_inactive: includeInactive,
        page,
        page_size: spec.page_size,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: 503,
          code: `CATALOG_VENDORS_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh mục Vendor.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.vendors.map(
        (v) => ({
          vendor_id: v.vendor_id,
          display_name: v.display_name,
          active: v.active,
          recruiter_id: v.recruiter_id,
          version: v.version,
          revision_count: v.revision_count,
        }),
      );

      const pushed = new Set(["include_inactive", "search"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = page * spec.page_size < outcome.data.total;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: { total_vendors: outcome.data.total },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total,
        },
      };
    },

    async catalog_labor_types(spec, { actor }) {
      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const includeInactive =
        findEqFilterBoolean(spec.filters, "include_inactive") ?? true;

      const outcome = await laborTypeCatalogRepo.listLaborTypes({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        search: findSearchFilterString(spec.filters, "search"),
        include_inactive: includeInactive,
        page,
        page_size: spec.page_size,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status: 503,
          code: `CATALOG_LABOR_TYPES_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh mục loại lao động.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.labor_types.map(
        (lt) => ({
          labor_type_key: lt.labor_type_key,
          reporting_key: lt.reporting_key,
          display_name: lt.display_name,
          active: lt.active,
          sort_order: lt.sort_order,
          version: lt.version,
          revision_count: lt.revision_count,
        }),
      );

      const pushed = new Set(["include_inactive", "search"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = page * spec.page_size < outcome.data.total;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: outcome.data.authorization_date,
          date_range: { from: null, to: null },
          summary: { total_labor_types: outcome.data.total },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: outcome.data.total,
        },
      };
    },

    // -----------------------------------------------------------------------
    // 8. WORK REPORTS (Báo cáo công việc)
    // -----------------------------------------------------------------------
    async work_reports_templates(spec, { actor, businessDate }) {
      const outcome = await workReportTemplateRepo.list(actor);
      if (!outcome.ok) {
        return {
          ok: false,
          status: outcome.kind === "invalid" ? 400 : 503,
          code: `WORK_REPORT_TEMPLATES_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh mục mẫu báo cáo công việc.",
        };
      }

      const search = findSearchFilterString(spec.filters, "search")?.toLowerCase();
      let rawRows: Record<string, unknown>[] = outcome.data.map((tpl) => ({
        template_id: tpl.template_id,
        template_code: tpl.template_code,
        display_name: tpl.display_name,
        description: tpl.description,
        default_frequency: tpl.default_frequency,
        status: tpl.status,
        current_published_version_id: tpl.current_published_version_id,
        draft_version_id: tpl.draft_version_id,
        version: tpl.version,
        updated_at: tpl.updated_at,
      }));

      if (search) {
        rawRows = rawRows.filter(
          (r) =>
            String(r.template_code).toLowerCase().includes(search) ||
            String(r.display_name).toLowerCase().includes(search) ||
            String(r.description ?? "").toLowerCase().includes(search),
        );
      }

      const pushed = new Set(["search"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const paged = paginateInMemoryRows(filteredRows, spec);
      const activeCount = filteredRows.filter(
        (r) => r.status === "ACTIVE",
      ).length;

      return {
        ok: true,
        data: {
          as_of_date: businessDate,
          date_range: { from: null, to: null },
          summary: {
            total_templates: filteredRows.length,
            active_templates: activeCount,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
        },
      };
    },

    async work_reports_assignments(spec, { actor, businessDate }) {
      const teamId = findEqFilterString(spec.filters, "team_id");
      const assignmentId = findEqFilterString(spec.filters, "assignment_id");

      const outcome = await workReportAssignmentRepo.listAssignments({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        team_id: teamId,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status:
            outcome.kind === "not-found"
              ? 404
              : outcome.kind === "invalid"
                ? 400
                : 503,
          code: `WORK_REPORT_ASSIGNMENTS_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh sách giao báo cáo công việc.",
        };
      }

      let detailByAssignmentId = new Map<string, readonly unknown[]>();
      if (assignmentId) {
        if (!workReportAssignmentRepo.getAssignmentDetail) {
          return {
            ok: false,
            status: 503,
            code: "WORK_REPORT_ASSIGNMENT_DETAIL_UNAVAILABLE",
            message:
              "Không thể truy vấn chi tiết tiến độ giao báo cáo công việc theo assignment_id.",
          };
        }
        const detailRes = await workReportAssignmentRepo.getAssignmentDetail({
          auth_subject: actor.auth_subject,
          app_user_id: actor.app_user_id,
          assignment_id: assignmentId,
        });
        if (!detailRes.ok) {
          return {
            ok: false,
            status:
              detailRes.kind === "not-found"
                ? 404
                : detailRes.kind === "denied"
                  ? 403
                  : detailRes.kind === "invalid"
                    ? 400
                    : 503,
            code: `WORK_REPORT_ASSIGNMENT_DETAIL_${detailRes.kind.toUpperCase()}`,
            message:
              "Không thể truy vấn chi tiết tiến độ giao báo cáo công việc theo assignment_id.",
          };
        }
        detailByAssignmentId = new Map([
          [detailRes.data.assignment_id, detailRes.data.assignee_progress],
        ]);
      }

      const search = findSearchFilterString(spec.filters, "search")?.toLowerCase();
      let rawRows: Record<string, unknown>[] = outcome.data.map((item) => ({
        assignment_id: item.assignment_id,
        template_id: item.template_id,
        template_code: item.template_code,
        template_name: item.template_name,
        target_kind: item.target_kind,
        target_group_id: item.target_group_id ?? null,
        target_label: item.target_label,
        target_member_count: item.target_member_count ?? null,
        frequency: item.frequency,
        is_mandatory: item.is_mandatory,
        due_day_offset: item.due_day_offset ?? null,
        due_time_local: item.due_time_local ?? null,
        exclude_sundays: item.exclude_sundays ?? null,
        effective_from: item.effective_from,
        effective_to: item.effective_to,
        state: item.state,
        version: item.version,
        created_at: item.created_at,
        obligation_total: item.obligation_total,
        submitted_count: item.submitted_count,
        not_started_count: item.not_started_count,
        draft_count: item.draft_count,
        overdue_count: item.overdue_count ?? 0,
        rejected_count: item.rejected_count ?? 0,
        exempted_count: item.exempted_count,
        cancelled_count: item.cancelled_count,
        assignee_progress:
          detailByAssignmentId.get(item.assignment_id) ??
          item.assignee_progress ??
          null,
      }));

      if (search) {
        rawRows = rawRows.filter(
          (r) =>
            String(r.template_code).toLowerCase().includes(search) ||
            String(r.template_name).toLowerCase().includes(search) ||
            String(r.target_label).toLowerCase().includes(search),
        );
      }

      const pushed = new Set(["team_id", "search"]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const paged = paginateInMemoryRows(filteredRows, spec);

      let obligationTotalSum = 0;
      let submittedCountSum = 0;
      let overdueCountSum = 0;
      for (const r of filteredRows) {
        obligationTotalSum += Number(r.obligation_total ?? 0);
        submittedCountSum += Number(r.submitted_count ?? 0);
        overdueCountSum += Number(r.overdue_count ?? 0);
      }

      return {
        ok: true,
        data: {
          as_of_date: businessDate,
          date_range: spec.date_range ?? { from: null, to: null },
          summary: {
            total_assignments: filteredRows.length,
            obligation_total_sum: obligationTotalSum,
            submitted_count_sum: submittedCountSum,
            overdue_count_sum: overdueCountSum,
          },
          rows: paged.slice,
          has_more: paged.has_more,
          next_cursor: paged.next_cursor,
          total_matching: paged.total_matching,
        },
      };
    },

    async work_reports_submissions(spec, { actor, businessDate }) {
      const cursorToken =
        spec.cursor?.kind === "token" ? (spec.cursor.token ?? null) : null;
      const stateRaw = findEqFilterString(spec.filters, "state")?.toUpperCase();
      const stateFilter: WorkReportReadableState | null =
        stateRaw &&
        (WORK_REPORT_READABLE_STATES as readonly string[]).includes(stateRaw)
          ? (stateRaw as WorkReportReadableState)
          : null;

      const outcome = await workReportReaderRepo.listReadable({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        template_id: findEqFilterString(spec.filters, "template_id"),
        version_id:
          findEqFilterString(spec.filters, "version_id") ??
          findEqFilterString(spec.filters, "template_version_id"),
        from: spec.date_range?.from ?? null,
        to: spec.date_range?.to ?? null,
        team_id: findEqFilterString(spec.filters, "team_id"),
        assignee_id:
          findEqFilterString(spec.filters, "assignee_id") ??
          findEqFilterString(spec.filters, "assignee_app_user_id"),
        state: stateFilter,
        cursor: cursorToken,
        limit: Math.min(100, spec.page_size),
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status:
            outcome.kind === "not-found"
              ? 404
              : outcome.kind === "invalid"
                ? 400
                : 503,
          code: `WORK_REPORT_SUBMISSIONS_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn danh sách bài nộp báo cáo công việc.",
        };
      }

      const rawRows: Record<string, unknown>[] = outcome.data.items.map(
        (item) => ({
          obligation_id: item.obligation_id,
          submission_id: item.submission_id,
          template_id: item.template_id,
          template_name: item.template_name,
          template_version_id: item.template_version_id,
          template_version_no: item.template_version_no,
          assignee_app_user_id: item.assignee_app_user_id,
          assignee_display_name: item.assignee_display_name,
          team_id: item.team_id,
          team_display_name: item.team_display_name,
          period_key: item.period_key,
          period_start_date: item.period_start_date,
          period_end_date: item.period_end_date,
          state: item.state,
          latest_submitted_at: item.latest_submitted_at,
          is_late: item.is_late,
          has_post_deadline_amendment: item.has_post_deadline_amendment,
          current_revision_no: item.current_revision_no,
        }),
      );

      const pushed = new Set([
        "template_id",
        "version_id",
        "template_version_id",
        "team_id",
        "assignee_id",
        "assignee_app_user_id",
        "state",
        "period_start_date",
      ]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const lateCount = filteredRows.filter((r) => r.is_late === true).length;
      const amendedCount = filteredRows.filter(
        (r) => r.has_post_deadline_amendment === true,
      ).length;

      const nextCursor =
        outcome.data.has_more && outcome.data.next_cursor
          ? encodeN8nCursor({
              dataset: spec.dataset,
              kind: "token",
              token: outcome.data.next_cursor,
            })
          : null;

      return {
        ok: true,
        data: {
          as_of_date: spec.date_range?.to ?? businessDate,
          date_range: spec.date_range ?? { from: null, to: null },
          summary: {
            effective_scope: outcome.data.effective_scope,
            returned_submissions: filteredRows.length,
            late_count: lateCount,
            amended_count: amendedCount,
          },
          rows: filteredRows,
          has_more: outcome.data.has_more,
          next_cursor: nextCursor,
          total_matching: null,
        },
      };
    },

    async work_reports_submission_detail(spec, { actor, businessDate }) {
      const targetId =
        findEqFilterString(spec.filters, "obligation_id") ??
        findEqFilterString(spec.filters, "submission_id");
      if (!targetId) {
        return {
          ok: false,
          status: 400,
          code: "MISSING_REQUIRED_FILTER",
          message:
            "Bắt buộc truyền filter obligation_id (eq) hoặc submission_id (eq) để xem chi tiết một bài nộp cụ thể.",
        };
      }

      const outcome = await workReportSubmissionRepo.get({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        obligation_id: targetId,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          status:
            outcome.kind === "not-found"
              ? 404
              : outcome.kind === "denied"
                ? 403
                : outcome.kind === "invalid"
                  ? 400
                  : 503,
          code: `WORK_REPORT_SUBMISSION_DETAIL_${outcome.kind.toUpperCase()}`,
          message: "Không thể truy vấn chi tiết nội dung bài nộp báo cáo công việc.",
        };
      }

      const detail = outcome.data;
      const obligation = isRecord(detail.obligation) ? detail.obligation : {};
      const submission = isRecord(detail.submission) ? detail.submission : null;
      const sortedRevisions = [...(detail.revisions ?? [])].sort(
        (a, b) => b.revision_no - a.revision_no,
      );
      const latestRevision = sortedRevisions[0] ?? null;

      const row: Record<string, unknown> = {
        obligation_id:
          typeof obligation.obligation_id === "string"
            ? obligation.obligation_id
            : targetId,
        submission_id:
          submission && typeof submission.submission_id === "string"
            ? submission.submission_id
            : null,
        template_id:
          typeof obligation.template_id === "string"
            ? obligation.template_id
            : null,
        template_code: detail.template.template_code,
        template_display_name: detail.template.display_name,
        template_schema_json: detail.template.schema_json,
        assignee_app_user_id:
          typeof obligation.assignee_app_user_id === "string"
            ? obligation.assignee_app_user_id
            : null,
        snapshot_team_id:
          typeof obligation.snapshot_team_id === "string"
            ? obligation.snapshot_team_id
            : null,
        snapshot_team_code:
          typeof obligation.snapshot_team_code === "string"
            ? obligation.snapshot_team_code
            : null,
        snapshot_team_display_name:
          typeof obligation.snapshot_team_display_name === "string"
            ? obligation.snapshot_team_display_name
            : null,
        period_key:
          typeof obligation.period_key === "string"
            ? obligation.period_key
            : null,
        period_start_date:
          typeof obligation.period_start_date === "string"
            ? obligation.period_start_date
            : null,
        period_end_date:
          typeof obligation.period_end_date === "string"
            ? obligation.period_end_date
            : null,
        due_at:
          typeof obligation.due_at === "string" ? obligation.due_at : null,
        obligation_status:
          typeof obligation.obligation_status === "string"
            ? obligation.obligation_status
            : null,
        reopened_until:
          typeof obligation.reopened_until === "string"
            ? obligation.reopened_until
            : null,
        is_overdue: Boolean(obligation.is_overdue),
        submission_state:
          submission && typeof submission.state === "string"
            ? submission.state
            : "NOT_STARTED",
        first_submitted_at:
          submission && typeof submission.first_submitted_at === "string"
            ? submission.first_submitted_at
            : null,
        latest_submitted_at:
          submission && typeof submission.latest_submitted_at === "string"
            ? submission.latest_submitted_at
            : null,
        is_late: submission ? Boolean(submission.is_late) : false,
        has_post_deadline_amendment: submission
          ? Boolean(submission.has_post_deadline_amendment)
          : false,
        current_revision_id:
          submission && typeof submission.current_revision_id === "string"
            ? submission.current_revision_id
            : null,
        current_revision_no: latestRevision ? latestRevision.revision_no : null,
        revision_count: sortedRevisions.length,
        latest_payload_json: latestRevision
          ? latestRevision.payload_json
          : null,
        revisions: sortedRevisions.map((rev) => ({
          revision_id: rev.revision_id,
          revision_no: rev.revision_no,
          payload_json: rev.payload_json,
          created_at: rev.created_at,
        })),
        latest_review_event: detail.latest_review_event ?? null,
      };

      return {
        ok: true,
        data: {
          as_of_date:
            (typeof obligation.period_end_date === "string"
              ? obligation.period_end_date
              : null) ?? businessDate,
          date_range: {
            from:
              typeof obligation.period_start_date === "string"
                ? obligation.period_start_date
                : null,
            to:
              typeof obligation.period_end_date === "string"
                ? obligation.period_end_date
                : null,
          },
          summary: {
            revision_count: sortedRevisions.length,
          },
          rows: [row],
          has_more: false,
          next_cursor: null,
          total_matching: 1,
          notes: [
            "Để đọc nội dung câu trả lời đã nộp (latest_payload_json, revisions, latest_review_event), hãy liệt kê tường minh các trường này trong QuerySpec.fields. Bản nháp chưa nộp (draft_payload_json) không bao giờ được công bố.",
          ],
        },
      };
    },

    async work_reports_analytics(spec, { actor, businessDate }) {
      const templateId = findEqFilterString(spec.filters, "template_id");
      if (!templateId) {
        return {
          ok: false,
          status: 400,
          code: "MISSING_REQUIRED_FILTER",
          message: "Bắt buộc truyền filter template_id.",
        };
      }

      const groupByRaw =
        findEqFilterString(spec.filters, "group_by")?.toLowerCase() ?? "team";
      const groupBy: WorkReportAnalyticsGroupBy =
        groupByRaw === "team" ||
        groupByRaw === "assignee" ||
        groupByRaw === "period"
          ? groupByRaw
          : "team";

      const finalityRaw =
        findEqFilterString(spec.filters, "finality")?.toLowerCase() ?? "final";
      const finality: WorkReportAnalyticsFinality =
        finalityRaw === "provisional_included"
          ? "provisional_included"
          : "final";

      const page =
        spec.cursor?.kind === "page" && spec.cursor.page ? spec.cursor.page : 1;
      const pageSize = Math.min(100, spec.page_size);

      const commonInput = {
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        template_id: templateId,
        version_id: findEqFilterString(spec.filters, "version_id"),
        from: spec.date_range?.from ?? null,
        to: spec.date_range?.to ?? null,
        team_id: findEqFilterString(spec.filters, "team_id"),
        assignee_id: findEqFilterString(spec.filters, "assignee_id"),
        finality,
      };

      const [overviewRes, breakdownRes] = await Promise.all([
        workReportAnalyticsRepo.overview(commonInput),
        workReportAnalyticsRepo.breakdown({
          ...commonInput,
          group_by: groupBy,
          page,
          page_size: pageSize,
        }),
      ]);

      if (!overviewRes.ok) {
        return {
          ok: false,
          status:
            overviewRes.kind === "not-found"
              ? 404
              : overviewRes.kind === "invalid"
                ? 400
                : 503,
          code: `WORK_REPORT_ANALYTICS_OVERVIEW_${overviewRes.kind.toUpperCase()}`,
          message: "Không thể truy vấn tổng quan phân tích báo cáo công việc.",
        };
      }

      if (!breakdownRes.ok) {
        return {
          ok: false,
          status:
            breakdownRes.kind === "not-found"
              ? 404
              : breakdownRes.kind === "invalid"
                ? 400
                : 503,
          code: `WORK_REPORT_ANALYTICS_BREAKDOWN_${breakdownRes.kind.toUpperCase()}`,
          message: "Không thể truy vấn bảng phân rã báo cáo công việc.",
        };
      }

      const rawRows: Record<string, unknown>[] = breakdownRes.data.items.map(
        (item) => ({
          group_by: breakdownRes.data.group_by,
          group_id: item.group_id,
          group_label: item.group_label,
          due_count: item.due_count,
          completed_count: item.completed_count,
          on_time_count: item.on_time_count,
          late_submitted_count: item.late_submitted_count,
          pending_due_count: item.pending_due_count,
          overdue_missing_count: item.overdue_missing_count,
          exempted_count: item.exempted_count,
          pending_review_count: item.pending_review_count,
          completion_rate: item.completion_rate,
          metrics: item.metrics,
        }),
      );

      const pushed = new Set([
        "template_id",
        "version_id",
        "team_id",
        "assignee_id",
        "group_by",
        "finality",
      ]);
      const filteredRows = applyResidualFiltersAndSort(rawRows, spec, pushed);
      const hasMore = page * pageSize < breakdownRes.data.total_groups;
      const nextCursor = hasMore
        ? encodeN8nCursor({
            dataset: spec.dataset,
            kind: "page",
            page: page + 1,
          })
        : null;

      return {
        ok: true,
        data: {
          as_of_date: overviewRes.data.as_of.slice(0, 10) || businessDate,
          date_range: spec.date_range ?? { from: null, to: null },
          summary: {
            as_of: overviewRes.data.as_of,
            effective_scope: overviewRes.data.effective_scope,
            template_id: templateId,
            finality,
            group_by: groupBy,
            total_groups: breakdownRes.data.total_groups,
            ...overviewRes.data.compliance,
            metrics: overviewRes.data.metrics,
            ratios: overviewRes.data.ratios ?? [],
          },
          rows: filteredRows,
          has_more: hasMore,
          next_cursor: nextCursor,
          total_matching: breakdownRes.data.total_groups,
        },
      };
    },
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortController.abort(new DOMException("Query timed out", "TimeoutError"));
      resolve({ timedOut: true });
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (abortController.signal.aborted) {
          resolve({ timedOut: true });
          return;
        }
        resolve({ timedOut: false, value });
      },
      (err) => {
        clearTimeout(timer);
        if (abortController.signal.aborted) {
          resolve({ timedOut: true });
          return;
        }
        reject(err);
      },
    );
  });
}

export async function dispatchN8nBodQuery(
  rawBody: unknown,
  deps: N8nDispatcherDependencies = {},
): Promise<{
  status: number;
  body: N8nQuerySuccessEnvelope | N8nQueryErrorEnvelope;
}> {
  const validation = parseAndValidateN8nQuerySpec(rawBody);
  if (!validation.ok) {
    return {
      status: validation.status,
      body: {
        ok: false,
        catalog_version: N8N_BOD_CATALOG_VERSION,
        principal: N8N_BOD_READONLY_PRINCIPAL,
        error: {
          code: validation.code,
          message: validation.message,
          details: validation.details,
        },
      },
    };
  }

  const spec = validation.spec;
  const now = deps.now ? deps.now() : new Date();
  const businessDate = currentHoChiMinhBusinessDate(now);

  const adapters = {
    ...createDefaultAdapters(deps),
    ...(deps.customAdapters ?? {}),
  };

  const adapter = adapters[spec.dataset];
  if (!adapter) {
    return {
      status: 422,
      body: {
        ok: false,
        catalog_version: N8N_BOD_CATALOG_VERSION,
        principal: N8N_BOD_READONLY_PRINCIPAL,
        error: {
          code: "ADAPTER_NOT_AVAILABLE",
          message: `Adapter cho dataset '${spec.dataset}' chưa khả dụng.`,
        },
      },
    };
  }

  // When resuming a previously truncated page/token batch (sub_offset > 0),
  // preserve the backend batch_page_size so batch boundaries remain identical.
  const batchPageSize = spec.cursor?.batch_page_size ?? spec.page_size;
  const effectiveSpec: ValidatedN8nQuerySpec =
    batchPageSize !== spec.page_size
      ? { ...spec, page_size: batchPageSize }
      : spec;

  const timeoutMs = deps.timeoutMs ?? DEFAULT_N8N_QUERY_TIMEOUT_MS;
  const abortController = new AbortController();
  const actorResolver =
    deps.resolveActor ?? (() => resolveN8nBodServiceActor());

  type TimedPipelineResult =
    | {
        stage: "actor_failed";
        code: string;
        message: string;
      }
    | {
        stage: "executed";
        outcome: Awaited<ReturnType<N8nDatasetAdapter>>;
      };

  let pipelineResult: TimedPipelineResult;
  try {
    const timed = await withTimeout(
      Promise.resolve(
        runWithSupabaseAbortSignal(abortController.signal, async () => {
          const actorResolution = await actorResolver();
          if (!actorResolution.ok) {
            return {
              stage: "actor_failed" as const,
              code: actorResolution.code,
              message: actorResolution.message,
            };
          }
          const outcome = await adapter(effectiveSpec, {
            actor: actorResolution.actor,
            businessDate,
            signal: abortController.signal,
          });
          return {
            stage: "executed" as const,
            outcome,
          };
        }),
      ),
      timeoutMs,
      abortController,
    );

    if (timed.timedOut) {
      return {
        status: 504,
        body: {
          ok: false,
          catalog_version: N8N_BOD_CATALOG_VERSION,
          principal: N8N_BOD_READONLY_PRINCIPAL,
          error: {
            code: "QUERY_TIMEOUT",
            message: `Truy vấn vượt quá giới hạn thời gian (${timeoutMs}ms) và đã bị hủy ở tầng gọi dữ liệu. Hãy thu hẹp khoảng ngày hoặc giảm page_size.`,
          },
        },
      };
    }
    pipelineResult = timed.value;
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        catalog_version: N8N_BOD_CATALOG_VERSION,
        principal: N8N_BOD_READONLY_PRINCIPAL,
        error: {
          code: "QUERY_EXECUTION_FAILED",
          message: "Lỗi nội bộ khi thực thi truy vấn trên nguồn dữ liệu chuẩn.",
        },
      },
    };
  }

  if (pipelineResult.stage === "actor_failed") {
    return {
      status: 503,
      body: {
        ok: false,
        catalog_version: N8N_BOD_CATALOG_VERSION,
        principal: N8N_BOD_READONLY_PRINCIPAL,
        error: {
          code: pipelineResult.code,
          message: pipelineResult.message,
        },
      },
    };
  }

  const executionOutcome = pipelineResult.outcome;
  if (!executionOutcome.ok) {
    return {
      status: executionOutcome.status,
      body: {
        ok: false,
        catalog_version: N8N_BOD_CATALOG_VERSION,
        principal: N8N_BOD_READONLY_PRINCIPAL,
        error: {
          code: executionOutcome.code,
          message: executionOutcome.message,
          details: executionOutcome.details,
        },
      },
    };
  }

  const data = executionOutcome.data;
  const decodedAdapterNextCursor = data.next_cursor
    ? decodeN8nCursor(data.next_cursor, spec.dataset)
    : null;

  const effectiveCursorKind: "offset" | "page" | "token" =
    spec.cursor?.kind ??
    decodedAdapterNextCursor?.kind ??
    (spec.datasetSpec.pagination.strategy === "page_cursor"
      ? "page"
      : spec.datasetSpec.pagination.strategy === "keyset_cursor"
        ? "token"
        : "offset");

  const baseOffset =
    spec.cursor?.kind === "offset" && typeof spec.cursor.offset === "number"
      ? spec.cursor.offset
      : 0;
  const currentPage =
    spec.cursor?.kind === "page" && typeof spec.cursor.page === "number"
      ? spec.cursor.page
      : 1;
  const currentToken =
    spec.cursor?.kind === "token" ? (spec.cursor.token ?? null) : null;
  const currentSubOffset =
    effectiveCursorKind === "offset" ? 0 : (spec.cursor?.sub_offset ?? 0);

  const remainingBatchRows =
    currentSubOffset > 0 ? data.rows.slice(currentSubOffset) : data.rows;
  const candidateRows = remainingBatchRows.slice(0, spec.page_size);
  const fullProjectedRows = projectAndRedactRows(candidateRows, spec);
  const baseWarnings = [...(data.warnings ?? [])];
  const filteredSummary = filterSummaryMeasures(data.summary, spec);

  const computePaginationForKeepCount = (
    keepCount: number,
  ): { hasMore: boolean; nextCursor: string | null } => {
    const cutBeforeEndOfBatch = keepCount < remainingBatchRows.length;
    if (!cutBeforeEndOfBatch) {
      return {
        hasMore: data.has_more,
        nextCursor: data.next_cursor,
      };
    }
    if (effectiveCursorKind === "page") {
      return {
        hasMore: true,
        nextCursor: encodeN8nCursor({
          dataset: spec.dataset,
          kind: "page",
          page: currentPage,
          sub_offset: currentSubOffset + keepCount,
          batch_page_size: batchPageSize,
        }),
      };
    }
    if (effectiveCursorKind === "token") {
      return {
        hasMore: true,
        nextCursor: encodeN8nCursor({
          dataset: spec.dataset,
          kind: "token",
          token: currentToken,
          sub_offset: currentSubOffset + keepCount,
          batch_page_size: batchPageSize,
        }),
      };
    }
    return {
      hasMore: true,
      nextCursor: encodeN8nCursor({
        dataset: spec.dataset,
        kind: "offset",
        offset: baseOffset + keepCount,
      }),
    };
  };

  const buildEnvelope = (
    rowsSlice: readonly Record<string, unknown>[],
    hasMoreVal: boolean,
    nextCursorVal: string | null,
    warningsList: readonly string[],
  ): N8nQuerySuccessEnvelope => {
    const completenessStatus: N8nCompletenessStatus = data.degraded
      ? "DEGRADED"
      : rowsSlice.length === 0 && spec.mode !== "aggregate"
        ? "EMPTY"
        : hasMoreVal
          ? "PARTIAL"
          : "COMPLETE";

    return {
      ok: true,
      catalog_version: N8N_BOD_CATALOG_VERSION,
      principal: N8N_BOD_READONLY_PRINCIPAL,
      dataset: spec.dataset,
      domain: spec.datasetSpec.domain,
      mode: spec.mode,
      source: {
        canonical_name: spec.datasetSpec.canonical_source.name,
        kind: spec.datasetSpec.canonical_source.kind,
        cutoff_date: spec.datasetSpec.time_semantics.cutoff_date,
        subledger_grain:
          spec.datasetSpec.canonical_source.subledger_grain ?? null,
      },
      generated_at: now.toISOString(),
      business_timezone: N8N_BOD_BUSINESS_TIMEZONE,
      as_of_date: data.as_of_date,
      date_range: data.date_range,
      completeness: {
        status: completenessStatus,
        is_complete: !hasMoreVal && !data.degraded,
        missing_or_warnings: warningsList,
        notes: data.notes ?? [],
      },
      summary: filteredSummary,
      row_count: rowsSlice.length,
      rows: rowsSlice,
      pagination: {
        page_size: spec.page_size,
        has_more: hasMoreVal,
        next_cursor: nextCursorVal,
        total_matching: data.total_matching,
      },
      sensitivity: {
        requested_sensitive_fields: spec.requestedSensitiveFields,
        redacted_sensitive_fields: spec.redactedSensitiveFields,
        media_policy: "METADATA_ONLY_NO_BULK_MEDIA",
      },
    };
  };

  const initialPagination = computePaginationForKeepCount(
    fullProjectedRows.length,
  );
  let finalEnvelope = buildEnvelope(
    fullProjectedRows,
    initialPagination.hasMore,
    initialPagination.nextCursor,
    baseWarnings,
  );

  const serializedBytes = Buffer.byteLength(
    JSON.stringify(finalEnvelope),
    "utf8",
  );

  // Enforce strict 1 MiB (MAX_N8N_RESPONSE_BYTES) limit on the ENTIRE JSON envelope.
  if (serializedBytes > MAX_N8N_RESPONSE_BYTES) {
    const truncationWarning =
      "Kết quả đã được cắt theo giới hạn kích thước phản hồi (1 MiB); hãy dùng next_cursor để lấy tiếp ngay sau dòng cuối cùng đã trả.";
    const truncatedWarnings = [...baseWarnings, truncationWarning];

    let bestEnvelope: N8nQuerySuccessEnvelope | null = null;
    if (fullProjectedRows.length > 1) {
      let low = 1;
      let high = fullProjectedRows.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const pag = computePaginationForKeepCount(mid);
        const candidateEnv = buildEnvelope(
          fullProjectedRows.slice(0, mid),
          pag.hasMore,
          pag.nextCursor,
          truncatedWarnings,
        );
        const bytes = Buffer.byteLength(JSON.stringify(candidateEnv), "utf8");
        if (bytes <= MAX_N8N_RESPONSE_BYTES) {
          bestEnvelope = candidateEnv;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
    }

    if (bestEnvelope) {
      finalEnvelope = bestEnvelope;
    } else {
      // Even a single row (or summary alone) exceeds 1 MiB — fail closed with a compact 413 error envelope.
      return {
        status: 413,
        body: {
          ok: false,
          catalog_version: N8N_BOD_CATALOG_VERSION,
          principal: N8N_BOD_READONLY_PRINCIPAL,
          error: {
            code: "RESPONSE_TOO_LARGE",
            message: `Phản hồi JSON vượt quá giới hạn ${MAX_N8N_RESPONSE_BYTES} bytes (1 MiB) ngay cả khi giảm về tối thiểu 1 dòng. Hãy chỉ định danh sách fields/measures gọn hơn hoặc dùng mode phù hợp.`,
            details: {
              dataset: spec.dataset,
              max_response_bytes: MAX_N8N_RESPONSE_BYTES,
            },
          },
        },
      };
    }
  }

  return {
    status: 200,
    body: finalEnvelope,
  };
}
